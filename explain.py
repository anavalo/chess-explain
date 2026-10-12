# /// script
# requires-python = ">=3.10"
# dependencies = ["chess", "anthropic"]
# ///
"""Explain why one chess move is better than another.

Latest Stockfish decides WHICH move is better (eval + main line).
Stockfish 15.1's hand-crafted eval explains WHY (term-by-term diff at the end of each line).
An LLM turns those numbers into plain language.

usage: uv run explain.py FEN MOVE [--vs MOVE] [--nodes N] [--no-llm]
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import chess
import chess.engine

BIN = Path(__file__).parent / "bin"
LATEST, SF15 = str(BIN / "sf-latest"), str(BIN / "sf15")
THREADS = 4

# SF 15.1 game phase (src/material.cpp): non-pawn material between these limits maps to 0..128
MIDGAME_LIMIT, ENDGAME_LIMIT = 15258, 3915
NPM = {chess.KNIGHT: 781, chess.BISHOP: 825, chess.ROOK: 1276, chess.QUEEN: 2538}


def open_engine():
    """Latest Stockfish. Node limits keep the analysis size fixed; threads only make it finish sooner."""
    engine = chess.engine.SimpleEngine.popen_uci(LATEST)
    engine.configure({"Threads": THREADS, "Hash": 256})
    return engine


def parse_move(board, text):
    try:
        return board.parse_san(text)
    except ValueError:
        return board.parse_uci(text)


def score_str(score):
    if score.is_mate():
        return f"mates in {score.mate()}" if score.mate() > 0 else f"gets mated in {-score.mate()}"
    return f"{score.score() / 100:+.2f}"


def line_to_leaf(board, pv, max_plies=12):
    """Play the engine line and stop at the last quiet position (no check, last move not a capture),
    so the static eval is not taken in the middle of an exchange."""
    b, sans, quiet, calm = board.copy(), [], None, None
    for mv in pv[:max_plies]:
        noisy = b.is_capture(mv) or mv.promotion
        sans.append(b.san(mv))
        b.push(mv)
        if not b.is_check():
            calm = (b.copy(), list(sans))  # fallback when the whole line is noisy
            if not noisy:
                quiet = calm
    leaf, leaf_sans = quiet or calm or (None, [])
    return leaf, sans, leaf_sans


def phase(board):
    npm = sum(NPM.get(p.piece_type, 0) for p in board.piece_map().values())
    npm = max(ENDGAME_LIMIT, min(npm, MIDGAME_LIMIT))
    return (npm - ENDGAME_LIMIT) * 128 // (MIDGAME_LIMIT - ENDGAME_LIMIT)


def sf15_terms(board, pov):
    """Run SF 15.1 `eval` and return {term: value in pawns} from `pov`'s side, MG/EG blended by phase."""
    out = subprocess.run([SF15], input=f"position fen {board.fen()}\neval\nquit\n",
                         capture_output=True, text=True, timeout=30).stdout
    ph, sign, terms = phase(board), 1 if pov == chess.WHITE else -1, {}
    for m in re.finditer(r"^\|\s*([A-Za-z ]+?)\s*\|.*\|\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*\|$", out, re.M):
        mg, eg = float(m.group(2)), float(m.group(3))
        terms[m.group(1)] = round(sign * (mg * ph + eg * (128 - ph)) / 128, 2)
    return terms


def material(board, pov):
    """Material balance in pawns (1/3/3/5/9) from `pov`'s side."""
    return sum(VALUE[p.piece_type] * (1 if p.color == pov else -1) for p in board.piece_map().values()
               if p.piece_type != chess.KING)


VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}


def threats(board, sq, attacked_before, owner):
    """Enemy pieces newly attacked by the piece that just moved to `sq`, if worth more than it
    or attacked more times than defended. `owner` ("your"/"opp's") names whose pieces they are.
    ponytail: direct attacks only; discovered attacks and pins are not labelled."""
    mover = board.piece_at(sq)
    out = []
    for t in board.attacks(sq) & board.occupied_co[not mover.color]:
        victim = board.piece_at(t)
        if victim.piece_type == chess.KING or t in attacked_before:
            continue
        attackers, defenders = len(board.attackers(mover.color, t)), len(board.attackers(not mover.color, t))
        if VALUE[victim.piece_type] > VALUE[mover.piece_type] or attackers > defenders:
            note = f", attacked {attackers}x defended {defenders}x" if attackers > 1 else ""
            out.append(f"attacks {owner} {chess.piece_name(victim.piece_type)} on {chess.square_name(t)}{note}")
    return out


def line_with_evals(engine, board, pv, nodes, max_plies=20):
    """'you Bc3 (-7.52) opp Bb4 (-7.50) you Bd2 (-7.68) opp Qxa1 [takes rook, material -5] (-7.38) ...':
    latest Stockfish eval after every move, from the original mover's ("you") view."""
    b, out, seen_trapped = board.copy(), [], set()
    for mv in pv[:max_plies]:
        who = "you" if b.turn == board.turn else "opp"
        san, labels, captured = f"{who} {b.san(mv)}", [], b.is_capture(mv)
        if captured:
            taken = chess.PAWN if b.is_en_passant(mv) else b.piece_type_at(mv.to_square)
            labels.append(f"takes {chess.piece_name(taken)}")
        before = b.attacks(mv.from_square)
        b.push(mv)
        if b.is_check():
            labels.append("check")
        labels += threats(b, mv.to_square, before, "opp's" if who == "you" else "your")
        if captured:
            labels.append(f"material {material(b, board.turn):+d}")
        for sq in set(trapped(b)) - seen_trapped:
            owner = "your" if b.turn == board.turn else "opp's"
            labels.append(f"{owner} {chess.piece_name(b.piece_type_at(sq))} on {chess.square_name(sq)} is trapped")
            seen_trapped.add(sq)
        if b.is_checkmate():
            ev = "checkmate"
        elif b.is_game_over():
            ev = "draw"
        else:
            score = engine.analyse(b, chess.engine.Limit(nodes=nodes))["score"]
            ev = score_str(score.pov(board.turn))
            # what the mover would play next if the other side passed: catches batteries, discovered attacks, mate threats
            _, threat = opponent_threat(engine, b, nodes, score.pov(b.turn))
            if threat and ("x" in threat["move"] or "+" in threat["move"] or "#" in threat["move"]):
                labels.append(f"threatens {threat['move']}")  # quiet threats are mostly noise mid-line
        if labels:
            san += f" [{', '.join(labels)}]"
        out.append(f"{san} ({ev})")
    if out and captured:
        out.append("[line ends mid-exchange: a recapture may follow, so the last material count is not final]")
    return " ".join(out)


def in_danger(board, sq):
    """The piece on `sq` is attacked by a cheaper piece, or attacked more times than defended."""
    p, attackers = board.piece_at(sq), board.attackers(not board.color_at(sq), sq)
    return bool(attackers) and (min(VALUE[board.piece_type_at(a)] for a in attackers) < VALUE[p.piece_type]
                                or len(attackers) > len(board.attackers(p.color, sq)))


def loose_pieces(board, owner):
    """`owner`'s pieces that are in danger, with their cheapest attacker."""
    out = []
    for sq, p in board.piece_map().items():
        if p.color != owner or p.piece_type == chess.KING or not in_danger(board, sq):
            continue
        cheapest = min(board.attackers(not owner, sq), key=lambda a: VALUE[board.piece_type_at(a)])
        out.append(f"{chess.piece_name(p.piece_type)} on {chess.square_name(sq)} attacked by "
                   f"{chess.piece_name(board.piece_type_at(cheapest))} on {chess.square_name(cheapest)}")
    return out


def trapped(board):
    """Side-to-move pieces that are in danger and have no safe square to go to.
    ponytail: only counts escapes; blocking or adding a defender is not considered."""
    out = []
    for sq in chess.SquareSet(board.occupied_co[board.turn] & ~board.pawns & ~board.kings):
        if not in_danger(board, sq):
            continue
        value = VALUE[board.piece_type_at(sq)]
        for mv in board.generate_legal_moves(chess.BB_SQUARES[sq]):
            if board.is_capture(mv) and VALUE.get(board.piece_type_at(mv.to_square), 1) >= value:
                break  # can trade itself off
            board.push(mv)
            safe = not in_danger(board, mv.to_square)
            board.pop()
            if safe:
                break
        else:
            out.append(sq)
    return out


def position_before(board):
    """What is already on the board before you move: check, your loose pieces, enemy pieces you can win."""
    me = board.turn
    checkers = [f"{chess.piece_name(board.piece_type_at(s))} on {chess.square_name(s)}" for s in board.checkers()]
    return {
        "you_are_in_check_from": checkers or None,
        "your_pieces_in_danger": loose_pieces(board, me) or None,
        "opponent_pieces_you_can_win": loose_pieces(board, not me) or None,
    }


def opponent_threat(engine, board, nodes, score_now):
    """The opponent's best move if you could pass (null move), when it would gain at least a pawn."""
    passed = board.copy(stack=False)
    passed.turn, passed.ep_square = not board.turn, None
    if board.is_check() or not passed.is_valid():
        return None, None
    info = engine.analyse(passed, chess.engine.Limit(nodes=nodes))
    if score_now.score(mate_score=10000) - info["score"].pov(board.turn).score(mate_score=10000) < 100:
        return None, None
    threat = info["pv"][0]
    return threat, {"move": passed.san(threat), "eval_if_you_could_pass_and_opp_played_it": score_str(info["score"].pov(board.turn))}


def answer_to_threat(engine, board, move, threat, nodes):
    """Your move, then the opponent plays the threat at once, then the engine's best play: does your move stop it?"""
    b = board.copy()
    b.push(move)
    if threat not in b.legal_moves:
        return "the threat move is no longer legal after your move"
    b.push(threat)
    pv = [move, threat] + engine.analyse(b, chess.engine.Limit(nodes=nodes))["pv"]
    return line_with_evals(engine, board, pv, nodes, max_plies=6)


def analyse(engine, board, nodes, move=None):
    info = engine.analyse(board, chess.engine.Limit(nodes=nodes), root_moves=[move] if move else None)
    return info["score"].pov(board.turn), info["pv"]


def build_facts(fen, played_text, vs_text, nodes, engine=None):
    """`engine`: a running latest-Stockfish to reuse (the server keeps one alive); a fresh one is started if None."""
    if engine is None:
        with open_engine() as engine:
            return build_facts(fen, played_text, vs_text, nodes, engine)
    board = chess.Board(fen)
    played = parse_move(board, played_text)
    score_before = analyse(engine, board, nodes)[0]
    eval_before = score_str(score_before)
    threat, threat_facts = opponent_threat(engine, board, nodes, score_before)
    if vs_text:
        other = parse_move(board, vs_text)
    else:
        infos = engine.analyse(board, chess.engine.Limit(nodes=nodes), multipv=2)
        other = infos[0]["pv"][0] if infos[0]["pv"][0] != played else infos[1]["pv"][0]
    lines = {}
    for label, mv in (("played", played), ("alternative", other)):
        score, pv = analyse(engine, board, nodes, mv)
        leaf, _, leaf_sans = line_to_leaf(board, pv)
        terms = sf15_terms(leaf, board.turn) if leaf else {}
        lines[label] = {"move": board.san(mv), "latest_sf_eval": score_str(score), "cp": score.score(mate_score=10000),
                        "line_with_evals": line_with_evals(engine, board, pv, max(nodes // 10, 100_000)),
                        "explained_at_position_after": " ".join(leaf_sans),
                        "explained_fen": leaf.fen() if leaf else None, "sf15_terms": terms}
        if threat:
            lines[label]["if_opp_plays_the_threat_at_once"] = answer_to_threat(
                engine, board, mv, threat, max(nodes // 10, 100_000))
    a, p = lines["alternative"]["sf15_terms"], lines["played"]["sf15_terms"]
    diff = {k: round(a[k] - p[k], 2) for k in a if k in p and k != "Total"}
    return {
        "fen": fen,
        "side_to_move": "White" if board.turn else "Black",
        "eval_before_any_move": eval_before,
        "position_before_move": position_before(board),
        "opponent_threat": threat_facts,
        "material_before_any_move": material(board, board.turn),
        "values_are_from": "side to move's point of view, in pawns",
        "played": lines["played"],
        "alternative": lines["alternative"],
        "latest_sf_gap": round((lines["alternative"]["cp"] - lines["played"]["cp"]) / 100, 2),
        "sf15_term_diff_alternative_minus_played": dict(sorted(diff.items(), key=lambda kv: -abs(kv[1]))),
        "sf15_total_gap": round(a.get("Total", 0) - p.get("Total", 0), 2) if a and p else None,
    }


SYSTEM = """You are a chess coach for club players (around 1200-1800 rating).
You get facts from two engines about one position and two candidate moves:
- "latest_sf_eval" and "line_with_evals" come from the latest Stockfish. They are the truth about which move is better.
  The player who asks is the side to move: call them "you". In "line_with_evals" every move is tagged "you" or "opp"
  (opponent) and followed by the eval after it, from your view (in pawns, or mate). Always say who plays a move.
  Captures are labelled "[takes <piece>, material <balance>]"; the balance is in pawns from your view.
  Compare with "eval_before_any_move". If the eval collapses on the played move itself, the opponent's reply in that line
  is the refutation: explain what the reply threatens. Name lost pieces only from the capture labels.
  Labels "check", "attacks your|opp's <piece> on <square>" and "threatens <move>" (what that side would play next if allowed) mark threats. "<piece> is trapped" means that piece is attacked and every
  square it can go to is unsafe: if a trapped piece is later captured, explain the trap (which moves attacked it and took
  away its squares), not just the capture. Describe threats, attacks and defences only from
  these labels; do not work out board geometry yourself.
- "position_before_move" lists what was already on the board: a check you had to answer, your pieces in danger,
  and opponent pieces you could win. A blunder often ignores one of these: say so first when it applies.
  If "you_are_in_check_from" is set, your first sentence must say you were in check and from which piece,
  and that every legal move had to answer that check. If it is null, do not mention check at all.
- "opponent_threat" (when not null) is what the opponent would play if you could pass a move, and the eval it would reach.
  For each move, "if_opp_plays_the_threat_at_once" plays your move, then the threat, then best play. If the eval stays good
  there, your move stops the threat: explain how, from the labels (for example the reply that punishes the threat). If the eval
  collapses, your move ignored the threat. When the threat decides the gap, lead with it: "the opponent threatened X; the
  better move answers it with Y; your move did not."
- "sf15_terms" are Stockfish 15.1's hand-crafted evaluation terms, measured at the quiet position reached at the end of each line ("explained_at_position_after"). Their difference says WHY one move is better.

Term meanings: Material = piece count. Imbalance = piece combinations (bishop pair, knights love pawns, two rooks overlap).
Pawns = pawn structure (isolated, doubled, backward, connected). Knights/Bishops = outposts, bad bishop (own pawns on its colour, blocked centre), long diagonal, distance to king.
Rooks = open/semi-open files, trapped rook. Mobility = how many useful squares the pieces have. King safety = attackers near the king, pawn shield.
Threats = attacked or hanging pieces. Passed = passed pawns. Space = safe squares behind your pawns. Winnable = how drawish the endgame is.

Rules:
1. Explain why the alternative is better than the played move (or why the played move is fine, if the gap is small).
2. If the line wins or loses material or mates, lead with the concrete tactic, using only moves from the given lines.
3. Only if the SF 15.1 total gap is at least half the latest Stockfish gap, name the 2-3 biggest term differences in plain chess language, with their size in pawns.
4. Otherwise do not list terms: the reason is in the line (a tactic, a trap, or a plan the classical rules cannot see). Point to the moves in the line that decide it. Never invent a reason.
5. Never mention moves, squares or pieces that are not supported by the facts. Under 120 words. No headings.
   Stop once the decisive point is made: do not narrate the rest of a line, and do not judge trades you were not told about.
6. The board the player sees is the position before any move. When you describe something that happens later in a line,
   name the moves that lead there first ("after Rfe8 Nbd2 Ne7 g3 c5 a5 Bg4, Ne5 attacks your bishop on g4"), so a piece
   that moves during the line is never described as if it already stood there. Prefer the first few moves of a line:
   later moves are less reliable.
7. The "[line ends mid-exchange ...]" note is for you only: do not quote it, just do not count the last capture as final."""


def explain(facts, effort="medium", api_key=None):
    """`api_key`: the key to use; None falls back to ANTHROPIC_API_KEY (and the SDK's other credential sources)."""
    import anthropic

    # user-level keys (sk-ant-usr-...) are not tied to a workspace and need it named per request
    workspace = os.environ.get("ANTHROPIC_WORKSPACE_ID")
    client = anthropic.Anthropic(api_key=api_key, default_headers={"anthropic-workspace-id": workspace} if workspace else None)
    response = client.messages.create(
        model="claude-haiku-5-5",
        max_tokens=16000,
        output_config={"effort": effort},
        system=SYSTEM,
        messages=[{"role": "user", "content": json.dumps(facts, indent=1)}],
    )
    if response.stop_reason == "refusal":
        return "(the model declined to answer)"
    return "".join(b.text for b in response.content if b.type == "text")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("fen")
    ap.add_argument("move", help="the move you played / want explained (SAN or UCI)")
    ap.add_argument("--vs", help="compare against this move instead of Stockfish's best")
    ap.add_argument("--nodes", type=int, default=2_000_000)
    ap.add_argument("--effort", default="medium", choices=["low", "medium", "high"])
    ap.add_argument("--no-llm", action="store_true", help="print the engine facts only")
    args = ap.parse_args()
    facts = build_facts(args.fen, args.move, args.vs, args.nodes)
    print(json.dumps(facts, indent=1))
    if not args.no_llm:
        print("\n" + explain(facts, args.effort))
