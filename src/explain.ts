// Explain why one chess move is better than another.
//
// Stockfish 19 decides WHICH move is better (eval + main line).
// Stockfish 15's hand-crafted eval explains WHY (term-by-term diff a few moves into each line).
// An LLM turns those numbers into plain language.
//
// Runs in the side panel (engines in Web Workers) and in node (engines as child processes).
// The command line and the child processes are in cli.ts: this file ships in the panel, so it uses nothing of node's.

import {
  Chess, SquareSet, attacks, castlingSide, kingCastlesTo, makeFen, makeSan, makeSquare, makeUci, opposite, parseFen,
  parseSan, parseUci, squareFile, squareRank,
} from './chessops.ts';
import {
  endNotes, hasBishopPair, imbalances, isOutpost, islandChange, key, leafDiff, orNull, outpostSquares, owner, passedPawns,
  pawnWeaknesses, rookFile, shieldHoles, word,
} from './features.ts';
import type { Color, NormalMove, Position, Role, Square, SquareName } from './chessops.ts';
import type { Imbalances, LeafDiff, Owner } from './features.ts';

// ---- types ----

/** Sends UCI commands `cmds` and resolves with every output line up to and including the one `done` accepts. */
export type Until = (cmds: string[], done: (line: string) => boolean, signal?: AbortSignal) => Promise<string[]>;
/** All the fact builders need of an engine: uciEngine's, or a test's recorded or wrapped one. */
export interface UciLink { until: Until }
/** What uciEngine() returns. */
export interface Engine extends UciLink {
  /** Feed every line the engine writes here. */
  onLine: (line: string) => void;
  /** The engine is dead: its request under way and every later one reject with `error`. */
  fail: (error: Error) => void;
}
/** Two copies of the latest Stockfish (one per candidate line) and SF 15 for its terms, as startEngines() starts them. */
export interface Engines<E extends UciLink = UciLink> { sf: E; sf2: E; sf15: E }

/** An engine score from one side's view: centipawns, or mate in that many moves (negative: gets mated). */
export type Score = { cp: number } | { mate: number };
/** One MultiPV line of a search: its score from the side to move, and its moves in UCI. */
export interface PvLine { score: Score; pv: string[] }
export interface SearchOptions { moves?: string[]; multipv?: number }

/** One two-sided SF 15 term split by whose pieces score it (see sf15Terms). */
export interface SideSplit { yours: number; theirs: number }
/** sf15Terms(): term -> pawns, and the two-sided terms by side. */
export interface Sf15Terms { terms: Record<string, number>; sides: Record<string, SideSplit> }

/** A pin against one side: the pinner, the pinned piece and what stands behind it (squares). */
export interface Pin { pinner: Square; pinned: Square; behind: Square }
/** A quiet pawn move later in a line (see pawnPushes). */
export interface PawnPush { move: string; text: string; point: boolean }
/** One ply linePlies() reads back: '12.' or '12...', the SAN, and its index in the text. */
export interface LinePly { no: string; san: string; at: number }

export type Side = 'White' | 'Black';
/** The callback ask() streams to: the reply's text so far. */
export type OnText = (text: string) => void;
/** One LLM call: `system`, then `facts` as the user message (JSON). Returns the reply's text. */
export type Llm = (system: string, facts: object, model: string, onText?: OnText) => Promise<string>;

/** The threat the opponent would play if the side to move passed. */
export interface ThreatFacts { move: string; eval_if_you_could_pass_and_opp_played_it: string }
/** What is already on the board before the move (see positionBefore). */
export interface PositionBefore {
  you_are_in_check_from: string[] | null;
  your_pieces_in_danger: string[] | null;
  opponent_pieces_you_can_win: string[] | null;
  your_pinned_pieces: string[] | null;
  opponent_pinned_pieces: string[] | null;
}
/** One move with its score, as the about-equal sheet holds it. */
export interface ScoredMove { move: string; latest_sf_eval: string; cp: number }
/** One move's line on the full sheet. */
export interface SheetLine extends ScoredMove {
  line_with_evals: string;
  explained_at_position_after: string;
  explained_fen: string | null;
  notes_at_that_position: string[] | null;
  sf15_terms: Record<string, number>;
  if_opp_plays_the_threat_at_once?: string;
}
/** The capture or check the better move sets up (see prepares). */
export interface Prepares {
  move: string;
  eval_if_played_at_once: string;
  line_if_played_at_once: string;
  follow_up_fails: string | null;
  better_move_guards: SquareName | null;
}
/** The sheet when the two moves are about equal: only their scores. */
export interface AboutEqualSheet {
  /** type only: keeps a full sheet from passing for a short one, so aboutEqual() can narrow */
  eval_before_any_move?: never;
  fen: string;
  side_to_move: Side;
  played: ScoredMove;
  alternative: ScoredMove;
  latest_sf_gap: number;
}
/** The full fact sheet for a played move against its better alternative. */
export interface FullFactSheet {
  fen: string;
  side_to_move: Side;
  eval_before_any_move: string;
  position_before_move: PositionBefore;
  imbalances: Imbalances;
  opponent_threat: ThreatFacts | null;
  material_before_any_move: number;
  values_are_from: string;
  played: SheetLine;
  alternative: SheetLine;
  latest_sf_gap: number;
  prepares: Prepares | null;
  pawn_plan_only_in_better_line: string[] | null;
  after_each_line: LeafDiff | null;
  sf15_term_diff_alternative_minus_played: Record<string, number>;
  sf15_term_diff_by_side: Record<string, SideSplit> | null;
  sf15_total_gap: number | null;
}
/** What factSheet() returns. */
export type FactSheet = FullFactSheet | AboutEqualSheet;

export type PlanKind = 'tactical' | 'positional';
/** The engine's best move and its line on the plan sheet. */
export interface PlanLine {
  move: string;
  latest_sf_eval: string;
  line_with_evals: string;
  explained_at_position_after: string;
  explained_fen: string | null;
  notes_at_that_position: string[] | null;
  sf15_terms: Record<string, number>;
}
/** The engine's second move when it is about as good as the best. */
export interface AlsoGood { move: string; latest_sf_eval: string; line_with_evals: string }
/** What planFacts() returns. */
export interface PlanFacts {
  fen: string;
  side_to_move: Side;
  plan_kind: PlanKind;
  position_before_move: PositionBefore;
  imbalances: Imbalances;
  opponent_threat: ThreatFacts | null;
  material_before_any_move: number;
  values_are_from: string;
  best: PlanLine;
  also_good: AlsoGood | null;
  pawn_pushes_in_line: string[] | null;
}

export const NODES = 2_000_000;
const THREADS = 1; // one search thread: a node-limited search then gives the same lines every run
const EQUAL_GAP = 0.3; // pawns; below this both moves are called equal and the LLM is skipped
const ALSO_GAP = 0.1; // pawns; a plan names the engine's second move as "about as good" below this
export const DECLINED = '(the model declined to answer)';
const LEAF_PLIES = 6; // SF 15 terms are measured within this many plies of each line
// centipawns the opponent must gain with a free move before the position's threat is reported. A free move is worth
// a tempo (up to ~0.5) anyway; above that it is a plan, such as a g4-g5 pawn storm.
const QUIET_THREAT = 50;

// SF 15 game phase (src/material.cpp): non-pawn material between these limits maps to 0..128
const MIDGAME_LIMIT = 15258, ENDGAME_LIMIT = 3915;
const NPM: Partial<Record<Role, number>> = { knight: 781, bishop: 825, rook: 1276, queen: 2538 };
// The bundled build is SF 15; 15.1 changed the pawn normalisation, so 15's terms are 361/208 times larger.
const SF15_SCALE = 361 / 208;
const VALUE: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100 };

// ---- engines ----

/** Talks UCI to one Stockfish. `send(line)` writes a command; feed every output line to the returned `onLine`.
    Commands run one at a time, in call order. A dead engine never answers again: tell it with `fail(error)`, and the
    request it is on and every later one reject with that error instead of waiting for ever. When `signal` aborts
    while its commands are with the engine (or before), `stop` follows them, so a search ends at once with its bestmove. */
export function uciEngine(send: (line: string) => void): Engine {
  let waiting: ((l: string) => void) | null = null, reject: ((error: Error) => void) | null = null, dead: Error | null = null,
    queue: Promise<void | string[]> = Promise.resolve();
  const until: Until = (cmds, done, signal) => (queue = queue.then<string[]>(() => new Promise((resolve, no) => {
    if (dead) return no(dead);
    const lines: string[] = [], stop = () => send('stop');
    waiting = l => {
      lines.push(l);
      if (done(l)) { waiting = reject = null; signal?.removeEventListener('abort', stop); resolve(lines); }
    };
    reject = no;
    cmds.forEach(send);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  })));
  const fail = (error: Error) => {
    dead = error;
    waiting = null;
    reject?.(error);
    queue.catch(() => {}); // requests still in the queue reject after this one; nobody may be waiting for the last
  };
  return { onLine: l => waiting?.(l), until, fail };
}

/** Starts the engines with `start(path)` (path relative to `extension/`), which returns a uciEngine: two copies of the
    latest Stockfish (one per candidate line, so the two lines are searched at the same time) and SF 15 for its terms.
    The WASM builds drop input that arrives before they have loaded, so nothing else is sent until uciok. */
export async function startEngines(start: (path: string) => Engine): Promise<Engines<Engine>> {
  const setup = async (e: Engine, options: [string, string | number | boolean][]) => {
    await e.until(['uci'], l => l === 'uciok');
    await e.until([...options.map(([k, v]) => `setoption name ${k} value ${v}`), 'isready'], l => l === 'readyok');
    return e;
  };
  const latest = () => setup(start('vendor/stockfish/stockfish-19-lite.js'), [['Threads', THREADS], ['Hash', 256]]);
  const [sf, sf2, sf15] = await Promise.all([latest(), latest(), setup(start('vendor/stockfish/sf15/stockfish.js'), [['Use NNUE', false]])]);
  return { sf, sf2, sf15 };
}

/** Searches `pos` for `nodes`; returns [{score, pv}] per MultiPV line. `score` is {cp} or {mate}, from the
    side to move; `pv` is a list of UCI moves. */
export async function search(sf: UciLink, pos: Position, nodes: number, { moves, multipv = 1 }: SearchOptions = {}): Promise<PvLine[]> {
  const lines = await sf.until([
    `setoption name MultiPV value ${multipv}`,
    `position fen ${fenOf(pos)}`,
    `go nodes ${nodes}${moves ? ' searchmoves ' + moves.join(' ') : ''}`,
  ], l => l.startsWith('bestmove'));
  const infos = pickInfos(lines).map(l => {
    const m = l.match(INFO)!; // pickInfos kept only lines that match
    const score: Score = m[1] === 'cp' ? { cp: Number(m[2]) } : { mate: Number(m[2]) };
    return { score, pv: m[4].trim().split(' ') };
  });
  return infos.length ? infos : [{ score: { cp: 0 }, pv: [] }]; // no legal moves
}

const INFO = /^info .* score (cp|mate) (-?\d+)( lowerbound| upperbound)?.*? pv (.*)$/;

/** The info lines search() reads, one per MultiPV line: the last exact one, else the last bound. A bound comes from
    an unfinished iteration (score not exact, pv cut short), so an exact line always wins over it. */
export function pickInfos(lines: string[]): string[] {
  const keep: string[] = [];
  for (const l of lines) {
    const m = l.match(INFO);
    if (!m) continue;
    const k = Number(l.match(/ multipv (\d+)/)?.[1] ?? 1) - 1;
    if (!m[3] || !keep[k] || keep[k].match(INFO)![3]) keep[k] = l;
  }
  return keep;
}

// ---- board helpers ----

export const position = (fen: string): Chess => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
const fenOf = (pos: Position) => makeFen(pos.toSetup());
export const play = (pos: Position, uci: string): Position => { const p = pos.clone(); p.play(parseUci(uci)!); return p; };
export const san = (pos: Position, uci: string) => makeSan(pos, parseUci(uci)!);
/** A UCI move an engine wrote, or one from its line: standard chess, so always a board move, never a drop. */
const normalMove = (uci: string) => parseUci(uci) as NormalMove;
export const moveNo = (pos: Position) => `${pos.fullmoves}${pos.turn === 'white' ? '.' : '...'}`; // '12.' for White, '12...' for Black

/** SAN or UCI -> UCI as engines write it: castling is the king's two-square move (chessops plays it as king takes rook). */
function parseMove(pos: Position, text: string): string {
  const mv = parseSan(pos, text) ?? parseUci(text);
  if (!mv || !pos.isLegal(mv)) throw new Error(`${text} is not a legal move here`);
  const side = castlingSide(pos, mv);
  return makeUci(side && 'from' in mv ? { from: mv.from, to: kingCastlesTo(pos.turn, side) } : mv);
}

/** SAN moves played one after another from `fen` -> the same moves in UCI, as engines write them. */
export function sanToUci(fen: string, sans: string[]): string[] {
  let pos = position(fen);
  return sans.map(s => {
    const uci = parseMove(pos, s);
    pos = play(pos, uci);
    return uci;
  });
}

const isEnPassant = (pos: Position, mv: NormalMove) => pos.board.getRole(mv.from) === 'pawn' && mv.to === pos.epSquare;
const forcing = (sanText: string) => /[x+#]/.test(sanText); // a capture or a check, from the SAN
const isCapture = (pos: Position, mv: NormalMove) => pos.board.getColor(mv.to) === opposite(pos.turn) || isEnPassant(pos, mv);
const attackers = (pos: Position, color: Color, sq: Square) => pos.kingAttackers(sq, color, pos.board.occupied);
const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
const round2 = (x: number) => Math.round(x * 100) / 100;

function scoreStr(s: Score): string {
  if ('mate' in s) return s.mate > 0 ? `mates in ${s.mate}` : `gets mated in ${-s.mate}`;
  return `${s.cp >= 0 ? '+' : ''}${(s.cp / 100).toFixed(2)}`;
}
const flip = (s: Score): Score => ('mate' in s ? { mate: -s.mate } : { cp: -s.cp });
const pov = (s: Score, pos: Position, color: Color) => (pos.turn === color ? s : flip(s)); // `s` is from pos's side to move
const cpOf = (s: Score): number => ('mate' in s ? (s.mate > 0 ? 10000 - s.mate : -10000 - s.mate) : s.cp);

/** Play the first LEAF_PLIES of the engine line and stop at the last quiet position (no check, last move not
    a capture), so the static eval is not taken in the middle of an exchange. Kept short: the first moves of a
    line are the most reliable, and they are the ones the answer quotes. */
export function lineToLeaf(pos: Position, pv: string[]): { leaf: Position | null; leafSans: string[] } {
  let b = pos, quiet: [Position, string[]] | null = null, calm: [Position, string[]] | null = null;
  const sans: string[] = [];
  for (const uci of pv.slice(0, LEAF_PLIES)) {
    const mv = normalMove(uci);
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

function phase(pos: Position): number {
  let npm = 0;
  for (const [, p] of pos.board) npm += NPM[p.role] ?? 0;
  npm = Math.max(ENDGAME_LIMIT, Math.min(npm, MIDGAME_LIMIT));
  return Math.floor((npm - ENDGAME_LIMIT) * 128 / (MIDGAME_LIMIT - ENDGAME_LIMIT));
}

/** Run SF 15 `eval` and return {terms: {term: value in pawns}, sides: {term: {yours, theirs}}} from `color`'s side, MG/EG
    blended by phase. sides holds the two-sided terms split by whose pieces score them: yours + theirs = the term, and
    theirs > 0 means their side scores less (their king is less safe), not that yours scores more. */
export async function sf15Terms(sf15: UciLink, pos: Position, color: Color): Promise<Sf15Terms> {
  const lines = await sf15.until([`position fen ${fenOf(pos)}`, 'eval'], l => l.startsWith('Final evaluation'));
  const ph = phase(pos), sign = color === 'white' ? 1 : -1, terms: Sf15Terms['terms'] = {}, sides: Sf15Terms['sides'] = {};
  const blend = (mg: string, eg: string) => (Number(mg) * ph + Number(eg) * (128 - ph)) / 128 / SF15_SCALE;
  for (const l of lines) {
    const m = l.match(/^\|\s*([A-Za-z ]+?)\s*\|\s*(\S+)\s+(\S+)\s*\|\s*(\S+)\s+(\S+)\s*\|\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*\|$/);
    if (!m) continue;
    terms[m[1]] = round2(sign * blend(m[6], m[7]));
    if (m[2] === '----') continue; // one-sided: Material, Imbalance, Winnable, Total
    const [w, b] = [blend(m[2], m[3]), blend(m[4], m[5])];
    sides[m[1]] = color === 'white' ? { yours: round2(w), theirs: round2(-b) } : { yours: round2(b), theirs: round2(-w) };
  }
  return { terms, sides };
}

/** Material balance in pawns (1/3/3/5/9) from `color`'s side. */
function material(pos: Position, color: Color): number {
  let total = 0;
  for (const [, p] of pos.board) if (p.role !== 'king') total += VALUE[p.role] * (p.color === color ? 1 : -1);
  return total;
}

/** Enemy pieces newly attacked by the piece that just moved to `sq`, if worth more than it
    or attacked more times than defended. `whose` ("your"/"opp's") names whose pieces they are.
    ponytail: direct attacks only; discovered attacks are not labelled. */
function threats(pos: Position, sq: Square, attackedBefore: SquareSet | Set<Square>, whose: Owner): string[] {
  const mover = pos.board.get(sq)!, out: string[] = [];
  for (const t of attacks(mover, sq, pos.board.occupied).intersect(pos.board[opposite(mover.color)])) {
    const victim = pos.board.get(t)!;
    if (victim.role === 'king' || attackedBefore.has(t)) continue;
    const a = attackers(pos, mover.color, t).size(), d = attackers(pos, victim.color, t).size();
    if (VALUE[victim.role] > VALUE[mover.role] || a > d) {
      const note = a > 1 ? `, attacked ${a}x defended ${d}x` : '';
      out.push(`attacks ${whose} ${victim.role} on ${makeSquare(t)}${note}`);
    }
  }
  return out;
}

/** Pins against `color`: an enemy bishop, rook or queen attacks a `color` piece, and behind it stands the king,
    or a more valuable piece the pinner could win (worth more than the pinner, or undefended).
    Returns [{pinner, pinned, behind}] (squares).
    ponytail: skewers (the more valuable piece in front) are not reported. */
export function pins(pos: Position, color: Color): Pin[] {
  const out: Pin[] = [], b = pos.board, occ = b.occupied;
  for (const pinner of b[opposite(color)].intersect(b.bishop.union(b.rook).union(b.queen))) {
    const slider = b.get(pinner)!, seen = attacks(slider, pinner, occ);
    for (const pinned of seen.intersect(b[color]).diff(b.king)) {
      if (attacks(b.get(pinned)!, pinned, occ).has(pinner)) continue; // it can just take the pinner
      // removing the pinned piece only extends the line through it: whatever is newly attacked stands behind it
      const behind = attacks(slider, pinner, occ.without(pinned)).diff(seen).intersect(b[color]).first();
      if (behind === undefined) continue;
      const v = VALUE[b.getRole(behind)!];
      if (v > VALUE[b.getRole(pinned)!] && (v > VALUE[slider.role] || attackers(pos, color, behind).isEmpty()))
        out.push({ pinner, pinned, behind });
    }
  }
  return out;
}

const pinText = (pos: Position, { pinned, behind }: Pin) =>
  `${pos.board.getRole(pinned)} on ${makeSquare(pinned)} to ${pos.board.getRole(behind)} on ${makeSquare(behind)}`;

/** Your quiet pawn moves later in the line (after its first move): [{ move: 'f3', text: '4.f3 (to the square 1.Nd2 left)',
    point }]. `point` marks a push within the first `maxPlies` that does something: it goes to the square the first move
    left, attacks a piece (as the line labels count it) or frees or shuts in a bishop. Flank pushes that only gain space do not. */
export function pawnPushes(pos: Position, pv: string[], you: Color, maxPlies = 10): PawnPush[] {
  const first = pv[0] ? normalMove(pv[0]) : undefined, firstSan = pv[0] && `${moveNo(pos)}${san(pos, pv[0])}`, out: PawnPush[] = [];
  let b = pos;
  for (const [i, uci] of pv.entries()) {
    const mv = normalMove(uci), next = play(b, uci);
    if (i > 0 && b.turn === you && b.board.getRole(mv.from) === 'pawn' && !isCapture(b, mv) && !mv.promotion) {
      const step = b.turn === 'white' ? 8 : -8;
      const room = first!.from !== mv.from && [mv.from + step, mv.to].includes(first!.from) && b.board.getRole(first!.from) === undefined;
      const point = i < maxPlies && (room || threats(next, mv.to, new Set(), "opp's").length > 0
        || bishopReach(b, next, uci).length > 0);
      out.push({ move: san(b, uci), text: `${moveNo(b)}${san(b, uci)}${room ? ` (to the square ${firstSan} left)` : ''}`, point });
    }
    b = next;
  }
  return out;
}

/** The pushes with a point in line `a` that line `b` never plays, as text, or null. */
function onlyIn(a: PawnPush[], b: PawnPush[]): string[] | null {
  return orNull(a.filter(p => p.point && !b.some(q => q.move === p.move)).map(p => p.text));
}

/** Bishops (other than the mover) whose reach changes by 3+ squares when move `uci` from `b` to `next` moves or takes a
    pawn and so opens or closes diagonals: [{square, color, change}]. */
function bishopReach(b: Position, next: Position, uci: string): { square: Square; color: Color; change: number }[] {
  const mv = normalMove(uci), out: { square: Square; color: Color; change: number }[] = [];
  if (b.board.getRole(mv.from) !== 'pawn' && b.board.getRole(mv.to) !== 'pawn' && !isEnPassant(b, mv)) return out;
  const reach = (pos: Position, sq: Square) => attacks(pos.board.get(sq)!, sq, pos.board.occupied).diff(pos.board[pos.board.getColor(sq)!]).size();
  for (const sq of b.board.bishop.intersect(next.board.bishop).without(mv.from)) {
    if (b.board.getColor(sq) !== next.board.getColor(sq)) continue;
    const change = reach(next, sq) - reach(b, sq);
    if (Math.abs(change) >= 3) out.push({ square: sq, color: b.board.getColor(sq)!, change });
  }
  return out;
}

/** Positional labels for move `uci` from `b` to `next`; `you` is the side the explanation is for. */
export function moveLabels(b: Position, next: Position, uci: string, you: Color): string[] {
  const mv = normalMove(uci), role = b.board.getRole(mv.from), victim = b.board.getRole(mv.to);
  const labels: string[] = [];
  // SF 15's Space term only counts squares behind your own pawns, so it hardly sees a pawn pushed forward
  const rank = squareRank(mv.to) + 1;
  if (role === 'pawn' && !isCapture(b, mv) && (b.turn === 'white' ? rank >= 4 : rank <= 5)) labels.push('pawn gains space');
  if ((role === 'knight' || role === 'bishop') && isOutpost(next.board, mv.to, b.turn))
    labels.push(word({ kind: 'outpost', role, square: makeSquare(mv.to) }));
  const them = opposite(b.turn);
  if (role === 'rook' && squareFile(mv.from) !== squareFile(mv.to)) {
    const file = rookFile(next.board, mv.to, b.turn);
    if (file) labels.push(word(file, 'move'));
  }
  // the 7th only counts with enemy pawns to attack there or the enemy king held on its back rank
  const seventh = b.turn === 'white' ? 6 : 1;
  if (role === 'rook' && squareRank(mv.to) === seventh && squareRank(mv.from) !== seventh
    && (next.board.pawn.intersect(next.board[them]).intersects(SquareSet.fromRank(seventh))
      || squareRank(next.board.kingOf(them)!) === (b.turn === 'white' ? 7 : 0)))
    labels.push('rook on 7th rank');
  if (hasBishopPair(b.board, them) && !hasBishopPair(next.board, them)) labels.push(`${owner(them, you)} ${word({ kind: 'bishopPair' }, 'move')}`);
  if (role === 'pawn' || victim === 'pawn' || isEnPassant(b, mv)) {
    for (const { square, color, change } of bishopReach(b, next, uci))
      labels.push(change > 0 ? `frees ${owner(color, you)} bishop on ${makeSquare(square)} (+${change} squares)`
        : `shuts in ${owner(color, you)} bishop on ${makeSquare(square)} (${change} squares)`);
    for (const color of [b.turn, them]) {
      // STRUCTURE's detectors, weaknesses first: the order the labels have always had on a move
      for (const features of [pawnWeaknesses, passedPawns, shieldHoles, outpostSquares]) {
        const before = new Set(features(b.board, color).map(key));
        for (const f of features(next.board, color)) if (!before.has(key(f))) labels.push(`${owner(color, you)} ${word(f)}`);
      }
      const islands = islandChange(b.board, next.board, color);
      if (islands) labels.push(`${owner(color, you)} ${word(islands)}`);
    }
  }
  return labels;
}

/** Reads a line lineWithEvals wrote back into moves: per row (the main line, then each "Why X fails:" line), the
    plies as {no: '12.' or '12...', san, at: index in `text`}. The one reader of that format: keep it next to the writer. */
export const linePlies = (text: string): LinePly[][] => {
  let start = 0;
  return text.split('\n').map(row => {
    const at = start;
    start += row.length + 1;
    return [...row.matchAll(/(\d+\.(?:\.\.)?) (?:you|opp) (\S+)/g)].map(m => ({ no: m[1], san: m[2], at: at + m.index }));
  });
};

/** '12. you Bc3 (-7.52) 12... opp Bb4 (-7.50) 13. you Bd2 (-7.68) 13... opp Qxa1 [takes rook, material -5] (-7.38) ...':
    Stockfish 19's eval after every move, from `you`'s view, for `maxPlies` plies and then on until an exchange is over.
    A skipped recapture that loses is played out on its own line below. `nested` is set for those lines, so they do not branch again. */
async function lineWithEvals(sf: UciLink, pos: Position, pv: string[], nodes: number, maxPlies = 20, you: Color = pos.turn, nested = false): Promise<string> {
  let b = pos, captured = false;
  const out: string[] = [], why: string[] = [], seenTrapped = new Set<Square>();
  for (const [i, uci] of pv.entries()) {
    if (i >= maxPlies && !captured) break; // past the limit, play on only to finish an exchange
    const mv = normalMove(uci);
    const who = b.turn === you ? 'you' : 'opp';
    let text = `${moveNo(b)} ${who} ${san(b, uci)}`;
    const labels: string[] = [];
    captured = isCapture(b, mv);
    if (captured) labels.push(`takes ${isEnPassant(b, mv) ? 'pawn' : b.board.getRole(mv.to)}`);
    const before = attacks(b.board.get(mv.from)!, mv.from, b.board.occupied);
    const pinsBefore = new Set(pins(b, opposite(b.turn)).map(p => `${p.pinner} ${p.pinned}`));
    const prev = b;
    b = play(b, uci);
    if (b.isCheck()) labels.push('check');
    const theirs = owner(b.turn, you); // the side to move now: whose pieces the move hits
    labels.push(...threats(b, mv.to, before, theirs));
    // new pins, by the moved piece or by a line it opened
    for (const p of pins(b, b.turn)) if (!pinsBefore.has(`${p.pinner} ${p.pinned}`)) labels.push(`pins ${theirs} ${pinText(b, p)}`);
    if (captured) labels.push(`material ${signed(material(b, you))}`);
    labels.push(...moveLabels(prev, b, uci, you));
    for (const sq of trapped(b)) {
      if (seenTrapped.has(sq)) continue;
      labels.push(`${theirs} ${b.board.getRole(sq)} on ${makeSquare(sq)} is trapped`);
      seenTrapped.add(sq);
    }
    let ev: string;
    if (b.isCheckmate()) ev = 'checkmate';
    else if (b.isEnd()) ev = 'draw';
    else {
      const { score } = (await search(sf, b, nodes))[0];
      ev = scoreStr(pov(score, b, you));
      // what the mover would play next if the other side passed: catches batteries, discovered attacks, mate threats
      const [, threat] = await opponentThreat(sf, b, nodes, score);
      if (threat && forcing(threat.move)) labels.push(`threatens ${threat.move}`); // quiet threats are mostly noise mid-line
      const next = pv[i + 1] && normalMove(pv[i + 1]);
      const failed = captured && !nested && next && next.to !== mv.to && await failedRecapture(sf, b, mv.to, score, nodes);
      if (failed) {
        const rec = `${moveNo(b)}${san(b, failed[0])}`;
        labels.push(`${owner(b.turn, you)} recapture ${rec} fails (line below)`);
        why.push(`Why ${rec} fails: ${await lineWithEvals(sf, b, failed, nodes, 7, you, true)}`);
      }
    }
    if (labels.length) text += ` [${labels.join(', ')}]`;
    out.push(`${text} (${ev})`);
  }
  if (out.length && captured) out.push('[line ends mid-exchange: a recapture may follow, so the last material count is not final]');
  return [out.join(' '), ...why].join('\n');
}

/** The line didn't take back on `sq`: if the cheapest recapture loses at least a pawn more than the line's `score`
    (side to move's view), returns it with the engine's best reply line (UCI), so a defended piece is not called undefended. */
async function failedRecapture(sf: UciLink, b: Position, sq: Square, score: Score, nodes: number): Promise<string[] | null> {
  let from: Square | undefined;
  for (const s of b.board[b.turn])
    if (b.dests(s).has(sq) && (from === undefined || VALUE[b.board.getRole(s)!] < VALUE[b.board.getRole(from)!])) from = s;
  if (from === undefined) return null;
  const promotes = b.board.getRole(from) === 'pawn' && (squareRank(sq) === 0 || squareRank(sq) === 7);
  const rec = makeUci({ from, to: sq, promotion: promotes ? 'queen' : undefined });
  const after = play(b, rec);
  if (after.isEnd()) return null;
  const r = (await search(sf, after, nodes))[0];
  if (cpOf(flip(r.score)) > cpOf(score) - 100) return null; // about as good: the line just preferred another move first
  return [rec, ...r.pv];
}

/** The piece on `sq` is attacked by a cheaper piece, or attacked more times than defended. */
function inDanger(pos: Position, sq: Square): boolean {
  const p = pos.board.get(sq)!, atk = attackers(pos, opposite(p.color), sq);
  if (atk.isEmpty()) return false;
  return Math.min(...[...atk].map(a => VALUE[pos.board.getRole(a)!])) < VALUE[p.role]
    || atk.size() > attackers(pos, p.color, sq).size();
}

/** `owner`'s pieces that are in danger, with their cheapest attacker. */
function loosePieces(pos: Position, owner: Color): string[] {
  const out: string[] = [];
  for (const sq of pos.board[owner].reversed()) {
    const p = pos.board.get(sq)!;
    if (p.role === 'king' || !inDanger(pos, sq)) continue;
    const cheapest = [...attackers(pos, opposite(owner), sq)]
      .reduce((x, y) => (VALUE[pos.board.getRole(y)!] < VALUE[pos.board.getRole(x)!] ? y : x));
    out.push(`${p.role} on ${makeSquare(sq)} attacked by ${pos.board.getRole(cheapest)} on ${makeSquare(cheapest)}`);
  }
  return out;
}

/** Side-to-move pieces that are in danger and have no safe square to go to.
    ponytail: only counts escapes; blocking or adding a defender is not considered. */
export function trapped(pos: Position): Square[] {
  const out: Square[] = [];
  const pieces = pos.board[pos.turn].diff(pos.board.pawn).diff(pos.board.king);
  for (const sq of pieces) {
    if (!inDanger(pos, sq)) continue;
    const value = VALUE[pos.board.getRole(sq)!];
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

/** What is already on the board before you move: check, loose pieces, pins. */
function positionBefore(pos: Position): PositionBefore {
  const checkers = [...pos.ctx().checkers].map(s => `${pos.board.getRole(s)} on ${makeSquare(s)}`);
  const pinned = (color: Color) => orNull(pins(pos, color).map(p => `${pinText(pos, p)}, by ${pos.board.getRole(p.pinner)} on ${makeSquare(p.pinner)}`));
  return {
    you_are_in_check_from: orNull(checkers),
    your_pieces_in_danger: orNull(loosePieces(pos, pos.turn)),
    opponent_pieces_you_can_win: orNull(loosePieces(pos, opposite(pos.turn))),
    your_pinned_pieces: pinned(pos.turn),
    opponent_pinned_pieces: pinned(opposite(pos.turn)),
  };
}

/** `pos` after the side to move passes (a null move); null when that is not a legal position. */
function passed(pos: Position): Chess | null {
  const setup = pos.toSetup();
  setup.turn = opposite(setup.turn);
  setup.epSquare = undefined;
  const p = Chess.fromSetup(setup);
  return p.isErr ? null : p.value;
}

/** The opponent's best move if you could pass (null move), when it would gain at least `min` centipawns.
    `scoreNow` is the current eval from the side to move. Returns [threat UCI, facts, centipawns it gains] or [null, null]. */
async function opponentThreat(sf: UciLink, pos: Position, nodes: number, scoreNow: Score, min = 100): Promise<[string, ThreatFacts, number] | [null, null]> {
  const p = !pos.isCheck() && passed(pos);
  if (!p) return [null, null];
  const { score, pv } = (await search(sf, p, nodes))[0];
  const threatScore = flip(score); // back to your side
  if (!pv.length || cpOf(scoreNow) - cpOf(threatScore) < min) return [null, null];
  return [pv[0], { move: san(p, pv[0]), eval_if_you_could_pass_and_opp_played_it: scoreStr(threatScore) }, cpOf(scoreNow) - cpOf(threatScore)];
}

/** Your move, then the opponent plays the threat at once, then the engine's best play: does your move stop it? */
async function answerToThreat(sf: UciLink, pos: Position, move: string, threat: string, nodes: number): Promise<string> {
  const b = play(pos, move);
  if (!b.isLegal(parseUci(threat)!)) return 'the threat move is no longer legal after your move';
  const { pv } = (await search(sf, play(b, threat), nodes))[0];
  return lineWithEvals(sf, pos, [move, threat, ...pv], nodes, 6);
}

/** The capture or check that your move `mv` sets up (what you would play next if the opponent passed), when playing
    it right away instead is at least a pawn worse than `mv`'s eval `cp`. Returns it with that line, or null.
    That line is the engine's best play, so it may avoid the move the idea is for (Nxg6 Nxg6 h3, not Qxh6) and hide
    the problem: when your next capture or check after `mv` loses a pawn more played at once, its refutation is added. */
async function prepares(sf: UciLink, pos: Position, mv: string, played: string, cp: number, nodes: number): Promise<Prepares | null> {
  const b = play(pos, mv);
  const [tactic, facts] = await opponentThreat(sf, b, nodes, { cp: -cp });
  if (!tactic || tactic === played || !forcing(facts.move) || !pos.isLegal(parseUci(tactic)!)) return null;
  const { score, pv } = (await search(sf, pos, nodes, { moves: [tactic] }))[0];
  if (cpOf(score) > cp - 100) return null;
  const out: Prepares = {
    move: san(pos, tactic), eval_if_played_at_once: scoreStr(score),
    line_if_played_at_once: await lineWithEvals(sf, pos, pv, nodes, 7, pos.turn, true),
    follow_up_fails: null, better_move_guards: null,
  };
  let problem = pv[1];
  const now = pv[1] && play(play(pos, tactic), pv[1]); // the at-once line after the opponent's reply
  const ready = play(passed(b)!, tactic); // the same, but with `mv` played first
  if (now && !now.isEnd() && ready.isLegal(parseUci(pv[1])!)) {
    const next = (await search(sf, play(ready, pv[1]), nodes))[0].pv[0];
    if (next && next !== pv[2] && now.isLegal(parseUci(next)!) && forcing(san(now, next))) {
      const r = (await search(sf, play(now, next), nodes))[0];
      if (r.pv.length && cpOf(flip(r.score)) <= cpOf(score) - 100) {
        out.follow_up_fails = `Why ${moveNo(now)}${san(now, next)} fails: `
          + await lineWithEvals(sf, now, [next, ...r.pv], nodes, 5, pos.turn, true);
        problem = r.pv[0];
      }
    }
  }
  // the piece `mv` moved covers the square the problem move lands on (Rf1 guards f2 against Qxf2+)
  const to = normalMove(mv).to;
  if (problem && attacks(b.board.get(to)!, to, b.board.occupied).has(normalMove(problem).to))
    out.better_move_guards = makeSquare(normalMove(problem).to);
  return out;
}

/** The engine's best move other than `not` (UCI); undefined if there is none. */
async function otherBest(sf: UciLink, pos: Position, not: string | undefined, nodes: number): Promise<string | undefined> {
  const infos = await search(sf, pos, nodes, { multipv: 2 });
  return infos.map(i => i.pv[0]).find(m => m !== not);
}

/** `played` and `vs` are UCI moves; `vs` null means the engine's best other move, and then the higher-scored of the
    two is the sheet's alternative (see factSheet): the build never picks a worse better move itself.
    One move's line runs on `sf` and the other's on `sf2` at the same time. Each engine always gets the
    same searches in the same order, so its hash table carries the same history and the lines stay the same every run.
    When the two moves are about equal the sheet stops at their scores, the only facts their answer needs. */
async function buildFacts({ sf, sf2, sf15 }: Engines, fen: string, played: string | undefined, vs: string | null, nodes = NODES): Promise<FactSheet> {
  const pos = position(fen);
  let [before, other] = await Promise.all([
    search(sf, pos, nodes).then(r => r[0].score),
    vs ?? otherBest(sf2, pos, played, nodes),
  ]);
  const [threat, threatFacts] = await opponentThreat(sf, pos, nodes, before, QUIET_THREAT);
  if (!played || !other) throw new Error('There is only one legal move here: nothing to compare.');
  // each move's own search comes first in its line, as it always has, so the about-equal check costs no extra search
  let [rp, ra] = await Promise.all(([[sf, played], [sf2, other]] satisfies [UciLink, string][]).map(([e, mv]) => search(e, pos, nodes, { moves: [mv] }).then(r => r[0])));
  // the move asked about outscores the best other move: it is the better move, and each move stays on its engine
  let ep = sf, ea = sf2;
  if (!vs && cpOf(ra.score) < cpOf(rp.score)) [played, other, rp, ra, ep, ea] = [other, played, ra, rp, ea, ep];
  const gap = round2((cpOf(ra.score) - cpOf(rp.score)) / 100);
  const side = pos.turn === 'white' ? 'White' : 'Black';
  const scored = (mv: string, { score }: { score: Score }): ScoredMove => ({ move: san(pos, mv), latest_sf_eval: scoreStr(score), cp: cpOf(score) });
  const equal: AboutEqualSheet = { fen, side_to_move: side, played: scored(played, rp), alternative: scored(other, ra), latest_sf_gap: gap };
  if (aboutEqual(equal)) return equal;
  const pushes: Record<string, PawnPush[]> = {}, sides: Record<string, Sf15Terms['sides']> = {};
  const lineNodes = Math.max(Math.floor(nodes / 10), 100_000);
  const line = async (engine: UciLink, mv: string, { score, pv }: PvLine): Promise<SheetLine> => {
    const { leaf, leafSans } = lineToLeaf(pos, pv);
    pushes[mv] = pawnPushes(pos, pv, pos.turn);
    const t: Sf15Terms = leaf ? await sf15Terms(sf15, leaf, pos.turn) : { terms: {}, sides: {} };
    sides[mv] = t.sides;
    const out: SheetLine = {
      ...scored(mv, { score }),
      line_with_evals: await lineWithEvals(engine, pos, pv, lineNodes),
      explained_at_position_after: leafSans.join(' '),
      explained_fen: leaf ? fenOf(leaf) : null,
      notes_at_that_position: leaf ? endNotes(leaf, pos.turn) : null,
      sf15_terms: t.terms,
    };
    if (threat) out.if_opp_plays_the_threat_at_once = await answerToThreat(engine, pos, mv, threat, lineNodes);
    return out;
  };
  const lines: { played?: SheetLine; alternative?: SheetLine } = {};
  let prep!: Prepares | null;
  await Promise.all([
    line(ep, played, rp).then(l => (lines.played = l)),
    line(ea, other, ra).then(async l => {
      prep = await prepares(ea, pos, other, played, l.cp, lineNodes);
      lines.alternative = l;
    }),
  ]);
  const a = lines.alternative!.sf15_terms, p = lines.played!.sf15_terms;
  const diff = Object.keys(a).filter(k => k in p && k !== 'Total').map((k): [string, number] => [k, round2(a[k] - p[k])]);
  const hasTerms = Object.keys(a).length && Object.keys(p).length;
  const leafOf = (l: SheetLine) => (l.explained_fen ? position(l.explained_fen) : null);
  return {
    fen,
    side_to_move: side,
    eval_before_any_move: scoreStr(before),
    position_before_move: positionBefore(pos),
    imbalances: imbalances(pos),
    opponent_threat: threatFacts,
    material_before_any_move: material(pos, pos.turn),
    values_are_from: "side to move's point of view, in pawns",
    played: lines.played!,
    alternative: lines.alternative!,
    latest_sf_gap: gap,
    prepares: prep,
    pawn_plan_only_in_better_line: onlyIn(pushes[other], pushes[played]),
    after_each_line: leafDiff(leafOf(lines.alternative!), leafOf(lines.played!), pos.turn),
    sf15_term_diff_alternative_minus_played: Object.fromEntries(diff.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))),
    sf15_term_diff_by_side: bySide(diff, sides[other], sides[played]),
    sf15_total_gap: hasTerms ? round2((a.Total ?? 0) - (p.Total ?? 0)) : null,
  };
}

/** The two-sided term differences of at least 0.25, split into your side's part and theirs (see sf15Terms), so
    "their king is less safe" is not told as "your king is safer". Null when none. */
function bySide(diff: [string, number][], a: Sf15Terms['sides'], p: Sf15Terms['sides']): Record<string, SideSplit> | null {
  const out = diff.filter(([k, d]) => Math.abs(d) >= 0.25 && a?.[k] && p?.[k])
    .map(([k]) => [k, { yours: round2(a[k].yours - p[k].yours), theirs: round2(a[k].theirs - p[k].theirs) }]);
  return out.length ? Object.fromEntries(out) : null;
}

// ---- the LLM ----

/** One Messages API call: `system`, the fact sheet as the user message. Returns the reply's text. With `onText`, the
    reply is streamed and `onText(text so far)` hears each piece as it is written. */
export async function ask(system: string, facts: object, apiKey: string, model: string, onText?: OnText): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // the key is the user's own, stored in their browser profile
      'anthropic-dangerous-direct-browser-access': 'true',
      // a safety decline is retried on a fallback model
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      output_config: { effort: 'high' },
      fallbacks: 'default',
      ...onText && { stream: true },
      // cached for 5 minutes: a write costs 1.25x input, a read 0.20 $/MTok (Opus 5.5, Fable 5.2), so one call in 5
      // minutes pays the write premium and two or more save. A prompt under 512 tokens is simply not cached.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(facts, null, 1) }],
    }),
    signal: AbortSignal.timeout(120_000),
  }).catch(e => { throw new Error(`Could not reach the Anthropic API (${e.message}).`); });
  // an error status is a plain JSON body, streamed or not
  const body: ApiReply = onText && r.ok ? await streamed(r.body!, onText) : await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error('Anthropic rejected the API key. Check it in the panel settings.');
  if (!r.ok) throw new Error(`Anthropic API error ${r.status}: ${body.error?.message ?? r.statusText}`);
  if (body.stop_reason === 'refusal') return DECLINED;
  if (!body.content) throw new Error('Could not read the reply from the Anthropic API. Try again.');
  return body.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

/** The Messages API reply ask() reads, streamed (see streamed) or not, or an error body. */
interface ApiReply { stop_reason?: string; content?: { type: string; text?: string }[]; error?: { message?: string } }

/** Reads ask()'s server-sent events into the reply as an unstreamed call returns it: {stop_reason, content}. The text
    is every text delta in order, across text blocks: a decline mid-stream adds a fallback block and the fallback model
    goes on, so the text before it stands. An error event, a stream that stops arriving (the timeout) or one cut off
    before its stop reason throws, and the connection is closed. */
async function streamed(stream: ReadableStream<Uint8Array>, onText: OnText): Promise<{ stop_reason: string; content: { type: 'text'; text: string }[] }> {
  const reader = stream.getReader(), utf8 = new TextDecoder();
  let buf = '', text = '', stop_reason: string | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(e => { throw new Error(`The answer stopped arriving (${e.message}). Try again.`); });
      if (done) break;
      buf += utf8.decode(value, { stream: true });
      let end: number;
      while ((end = buf.indexOf('\n\n')) >= 0) { // one event per blank-line-ended block; its JSON is on the data line
        const data = buf.slice(0, end).match(/^data: (.*)$/m)?.[1];
        buf = buf.slice(end + 2);
        const e = data ? JSON.parse(data) : {};
        if (e.type === 'error') throw new Error(`Anthropic API error: ${e.error?.message ?? e.error?.type}`);
        if (e.delta?.type === 'text_delta') onText(text += e.delta.text);
        stop_reason = e.delta?.stop_reason ?? stop_reason;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!stop_reason) throw new Error('The answer was cut off. Try again.');
  return { stop_reason, content: [{ type: 'text', text }] };
}

/** The `llm(system, facts, model, onText)` that request.ts's answer(), planAnswer() and tasks take: ask() with the user's key. */
export const llmWith = (apiKey: string): Llm => (system, facts, model, onText) => ask(system, facts, apiKey, model, onText);

// ---- the fact sheet ----

/** The fact sheet for the compared move `move` (SAN or UCI) in `fen`, against `best` (optional; else the best other
    move). Its `alternative` is the better move: `best` as named, even where it scores lower (the caller owns that
    claim); with no `best`, the higher-scored of `move` and the engine's best other move. So its `played` is `move`,
    unless `move` is itself the better one (it is `best`, or it outscores the best other move): then `played` is the
    best other move, and the sheet says why `move` beats it. The panel,
    the CLI and so the eval all build it here, so they all see the same sheet. `signal` stops the build (see abortable):
    it then rejects with an AbortError once the engines are idle, and the next build's ucinewgame leaves no trace of it. */
export async function factSheet(engines: Engines, fen: string, move: string, best: string | null = null, nodes = NODES, { signal }: { signal?: AbortSignal } = {}): Promise<FactSheet> {
  let pos: Chess;
  try { pos = position(fen); } catch { throw new Error('invalid position'); }
  let played: string | undefined = parseMove(pos, move);
  const vs = best ? parseMove(pos, best) : null;
  const e: Engines & { idle?: () => Promise<PromiseSettledResult<string[]>[]> } = signal ? abortable(engines, signal) : engines;
  try {
    // the hash and history tables carry over from earlier requests: clear them, so the same request gives the same lines
    await Promise.all([e.sf, e.sf2].map(x => x.until(['ucinewgame', 'isready'], l => l === 'readyok')));
    // you played lichess's move: still explain that move, against the best other move
    if (vs === played) played = await otherBest(e.sf, pos, played, nodes);
    return await buildFacts(e, fen, played, vs, nodes);
  } finally {
    await e.idle?.();
  }
}

/** `engines` for one build that `signal` can stop: every command (sf, sf2 and sf15 alike, so every search) first checks
    it, so once it aborts nothing more is sent; the search under way gets `stop` (see uciEngine) and its caller an
    AbortError once its bestmove is in. idle() resolves once every command sent has its answer. */
function abortable(engines: Engines, signal: AbortSignal): Engines & { idle: () => Promise<PromiseSettledResult<string[]>[]> } {
  const out = new Set<Promise<string[]>>();
  const wrap = (e: UciLink): UciLink => ({ until: async (cmds, done) => {
    signal.throwIfAborted();
    const p = e.until(cmds, done, signal);
    out.add(p);
    const lines = await p.finally(() => out.delete(p));
    signal.throwIfAborted();
    return lines;
  } });
  return { sf: wrap(engines.sf), sf2: wrap(engines.sf2), sf15: wrap(engines.sf15), idle: () => Promise.allSettled(out) };
}

/** True when the two moves are too close to explain: the engines' lines differ for reasons too small, and a story
    would only invent one. Such a sheet holds only the two moves' scores (older saved sheets hold everything). */
export function aboutEqual(facts: FactSheet): facts is AboutEqualSheet;
export function aboutEqual(facts: { latest_sf_gap: number }): boolean;
export function aboutEqual(facts: { latest_sf_gap: number }) { return Math.abs(facts.latest_sf_gap) < EQUAL_GAP; }

// ---- a plan for the side to move ----

/** "tactical" when the engine line mates, wins at least a pawn's worth of material by its quiet end, or has to meet a
    threat worth a pawn or more (`threatGain`, centipawns; a smaller one is a plan, such as a pawn push); else "positional". */
function planKind(pos: Position, score: Score, leaf: Position | null, threatGain: number | undefined): PlanKind {
  if ('mate' in score || (threatGain ?? 0) >= 100) return 'tactical';
  return leaf && material(leaf, pos.turn) - material(pos, pos.turn) >= 1 ? 'tactical' : 'positional';
}

/** The plan sheet for the side to move in `fen`: the engine's best move and its line with labels (on sf only; the
    lichess engine need not be on), what is on the board, the threat, and SF 15's terms where the line turns quiet. */
export async function planFacts({ sf, sf2, sf15 }: Engines, fen: string, nodes = NODES): Promise<PlanFacts> {
  let pos: Chess;
  try { pos = position(fen); } catch { throw new Error('invalid position'); }
  if (pos.isEnd()) throw new Error('The game is over here: there is no plan to find.');
  await Promise.all([sf, sf2].map(e => e.until(['ucinewgame', 'isready'], l => l === 'readyok')));
  // the top two moves on sf2, at the same time as the main search: both scores come from one search, so they compare
  const [[{ score, pv }], two] = await Promise.all([search(sf, pos, nodes), search(sf2, pos, nodes, { multipv: 2 })]);
  const [, threat, threatGain] = await opponentThreat(sf, pos, nodes, score, QUIET_THREAT);
  const { leaf, leafSans } = lineToLeaf(pos, pv);
  const terms = leaf ? (await sf15Terms(sf15, leaf, pos.turn)).terms : {};
  // on the two evals the panel shows side by side; at 0.3 (EQUAL_GAP) it fired on 43% of book positions
  const other = two.find(i => i.pv[0] && i.pv[0] !== pv[0]);
  const close = other && !('mate' in score) && !('mate' in other.score) && Math.abs(score.cp - other.score.cp) / 100 < ALSO_GAP;
  return {
    fen,
    side_to_move: pos.turn === 'white' ? 'White' : 'Black',
    plan_kind: planKind(pos, score, leaf, threatGain),
    position_before_move: positionBefore(pos),
    imbalances: imbalances(pos),
    opponent_threat: threat,
    material_before_any_move: material(pos, pos.turn),
    values_are_from: "side to move's point of view, in pawns",
    best: {
      move: san(pos, pv[0]),
      latest_sf_eval: scoreStr(score),
      line_with_evals: await lineWithEvals(sf, pos, pv, Math.max(Math.floor(nodes / 10), 100_000)),
      explained_at_position_after: leafSans.join(' '),
      explained_fen: leaf ? fenOf(leaf) : null,
      notes_at_that_position: leaf ? endNotes(leaf, pos.turn) : null,
      sf15_terms: terms,
    },
    // ponytail: 8 plies, enough for one sentence on what the move does; longer lines invite claims
    also_good: close ? {
      move: san(pos, other.pv[0]),
      latest_sf_eval: scoreStr(other.score),
      line_with_evals: await lineWithEvals(sf, pos, other.pv, Math.max(Math.floor(nodes / 10), 100_000), 8),
    } : null,
    pawn_pushes_in_line: orNull(pawnPushes(pos, pv, pos.turn).filter(p => p.point).map(p => p.text)),
  };
}
