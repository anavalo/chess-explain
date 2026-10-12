// Explain why one chess move is better than another.
//
// Stockfish 19 decides WHICH move is better (eval + main line).
// Stockfish 15's hand-crafted eval explains WHY (term-by-term diff at the end of each line).
// An LLM turns those numbers into plain language.
//
// Runs in the side panel (engines in Web Workers) and in node (engines as child processes):
//   node extension/explain.js FEN MOVE [--vs MOVE] [--nodes N] [--effort low|medium|high] [--no-llm]

import {
  Chess, attacks, castlingSide, kingCastlesTo, makeFen, makeSan, makeSquare, makeUci, opposite, parseFen, parseSan,
  parseUci,
} from './vendor/chessops.js';

export const NODES = 2_000_000;
export const THREADS = 4;
export const EQUAL_GAP = 0.3; // pawns; below this both moves are called equal and the LLM is skipped

// SF 15 game phase (src/material.cpp): non-pawn material between these limits maps to 0..128
const MIDGAME_LIMIT = 15258, ENDGAME_LIMIT = 3915;
const NPM = { knight: 781, bishop: 825, rook: 1276, queen: 2538 };
// The bundled build is SF 15; 15.1 changed the pawn normalisation, so 15's terms are 361/208 times larger.
const SF15_SCALE = 361 / 208;
const VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100 };

export class Refused extends Error {}

// ---- engines ----

/** Talks UCI to one Stockfish. `send(line)` writes a command; feed every output line to the returned `onLine`.
    Commands run one at a time, in call order. */
export function uciEngine(send) {
  let waiting = null, queue = Promise.resolve();
  const until = (cmds, done) => (queue = queue.then(() => new Promise(resolve => {
    const lines = [];
    waiting = l => {
      lines.push(l);
      if (done(l)) { waiting = null; resolve(lines); }
    };
    cmds.forEach(send);
  })));
  return { onLine: l => waiting?.(l), until };
}

/** Starts both engines with `start(path)` (path relative to this file), which returns a uciEngine.
    The WASM builds drop input that arrives before they have loaded, so nothing else is sent until uciok. */
export async function startEngines(start, threads = THREADS) {
  const setup = async (e, options) => {
    await e.until(['uci'], l => l === 'uciok');
    await e.until([...options.map(([k, v]) => `setoption name ${k} value ${v}`), 'isready'], l => l === 'readyok');
    return e;
  };
  return {
    sf: await setup(start('vendor/stockfish/stockfish-19-lite.js'), [['Threads', threads], ['Hash', 256]]),
    sf15: await setup(start('vendor/stockfish/sf15/stockfish.js'), [['Use NNUE', false]]),
  };
}

/** Searches `pos` for `nodes`; returns [{score, pv}] per MultiPV line. `score` is {cp} or {mate}, from the
    side to move; `pv` is a list of UCI moves. */
async function search(sf, pos, nodes, { moves, multipv = 1 } = {}) {
  const lines = await sf.until([
    `setoption name MultiPV value ${multipv}`,
    `position fen ${fenOf(pos)}`,
    `go nodes ${nodes}${moves ? ' searchmoves ' + moves.join(' ') : ''}`,
  ], l => l.startsWith('bestmove'));
  const infos = [];
  for (const l of lines) {
    const m = l.match(/^info .* score (cp|mate) (-?\d+)( lowerbound| upperbound)?.*? pv (.*)$/);
    if (!m) continue;
    const k = Number(l.match(/ multipv (\d+)/)?.[1] ?? 1) - 1;
    // a bound comes from an unfinished iteration (score not exact, pv cut short): keep the last exact line instead
    if (!m[3] || !infos[k] || infos[k].bound) infos[k] = { score: { [m[1]]: Number(m[2]) }, pv: m[4].trim().split(' '), bound: !!m[3] };
  }
  return infos.length ? infos : [{ score: { cp: 0 }, pv: [] }]; // no legal moves
}

// ---- board helpers ----

const position = fen => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
const fenOf = pos => makeFen(pos.toSetup());
const play = (pos, uci) => { const p = pos.clone(); p.play(parseUci(uci)); return p; };
const san = (pos, uci) => makeSan(pos, parseUci(uci));
const moveNo = pos => `${pos.fullmoves}${pos.turn === 'white' ? '.' : '...'}`; // '12.' for White, '12...' for Black

/** UCI as engines write it: castling is the king's two-square move (chessops plays it as king takes rook). */
function toUci(pos, mv) {
  const side = castlingSide(pos, mv);
  return makeUci(side ? { from: mv.from, to: kingCastlesTo(pos.turn, side) } : mv);
}

export function parseMove(pos, text) {
  const mv = parseSan(pos, text) ?? parseUci(text);
  if (!mv || !pos.isLegal(mv)) throw new Error(`${text} is not a legal move here`);
  return toUci(pos, mv);
}

const isEnPassant = (pos, mv) => pos.board.getRole(mv.from) === 'pawn' && mv.to === pos.epSquare;
const isCapture = (pos, mv) => pos.board.getColor(mv.to) === opposite(pos.turn) || isEnPassant(pos, mv);
const attackers = (pos, color, sq) => pos.kingAttackers(sq, color, pos.board.occupied);
const signed = n => (n >= 0 ? `+${n}` : `${n}`);
const round2 = x => Math.round(x * 100) / 100;

function scoreStr(s) {
  if ('mate' in s) return s.mate > 0 ? `mates in ${s.mate}` : `gets mated in ${-s.mate}`;
  return `${s.cp >= 0 ? '+' : ''}${(s.cp / 100).toFixed(2)}`;
}
const flip = s => ('mate' in s ? { mate: -s.mate } : { cp: -s.cp });
const pov = (s, pos, color) => (pos.turn === color ? s : flip(s)); // `s` is from pos's side to move
const cpOf = s => ('mate' in s ? (s.mate > 0 ? 10000 - s.mate : -10000 - s.mate) : s.cp);

/** Play the engine line and stop at the last quiet position (no check, last move not a capture),
    so the static eval is not taken in the middle of an exchange. */
function lineToLeaf(pos, pv, maxPlies = 12) {
  let b = pos, quiet = null, calm = null;
  const sans = [];
  for (const uci of pv.slice(0, maxPlies)) {
    const mv = parseUci(uci);
    const noisy = isCapture(b, mv) || mv.promotion;
    sans.push(`${b.turn === 'white' || !sans.length ? moveNo(b) : ''}${san(b, uci)}`); // 25...Ng8 26.Qxg7+ Ke8
    b = play(b, uci);
    if (!b.isCheck()) {
      calm = [b, [...sans]]; // fallback when the whole line is noisy
      if (!noisy) quiet = calm;
    }
  }
  const [leaf, leafSans] = quiet ?? calm ?? [null, []];
  return { leaf, leafSans };
}

function phase(pos) {
  let npm = 0;
  for (const [, p] of pos.board) npm += NPM[p.role] ?? 0;
  npm = Math.max(ENDGAME_LIMIT, Math.min(npm, MIDGAME_LIMIT));
  return Math.floor((npm - ENDGAME_LIMIT) * 128 / (MIDGAME_LIMIT - ENDGAME_LIMIT));
}

/** Run SF 15 `eval` and return {term: value in pawns} from `color`'s side, MG/EG blended by phase. */
async function sf15Terms(sf15, pos, color) {
  const lines = await sf15.until([`position fen ${fenOf(pos)}`, 'eval'], l => l.startsWith('Final evaluation'));
  const ph = phase(pos), sign = color === 'white' ? 1 : -1, terms = {};
  for (const l of lines) {
    const m = l.match(/^\|\s*([A-Za-z ]+?)\s*\|.*\|\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*\|$/);
    if (m) terms[m[1]] = round2(sign * (m[2] * ph + m[3] * (128 - ph)) / 128 / SF15_SCALE);
  }
  return terms;
}

/** Material balance in pawns (1/3/3/5/9) from `color`'s side. */
function material(pos, color) {
  let total = 0;
  for (const [, p] of pos.board) if (p.role !== 'king') total += VALUE[p.role] * (p.color === color ? 1 : -1);
  return total;
}

/** Enemy pieces newly attacked by the piece that just moved to `sq`, if worth more than it
    or attacked more times than defended. `owner` ("your"/"opp's") names whose pieces they are.
    ponytail: direct attacks only; discovered attacks and pins are not labelled. */
function threats(pos, sq, attackedBefore, owner) {
  const mover = pos.board.get(sq), out = [];
  for (const t of attacks(mover, sq, pos.board.occupied).intersect(pos.board[opposite(mover.color)])) {
    const victim = pos.board.get(t);
    if (victim.role === 'king' || attackedBefore.has(t)) continue;
    const a = attackers(pos, mover.color, t).size(), d = attackers(pos, victim.color, t).size();
    if (VALUE[victim.role] > VALUE[mover.role] || a > d) {
      const note = a > 1 ? `, attacked ${a}x defended ${d}x` : '';
      out.push(`attacks ${owner} ${victim.role} on ${makeSquare(t)}${note}`);
    }
  }
  return out;
}

/** '12. you Bc3 (-7.52) 12... opp Bb4 (-7.50) 13. you Bd2 (-7.68) 13... opp Qxa1 [takes rook, material -5] (-7.38) ...':
    Stockfish 19's eval after every move, from the original mover's ("you") view. */
async function lineWithEvals(sf, pos, pv, nodes, maxPlies = 20) {
  let b = pos, captured = false;
  const out = [], seenTrapped = new Set();
  for (const uci of pv.slice(0, maxPlies)) {
    const mv = parseUci(uci);
    const who = b.turn === pos.turn ? 'you' : 'opp';
    let text = `${moveNo(b)} ${who} ${san(b, uci)}`;
    const labels = [];
    captured = isCapture(b, mv);
    if (captured) labels.push(`takes ${isEnPassant(b, mv) ? 'pawn' : b.board.getRole(mv.to)}`);
    const before = attacks(b.board.get(mv.from), mv.from, b.board.occupied);
    b = play(b, uci);
    if (b.isCheck()) labels.push('check');
    labels.push(...threats(b, mv.to, before, who === 'you' ? "opp's" : 'your'));
    if (captured) labels.push(`material ${signed(material(b, pos.turn))}`);
    for (const sq of trapped(b)) {
      if (seenTrapped.has(sq)) continue;
      const owner = b.turn === pos.turn ? 'your' : "opp's";
      labels.push(`${owner} ${b.board.getRole(sq)} on ${makeSquare(sq)} is trapped`);
      seenTrapped.add(sq);
    }
    let ev;
    if (b.isCheckmate()) ev = 'checkmate';
    else if (b.isEnd()) ev = 'draw';
    else {
      const { score } = (await search(sf, b, nodes))[0];
      ev = scoreStr(pov(score, b, pos.turn));
      // what the mover would play next if the other side passed: catches batteries, discovered attacks, mate threats
      const [, threat] = await opponentThreat(sf, b, nodes, score);
      if (threat && /[x+#]/.test(threat.move)) labels.push(`threatens ${threat.move}`); // quiet threats are mostly noise mid-line
    }
    if (labels.length) text += ` [${labels.join(', ')}]`;
    out.push(`${text} (${ev})`);
  }
  if (out.length && captured) out.push('[line ends mid-exchange: a recapture may follow, so the last material count is not final]');
  return out.join(' ');
}

/** The piece on `sq` is attacked by a cheaper piece, or attacked more times than defended. */
function inDanger(pos, sq) {
  const p = pos.board.get(sq), atk = attackers(pos, opposite(p.color), sq);
  if (atk.isEmpty()) return false;
  return Math.min(...[...atk].map(a => VALUE[pos.board.getRole(a)])) < VALUE[p.role]
    || atk.size() > attackers(pos, p.color, sq).size();
}

/** `owner`'s pieces that are in danger, with their cheapest attacker. */
function loosePieces(pos, owner) {
  const out = [];
  for (const sq of pos.board[owner].reversed()) {
    const p = pos.board.get(sq);
    if (p.role === 'king' || !inDanger(pos, sq)) continue;
    const cheapest = [...attackers(pos, opposite(owner), sq)]
      .reduce((x, y) => (VALUE[pos.board.getRole(y)] < VALUE[pos.board.getRole(x)] ? y : x));
    out.push(`${p.role} on ${makeSquare(sq)} attacked by ${pos.board.getRole(cheapest)} on ${makeSquare(cheapest)}`);
  }
  return out;
}

/** Side-to-move pieces that are in danger and have no safe square to go to.
    ponytail: only counts escapes; blocking or adding a defender is not considered. */
export function trapped(pos) {
  const out = [];
  const pieces = pos.board[pos.turn].diff(pos.board.pawn).diff(pos.board.king);
  for (const sq of pieces) {
    if (!inDanger(pos, sq)) continue;
    const value = VALUE[pos.board.getRole(sq)];
    let escapes = false;
    for (const to of pos.dests(sq)) {
      const victim = pos.board.getRole(to);
      if (victim && VALUE[victim] >= value) { escapes = true; break; } // can trade itself off
      if (!inDanger(play(pos, makeUci({ from: sq, to })), to)) { escapes = true; break; }
    }
    if (!escapes) out.push(sq);
  }
  return out;
}

/** What is already on the board before you move: check, your loose pieces, enemy pieces you can win. */
function positionBefore(pos) {
  const checkers = [...pos.ctx().checkers].map(s => `${pos.board.getRole(s)} on ${makeSquare(s)}`);
  const or = list => (list.length ? list : null);
  return {
    you_are_in_check_from: or(checkers),
    your_pieces_in_danger: or(loosePieces(pos, pos.turn)),
    opponent_pieces_you_can_win: or(loosePieces(pos, opposite(pos.turn))),
  };
}

/** The opponent's best move if you could pass (null move), when it would gain at least a pawn.
    `scoreNow` is the current eval from the side to move. Returns [threat UCI, facts] or [null, null]. */
async function opponentThreat(sf, pos, nodes, scoreNow) {
  if (pos.isCheck()) return [null, null];
  const setup = pos.toSetup();
  setup.turn = opposite(setup.turn);
  setup.epSquare = undefined;
  const passed = Chess.fromSetup(setup);
  if (passed.isErr) return [null, null];
  const { score, pv } = (await search(sf, passed.value, nodes))[0];
  const threatScore = flip(score); // back to your side
  if (!pv.length || cpOf(scoreNow) - cpOf(threatScore) < 100) return [null, null];
  return [pv[0], { move: san(passed.value, pv[0]), eval_if_you_could_pass_and_opp_played_it: scoreStr(threatScore) }];
}

/** Your move, then the opponent plays the threat at once, then the engine's best play: does your move stop it? */
async function answerToThreat(sf, pos, move, threat, nodes) {
  const b = play(pos, move);
  if (!b.isLegal(parseUci(threat))) return 'the threat move is no longer legal after your move';
  const { pv } = (await search(sf, play(b, threat), nodes))[0];
  return lineWithEvals(sf, pos, [move, threat, ...pv], nodes, 6);
}

/** `played` and `vs` are UCI moves; `vs` null means the engine's best other move. */
export async function buildFacts({ sf, sf15 }, fen, played, vs, nodes = NODES) {
  const pos = position(fen);
  const before = (await search(sf, pos, nodes))[0].score;
  const [threat, threatFacts] = await opponentThreat(sf, pos, nodes, before);
  let other = vs;
  if (!other) {
    const infos = await search(sf, pos, nodes, { multipv: 2 });
    other = infos.map(i => i.pv[0]).find(m => m !== played);
  }
  if (!played || !other) throw new Error('There is only one legal move here: nothing to compare.');
  const lineNodes = Math.max(Math.floor(nodes / 10), 100_000);
  const lines = {};
  for (const [label, mv] of [['played', played], ['alternative', other]]) {
    const { score, pv } = (await search(sf, pos, nodes, { moves: [mv] }))[0];
    const { leaf, leafSans } = lineToLeaf(pos, pv);
    lines[label] = {
      move: san(pos, mv), latest_sf_eval: scoreStr(score), cp: cpOf(score),
      line_with_evals: await lineWithEvals(sf, pos, pv, lineNodes),
      explained_at_position_after: leafSans.join(' '),
      explained_fen: leaf ? fenOf(leaf) : null,
      sf15_terms: leaf ? await sf15Terms(sf15, leaf, pos.turn) : {},
    };
    if (threat) lines[label].if_opp_plays_the_threat_at_once = await answerToThreat(sf, pos, mv, threat, lineNodes);
  }
  const a = lines.alternative.sf15_terms, p = lines.played.sf15_terms;
  const diff = Object.keys(a).filter(k => k in p && k !== 'Total').map(k => [k, round2(a[k] - p[k])]);
  const hasTerms = Object.keys(a).length && Object.keys(p).length;
  return {
    fen,
    side_to_move: pos.turn === 'white' ? 'White' : 'Black',
    eval_before_any_move: scoreStr(before),
    position_before_move: positionBefore(pos),
    opponent_threat: threatFacts,
    material_before_any_move: material(pos, pos.turn),
    values_are_from: "side to move's point of view, in pawns",
    played: lines.played,
    alternative: lines.alternative,
    latest_sf_gap: round2((lines.alternative.cp - lines.played.cp) / 100),
    sf15_term_diff_alternative_minus_played: Object.fromEntries(diff.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))),
    sf15_total_gap: hasTerms ? round2((a.Total ?? 0) - (p.Total ?? 0)) : null,
  };
}

// ---- the LLM ----

export const SYSTEM = `You are a chess coach for club players (around 1200-1800 rating).
You get facts from two engines about one position and two candidate moves:
- "latest_sf_eval" and "line_with_evals" come from the latest Stockfish. They are the truth about which move is better.
  The player who asks is the side to move: call them "you". In "line_with_evals" every move has its move number ("12." for White,
  "12..." for Black), is tagged "you" or "opp" (opponent) and is followed by the eval after it, from your view (in pawns, or mate). Always say who plays a move.
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
   name the moves that lead there first ("after 14...Rfe8 15.Nbd2 Ne7 16.g3 c5 17.a5 Bg4, 18.Ne5 attacks your bishop on g4"), so a piece
   that moves during the line is never described as if it already stood there. Prefer the first few moves of a line:
   later moves are less reliable. Always write move numbers as in that example, so it is clear which side plays each move.
7. The "[line ends mid-exchange ...]" note is for you only: do not quote it, just do not count the last capture as final.`;

export async function explain(facts, apiKey, effort = 'high') {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // the key is the user's own, stored in their browser profile
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 16000,
      output_config: { effort },
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(facts, null, 1) }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await r.json();
  if (r.status === 401) throw new Error('Anthropic rejected the API key. Check it in the panel settings.');
  if (!r.ok) throw new Error(`Anthropic API error ${r.status}: ${body.error?.message ?? r.statusText}`);
  if (body.stop_reason === 'refusal') return '(the model declined to answer)';
  return body.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// ---- one panel request ----

/** Fair play: fail closed unless lichess confirms `user` is not in a game. */
export async function checkNotPlaying(user) {
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(user ?? '')) throw new Refused('Log in to lichess so I can check you are not playing a game.');
  let status;
  try {
    const r = await fetch(`https://lichess.org/api/users/status?ids=${encodeURIComponent(user)}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    status = await r.json();
  } catch (e) {
    throw new Refused(`Could not verify you are not in a game (${e.message}).`);
  }
  if (!status.length) throw new Refused(`Unknown lichess user ${user}.`);
  if (status.some(s => s.playing)) throw new Refused('You are playing a game on lichess. No engine help during games.');
}

/** {fen, move, best, user} -> {text, best, compared}. move: the move to compare against (SAN or UCI),
    best: lichess's top move (UCI, optional), user: lichess username. `llm` is replaceable for tests. */
export async function handle(engines, req, apiKey, llm = explain) {
  await checkNotPlaying(req.user);
  let pos;
  try { pos = position(req.fen); } catch { throw new Error('invalid position'); }
  let move = parseMove(pos, req.move);
  const best = req.best ? parseMove(pos, req.best) : null;
  if (best === move) {
    // you played lichess's move: still explain that move, against the best other move
    const infos = await search(engines.sf, pos, NODES, { multipv: 2 });
    move = infos.map(i => i.pv[0]).find(m => m !== move);
  }
  const facts = await buildFacts(engines, req.fen, move, best, NODES);
  const line = k => ({ move: facts[k].move, eval: facts[k].latest_sf_eval, line: facts[k].line_with_evals });
  const gap = Math.abs(facts.latest_sf_gap);
  // the engines' lines differ for reasons too small to explain; a story would only invent one
  const text = gap < EQUAL_GAP
    ? `**${facts.played.move}** is about as good as **${facts.alternative.move}**: the difference is ${gap.toFixed(2)} pawns, `
      + 'which is within the engine\'s noise. Either move is fine.'
    : await llm(facts, apiKey, 'high');
  return { text, best: line('alternative'), compared: line('played') };
}

// ---- node ----

/** Node only: the two WASM engines as child processes. Returns {sf, sf15, quit}. */
export async function nodeEngines(threads = THREADS) {
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const { fileURLToPath } = await import('node:url');
  const procs = [];
  const start = path => {
    // the SF 15 build's old emscripten loader breaks on node's fetch
    const p = spawn(process.execPath, ['--import', 'data:text/javascript,delete globalThis.fetch', fileURLToPath(new URL(path, import.meta.url))]);
    procs.push(p);
    const e = uciEngine(l => p.stdin.write(l + '\n'));
    createInterface({ input: p.stdout }).on('line', e.onLine);
    return e;
  };
  return { ...await startEngines(start, threads), quit: () => procs.forEach(p => p.stdin.end('quit\n')) };
}

if (import.meta.main) { // node 24.2+; undefined in the browser
  const { parseArgs } = await import('node:util');
  const { values: o, positionals: [fen, move] } = parseArgs({
    allowPositionals: true,
    options: { vs: { type: 'string' }, nodes: { type: 'string', default: String(NODES) },
      effort: { type: 'string', default: 'medium' }, 'no-llm': { type: 'boolean' } },
  });
  const engines = await nodeEngines();
  try {
    const pos = position(fen);
    const facts = await buildFacts(engines, fen, parseMove(pos, move), o.vs ? parseMove(pos, o.vs) : null, Number(o.nodes));
    console.log(JSON.stringify(facts, null, 1));
    if (!o['no-llm']) console.log('\n' + await explain(facts, process.env.ANTHROPIC_API_KEY, o.effort));
  } finally {
    engines.quit();
  }
}
