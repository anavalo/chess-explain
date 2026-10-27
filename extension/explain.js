// Explain why one chess move is better than another.
//
// Stockfish 19 decides WHICH move is better (eval + main line).
// Stockfish 15's hand-crafted eval explains WHY (term-by-term diff a few moves into each line).
// An LLM turns those numbers into plain language.
//
// Runs in the side panel (engines in Web Workers) and in node (engines as child processes):
//   node extension/explain.js FEN MOVE [--vs MOVE] [--nodes N] [--no-llm] [--model ID]

import {
  Chess, SquareSet, attacks, castlingSide, kingCastlesTo, makeFen, makeSan, makeSquare, makeUci, opposite, parseFen,
  parseSan, parseUci, pawnAttacks, squareFile, squareRank,
} from './vendor/chessops.js';

const NODES = 2_000_000;
const THREADS = 1; // one search thread: a node-limited search then gives the same lines every run
const EQUAL_GAP = 0.3; // pawns; below this both moves are called equal and the LLM is skipped
const LEAF_PLIES = 6; // SF 15 terms are measured within this many plies of each line
// centipawns the opponent must gain with a free move before the position's threat is reported. A free move is worth
// a tempo (up to ~0.5) anyway; above that it is a plan, such as a g4-g5 pawn storm.
const QUIET_THREAT = 50;

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

/** Starts the engines with `start(path)` (path relative to this file), which returns a uciEngine: two copies of the
    latest Stockfish (one per candidate line, so the two lines are searched at the same time) and SF 15 for its terms.
    The WASM builds drop input that arrives before they have loaded, so nothing else is sent until uciok. */
export async function startEngines(start) {
  const setup = async (e, options) => {
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
export async function search(sf, pos, nodes, { moves, multipv = 1 } = {}) {
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

export const position = fen => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
export const fenOf = pos => makeFen(pos.toSetup());
export const play = (pos, uci) => { const p = pos.clone(); p.play(parseUci(uci)); return p; };
export const san = (pos, uci) => makeSan(pos, parseUci(uci));
const moveNo = pos => `${pos.fullmoves}${pos.turn === 'white' ? '.' : '...'}`; // '12.' for White, '12...' for Black

/** SAN or UCI -> UCI as engines write it: castling is the king's two-square move (chessops plays it as king takes rook). */
function parseMove(pos, text) {
  const mv = parseSan(pos, text) ?? parseUci(text);
  if (!mv || !pos.isLegal(mv)) throw new Error(`${text} is not a legal move here`);
  const side = castlingSide(pos, mv);
  return makeUci(side ? { from: mv.from, to: kingCastlesTo(pos.turn, side) } : mv);
}

/** SAN moves played one after another from `fen` -> the same moves in UCI, as engines write them. */
export function sanToUci(fen, sans) {
  let pos = position(fen);
  return sans.map(s => {
    const uci = parseMove(pos, s);
    pos = play(pos, uci);
    return uci;
  });
}

const isEnPassant = (pos, mv) => pos.board.getRole(mv.from) === 'pawn' && mv.to === pos.epSquare;
const isCapture = (pos, mv) => pos.board.getColor(mv.to) === opposite(pos.turn) || isEnPassant(pos, mv);
const attackers = (pos, color, sq) => pos.kingAttackers(sq, color, pos.board.occupied);
const signed = n => (n >= 0 ? `+${n}` : `${n}`);
const round2 = x => Math.round(x * 100) / 100;

export function scoreStr(s) {
  if ('mate' in s) return s.mate > 0 ? `mates in ${s.mate}` : `gets mated in ${-s.mate}`;
  return `${s.cp >= 0 ? '+' : ''}${(s.cp / 100).toFixed(2)}`;
}
const flip = s => ('mate' in s ? { mate: -s.mate } : { cp: -s.cp });
export const pov = (s, pos, color) => (pos.turn === color ? s : flip(s)); // `s` is from pos's side to move
const cpOf = s => ('mate' in s ? (s.mate > 0 ? 10000 - s.mate : -10000 - s.mate) : s.cp);

/** Play the first LEAF_PLIES of the engine line and stop at the last quiet position (no check, last move not
    a capture), so the static eval is not taken in the middle of an exchange. Kept short: the first moves of a
    line are the most reliable, and they are the ones the answer quotes. */
function lineToLeaf(pos, pv) {
  let b = pos, quiet = null, calm = null;
  const sans = [];
  for (const uci of pv.slice(0, LEAF_PLIES)) {
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
    ponytail: direct attacks only; discovered attacks are not labelled. */
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

/** Pins against `color`: an enemy bishop, rook or queen attacks a `color` piece, and behind it stands the king,
    or a more valuable piece the pinner could win (worth more than the pinner, or undefended).
    Returns [{pinner, pinned, behind}] (squares).
    ponytail: skewers (the more valuable piece in front) are not reported. */
export function pins(pos, color) {
  const out = [], b = pos.board, occ = b.occupied;
  for (const pinner of b[opposite(color)].intersect(b.bishop.union(b.rook).union(b.queen))) {
    const slider = b.get(pinner), seen = attacks(slider, pinner, occ);
    for (const pinned of seen.intersect(b[color]).diff(b.king)) {
      if (attacks(b.get(pinned), pinned, occ).has(pinner)) continue; // it can just take the pinner
      // removing the pinned piece only extends the line through it: whatever is newly attacked stands behind it
      const behind = attacks(slider, pinner, occ.without(pinned)).diff(seen).intersect(b[color]).first();
      if (behind === undefined) continue;
      const v = VALUE[b.getRole(behind)];
      if (v > VALUE[b.getRole(pinned)] && (v > VALUE[slider.role] || attackers(pos, color, behind).isEmpty()))
        out.push({ pinner, pinned, behind });
    }
  }
  return out;
}

const pinText = (pos, { pinned, behind }) =>
  `${pos.board.getRole(pinned)} on ${makeSquare(pinned)} to ${pos.board.getRole(behind)} on ${makeSquare(behind)}`;

const LIGHT = SquareSet.lightSquares(), DARK = SquareSet.darkSquares();
const CENTRE_FILES = [2, 3, 4, 5].map(f => SquareSet.fromFile(f)).reduce((a, b) => a.union(b)); // c-f
const ahead = (color, sq) => (color === 'white' ? sq + 8 : sq - 8);
const sameColour = sq => (LIGHT.has(sq) ? LIGHT : DARK);

function hasBishopPair(board, color) {
  const bishops = board.bishop.intersect(board[color]);
  return bishops.intersects(LIGHT) && bishops.intersects(DARK);
}

/** A square on `color`'s 4th-6th rank, protected by a `color` pawn, that no enemy pawn can ever attack.
    ponytail: an enemy pawn that is blocked still counts as able to attack it. */
export function isOutpost(board, sq, color) {
  const r = squareRank(sq), rel = color === 'white' ? r : 7 - r;
  if (rel < 3 || rel > 5 || !pawnAttacks(opposite(color), sq).intersects(board.pawn.intersect(board[color]))) return false;
  for (const p of board.pawn.intersect(board[opposite(color)]))
    if (Math.abs(squareFile(p) - squareFile(sq)) === 1 && (color === 'white' ? squareRank(p) > r : squareRank(p) < r)) return false;
  return true;
}

/** Empty outposts for `color`: holes in the enemy pawns that a `color` knight or bishop could take. Only next to an
    enemy pawn that has gone past it; with no enemy pawn near, every pawn-protected square would count.
    ponytail: c-f files only, where a piece there matters most; add the wings if answers miss a g5/b5 hole. */
function outpostSquares(board, color) {
  const out = new Set(), theirs = board.pawn.intersect(board[opposite(color)]);
  for (const sq of CENTRE_FILES.diff(board[color]).diff(board.pawn)) {
    const f = squareFile(sq), sides = SquareSet.fromFile(f - 1).union(SquareSet.fromFile(f + 1));
    if (theirs.intersects(sides) && isOutpost(board, sq, color)) out.add(`outpost square ${makeSquare(sq)}`);
  }
  return out;
}

/** `color`'s isolated, doubled and backward pawns, as SF 15 defines them (src/pawns.cpp). */
export function pawnWeaknesses(board, color) {
  const own = board.pawn.intersect(board[color]), theirs = board.pawn.diff(own), out = new Set();
  for (const p of own) {
    const f = squareFile(p), file = SquareSet.fromFile(f), name = 'abcdefgh'[f];
    const neighbours = own.intersect(SquareSet.fromFile(Math.max(f - 1, 0)).union(SquareSet.fromFile(Math.min(f + 1, 7)))).diff(file);
    if (own.intersect(file).size() > 1) out.add(`${name}-pawns doubled`);
    if (neighbours.isEmpty()) { out.add(`${name}-pawn isolated`); continue; }
    // behind all its neighbours, and the square in front is blocked or attacked by an enemy pawn
    const behind = [...neighbours].every(n => (color === 'white' ? squareRank(n) > squareRank(p) : squareRank(n) < squareRank(p)));
    const up = ahead(color, p);
    if (behind && (theirs.has(up) || pawnAttacks(color, up).intersects(theirs))) out.add(`pawn on ${makeSquare(p)} backward`);
  }
  return out;
}

/** `color`'s passed pawns: no enemy pawn ahead of it on its own or a neighbouring file. */
function passedPawns(board, color) {
  const own = board.pawn.intersect(board[color]), theirs = board.pawn.diff(own), out = new Set();
  for (const p of own) {
    const f = squareFile(p), r = squareRank(p);
    if (![...theirs].some(t => Math.abs(squareFile(t) - f) <= 1 && (color === 'white' ? squareRank(t) > r : squareRank(t) < r)))
      out.add(`passed ${'abcdefgh'[f]}-pawn`);
  }
  return out;
}

/** Holes in the pawn shield of `color`'s castled king (on its back rank, not on the d/e-file): files next to
    the king with no own pawn on the 2nd or 3rd rank. Files as in SF 15's shelter (king file kept within b-g). */
function shieldHoles(board, color) {
  const out = new Set(), k = board.kingOf(color), back = color === 'white' ? 0 : 7;
  if (k === undefined || squareRank(k) !== back || squareFile(k) === 3 || squareFile(k) === 4) return out;
  const own = [...board.pawn.intersect(board[color])], c = Math.min(Math.max(squareFile(k), 1), 6);
  for (let f = c - 1; f <= c + 1; f++)
    if (!own.some(p => squareFile(p) === f && Math.abs(squareRank(p) - back) <= 2)) out.add(`king shield lost its ${'abcdefgh'[f]}-pawn`);
  return out;
}

/** `color`'s king is still on the d-f files while the enemy has its queen and two more pieces, and the enemy king has
    left the centre, or `color` can no longer castle and the d- or e-file has at most one pawn (the centre is open). */
function kingInCentre(pos, color) {
  const b = pos.board, them = b[opposite(color)], central = sq => sq !== undefined && squareFile(sq) >= 3 && squareFile(sq) <= 5;
  if (!central(b.kingOf(color)) || !them.intersects(b.queen) || them.diff(b.pawn).diff(b.king).size() < 3) return false;
  if (!central(b.kingOf(opposite(color)))) return true;
  const canCastle = pos.castles.castlingRights.intersects(SquareSet.fromRank(color === 'white' ? 0 : 7));
  return !canCastle && [3, 4].some(f => b.pawn.intersect(SquareSet.fromFile(f)).size() <= 1);
}

/** 'open' or 'semi-open' (no `color` pawn) for a rook on `sq`'s file, else null. */
function rookFile(board, sq, color) {
  const pawns = board.pawn.intersect(SquareSet.fromFile(squareFile(sq)));
  return pawns.isEmpty() ? 'open' : pawns.intersects(board[color]) ? null : 'semi-open';
}

/** Silman's imbalances: what already differs on the board before any move, for the side to move ("yours"), the
    opponent, and both. ponytail: structure only; space, development and initiative are left to the SF 15 terms. */
export function imbalances(pos, you = pos.turn) {
  const b = pos.board, them = opposite(you);
  const side = color => {
    const out = new Set(); // a Set: two rooks on one open file are one label
    if (hasBishopPair(b, color) && !hasBishopPair(b, opposite(color))) out.add('bishop pair');
    for (const sq of b[color].intersect(b.knight.union(b.bishop)))
      if (isOutpost(b, sq, color)) out.add(`${b.getRole(sq)} on outpost ${makeSquare(sq)}`);
    for (const sq of b[color].intersect(b.rook)) {
      const file = rookFile(b, sq, color);
      if (file) out.add(`rook on ${file} ${'abcdefgh'[squareFile(sq)]}-file`);
    }
    for (const features of [passedPawns, pawnWeaknesses, shieldHoles, outpostSquares]) features(b, color).forEach(f => out.add(f));
    if (kingInCentre(pos, color)) out.add('king still in the centre');
    return out.size ? [...out] : null;
  };
  // pieces one side has more of than the other: "your bishop for opp's knight", "opp's extra rook"
  const extra = (c, d) => ['queen', 'rook', 'bishop', 'knight'].flatMap(r =>
    Array(Math.max(0, b[r].intersect(b[c]).size() - b[r].intersect(b[d]).size())).fill(r)).join(' and ');
  const mine = extra(you, them), theirs = extra(them, you);
  const pieces = mine && theirs ? `your ${mine} for opp's ${theirs}` : mine ? `your extra ${mine}` : theirs && `opp's extra ${theirs}`;
  const both = [...pieces ? [`piece imbalance: ${pieces}`] : [], ...endNotes(pos, you) ?? []];
  return { yours: side(you), opponents: side(them), both: both.length ? both : null };
}

/** The pieces `you` and the opponent still have, as 'you: Q R R B N, opp: Q R B B N'. */
function piecesLeft(board, you) {
  const letters = { queen: 'Q', rook: 'R', bishop: 'B', knight: 'N' };
  const of = color => ['queen', 'rook', 'bishop', 'knight'].flatMap(r => Array(board[r].intersect(board[color]).size()).fill(letters[r])).join(' ') || 'no pieces';
  return `you: ${of(you)}, opp: ${of(opposite(you))}`;
}

/** What stands at the end of one line but not the other: the imbalance labels at each leaf (from `you`'s view),
    the pieces left, and the labels only one leaf has. A trade, an outpost taken or a pawn made weak inside a
    line shows up here, where the root "imbalances" cannot see it. */
export function leafDiff(leafA, leafP, you) {
  if (!leafA || !leafP) return null;
  const flat = pos => {
    const i = imbalances(pos, you);
    return [...(i.yours ?? []).map(l => `your ${l}`), ...(i.opponents ?? []).map(l => `opp's ${l}`), ...i.both ?? []];
  };
  const a = flat(leafA), p = flat(leafP);
  const only = (x, y) => { const d = x.filter(l => !y.includes(l)); return d.length ? d : null; };
  return {
    pieces_left: { alternative: piecesLeft(leafA.board, you), played: piecesLeft(leafP.board, you) },
    only_after_alternative: only(a, p),
    only_after_played: only(p, a),
  };
}

/** Positional labels for move `uci` from `b` to `next`; `you` is the side the explanation is for. */
export function moveLabels(b, next, uci, you) {
  const mv = parseUci(uci), role = b.board.getRole(mv.from), victim = b.board.getRole(mv.to);
  const owner = color => (color === you ? 'your' : "opp's"), labels = [];
  // SF 15's Space term only counts squares behind your own pawns, so it hardly sees a pawn pushed forward
  const rank = squareRank(mv.to) + 1;
  if (role === 'pawn' && !isCapture(b, mv) && (b.turn === 'white' ? rank >= 4 : rank <= 5)) labels.push('pawn gains space');
  if ((role === 'knight' || role === 'bishop') && isOutpost(next.board, mv.to, b.turn)) labels.push(`${role} on outpost ${makeSquare(mv.to)}`);
  const them = opposite(b.turn);
  if (role === 'rook' && squareFile(mv.from) !== squareFile(mv.to)) {
    const file = rookFile(next.board, mv.to, b.turn);
    if (file) labels.push(`rook on ${file} file`);
  }
  // the 7th only counts with enemy pawns to attack there or the enemy king held on its back rank
  const seventh = b.turn === 'white' ? 6 : 1;
  if (role === 'rook' && squareRank(mv.to) === seventh && squareRank(mv.from) !== seventh
    && (next.board.pawn.intersect(next.board[them]).intersects(SquareSet.fromRank(seventh))
      || squareRank(next.board.kingOf(them)) === (b.turn === 'white' ? 7 : 0)))
    labels.push('rook on 7th rank');
  if (hasBishopPair(b.board, them) && !hasBishopPair(next.board, them)) labels.push(`${owner(them)} bishop pair gone`);
  if (role === 'pawn' || victim === 'pawn' || isEnPassant(b, mv)) {
    // a pawn that moves or is taken opens or closes diagonals: name bishops (other than the mover) that gain or lose 3+ squares
    const reach = (pos, sq) => attacks(pos.board.get(sq), sq, pos.board.occupied).diff(pos.board[pos.board.getColor(sq)]).size();
    for (const sq of b.board.bishop.intersect(next.board.bishop).without(mv.from)) {
      if (b.board.getColor(sq) !== next.board.getColor(sq)) continue;
      const d = reach(next, sq) - reach(b, sq), whose = owner(b.board.getColor(sq));
      if (d >= 3) labels.push(`frees ${whose} bishop on ${makeSquare(sq)} (+${d} squares)`);
      if (d <= -3) labels.push(`shuts in ${whose} bishop on ${makeSquare(sq)} (${d} squares)`);
    }
    for (const color of [b.turn, them])
      for (const features of [pawnWeaknesses, passedPawns, shieldHoles, outpostSquares]) {
        const before = features(b.board, color);
        for (const w of features(next.board, color)) if (!before.has(w)) labels.push(`${owner(color)} ${w}`);
      }
  }
  return labels;
}

/** Facts about the position at the end of a line: opposite-coloured bishops and bad bishops
    (at least two own centre pawns on the bishop's colour, each blocked by an enemy pawn). */
export function endNotes(pos, you) {
  const b = pos.board, notes = [];
  const w = b.bishop.intersect(b.white), k = b.bishop.intersect(b.black);
  if (w.size() === 1 && k.size() === 1 && w.intersects(LIGHT) !== k.intersects(LIGHT)) notes.push('opposite-coloured bishops');
  for (const sq of b.bishop) {
    const color = b.getColor(sq), owner = color === you ? 'your' : "opp's";
    const fixed = [...b.pawn.intersect(b[color]).intersect(sameColour(sq)).intersect(CENTRE_FILES)]
      .filter(p => b.pawn.intersect(b[opposite(color)]).has(ahead(color, p)));
    if (fixed.length >= 2)
      notes.push(`${owner} bishop on ${makeSquare(sq)} is bad: ${owner} pawns on ${fixed.map(makeSquare).join(', ')} are fixed on its colour`);
  }
  return notes.length ? notes : null;
}

/** '12. you Bc3 (-7.52) 12... opp Bb4 (-7.50) 13. you Bd2 (-7.68) 13... opp Qxa1 [takes rook, material -5] (-7.38) ...':
    Stockfish 19's eval after every move, from `you`'s view, for `maxPlies` plies and then on until an exchange is over.
    A skipped recapture that loses is played out on its own line below. `nested` is set for those lines, so they do not branch again. */
export async function lineWithEvals(sf, pos, pv, nodes, maxPlies = 20, you = pos.turn, nested = false) {
  let b = pos, captured = false;
  const out = [], why = [], seenTrapped = new Set();
  for (const [i, uci] of pv.entries()) {
    if (i >= maxPlies && !captured) break; // past the limit, play on only to finish an exchange
    const mv = parseUci(uci);
    const who = b.turn === you ? 'you' : 'opp';
    let text = `${moveNo(b)} ${who} ${san(b, uci)}`;
    const labels = [];
    captured = isCapture(b, mv);
    if (captured) labels.push(`takes ${isEnPassant(b, mv) ? 'pawn' : b.board.getRole(mv.to)}`);
    const before = attacks(b.board.get(mv.from), mv.from, b.board.occupied);
    const pinsBefore = new Set(pins(b, opposite(b.turn)).map(p => `${p.pinner} ${p.pinned}`));
    const prev = b;
    b = play(b, uci);
    if (b.isCheck()) labels.push('check');
    const owner = who === 'you' ? "opp's" : 'your';
    labels.push(...threats(b, mv.to, before, owner));
    // new pins, by the moved piece or by a line it opened
    for (const p of pins(b, b.turn)) if (!pinsBefore.has(`${p.pinner} ${p.pinned}`)) labels.push(`pins ${owner} ${pinText(b, p)}`);
    if (captured) labels.push(`material ${signed(material(b, you))}`);
    labels.push(...moveLabels(prev, b, uci, you));
    for (const sq of trapped(b)) {
      if (seenTrapped.has(sq)) continue;
      labels.push(`${owner} ${b.board.getRole(sq)} on ${makeSquare(sq)} is trapped`);
      seenTrapped.add(sq);
    }
    let ev;
    if (b.isCheckmate()) ev = 'checkmate';
    else if (b.isEnd()) ev = 'draw';
    else {
      const { score } = (await search(sf, b, nodes))[0];
      ev = scoreStr(pov(score, b, you));
      // what the mover would play next if the other side passed: catches batteries, discovered attacks, mate threats
      const [, threat] = await opponentThreat(sf, b, nodes, score);
      if (threat && /[x+#]/.test(threat.move)) labels.push(`threatens ${threat.move}`); // quiet threats are mostly noise mid-line
      const next = pv[i + 1] && parseUci(pv[i + 1]);
      const failed = captured && !nested && next && next.to !== mv.to && await failedRecapture(sf, b, mv.to, score, nodes);
      if (failed) {
        const rec = `${moveNo(b)}${san(b, failed[0])}`;
        labels.push(`${b.turn === you ? 'your' : "opp's"} recapture ${rec} fails (line below)`);
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
async function failedRecapture(sf, b, sq, score, nodes) {
  let from;
  for (const s of b.board[b.turn])
    if (b.dests(s).has(sq) && (from === undefined || VALUE[b.board.getRole(s)] < VALUE[b.board.getRole(from)])) from = s;
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

/** What is already on the board before you move: check, loose pieces, pins. */
export function positionBefore(pos) {
  const checkers = [...pos.ctx().checkers].map(s => `${pos.board.getRole(s)} on ${makeSquare(s)}`);
  const or = list => (list.length ? list : null);
  const pinned = color => or(pins(pos, color).map(p => `${pinText(pos, p)}, by ${pos.board.getRole(p.pinner)} on ${makeSquare(p.pinner)}`));
  return {
    you_are_in_check_from: or(checkers),
    your_pieces_in_danger: or(loosePieces(pos, pos.turn)),
    opponent_pieces_you_can_win: or(loosePieces(pos, opposite(pos.turn))),
    your_pinned_pieces: pinned(pos.turn),
    opponent_pinned_pieces: pinned(opposite(pos.turn)),
  };
}

/** `pos` after the side to move passes (a null move); null when that is not a legal position. */
function passed(pos) {
  const setup = pos.toSetup();
  setup.turn = opposite(setup.turn);
  setup.epSquare = undefined;
  const p = Chess.fromSetup(setup);
  return p.isErr ? null : p.value;
}

/** The opponent's best move if you could pass (null move), when it would gain at least `min` centipawns.
    `scoreNow` is the current eval from the side to move. Returns [threat UCI, facts] or [null, null]. */
export async function opponentThreat(sf, pos, nodes, scoreNow, min = 100) {
  const p = !pos.isCheck() && passed(pos);
  if (!p) return [null, null];
  const { score, pv } = (await search(sf, p, nodes))[0];
  const threatScore = flip(score); // back to your side
  if (!pv.length || cpOf(scoreNow) - cpOf(threatScore) < min) return [null, null];
  return [pv[0], { move: san(p, pv[0]), eval_if_you_could_pass_and_opp_played_it: scoreStr(threatScore) }];
}

/** Your move, then the opponent plays the threat at once, then the engine's best play: does your move stop it? */
async function answerToThreat(sf, pos, move, threat, nodes) {
  const b = play(pos, move);
  if (!b.isLegal(parseUci(threat))) return 'the threat move is no longer legal after your move';
  const { pv } = (await search(sf, play(b, threat), nodes))[0];
  return lineWithEvals(sf, pos, [move, threat, ...pv], nodes, 6);
}

/** The capture or check that your move `mv` sets up (what you would play next if the opponent passed), when playing
    it right away instead is at least a pawn worse than `mv`'s eval `cp`. Returns it with that line, or null.
    That line is the engine's best play, so it may avoid the move the idea is for (Nxg6 Nxg6 h3, not Qxh6) and hide
    the problem: when your next capture or check after `mv` loses a pawn more played at once, its refutation is added. */
async function prepares(sf, pos, mv, played, cp, nodes) {
  const b = play(pos, mv);
  const [tactic, facts] = await opponentThreat(sf, b, nodes, { cp: -cp });
  if (!tactic || tactic === played || !/[x+#]/.test(facts.move) || !pos.isLegal(parseUci(tactic))) return null;
  const { score, pv } = (await search(sf, pos, nodes, { moves: [tactic] }))[0];
  if (cpOf(score) > cp - 100) return null;
  const out = {
    move: san(pos, tactic), eval_if_played_at_once: scoreStr(score),
    line_if_played_at_once: await lineWithEvals(sf, pos, pv, nodes, 7, pos.turn, true),
    follow_up_fails: null, better_move_guards: null,
  };
  let problem = pv[1];
  const now = pv[1] && play(play(pos, tactic), pv[1]); // the at-once line after the opponent's reply
  const ready = play(passed(b), tactic); // the same, but with `mv` played first
  if (now && !now.isEnd() && ready.isLegal(parseUci(pv[1]))) {
    const next = (await search(sf, play(ready, pv[1]), nodes))[0].pv[0];
    if (next && next !== pv[2] && now.isLegal(parseUci(next)) && /[x+#]/.test(san(now, next))) {
      const r = (await search(sf, play(now, next), nodes))[0];
      if (r.pv.length && cpOf(flip(r.score)) <= cpOf(score) - 100) {
        out.follow_up_fails = `Why ${moveNo(now)}${san(now, next)} fails: `
          + await lineWithEvals(sf, now, [next, ...r.pv], nodes, 5, pos.turn, true);
        problem = r.pv[0];
      }
    }
  }
  // the piece `mv` moved covers the square the problem move lands on (Rf1 guards f2 against Qxf2+)
  const to = parseUci(mv).to;
  if (problem && attacks(b.board.get(to), to, b.board.occupied).has(parseUci(problem).to))
    out.better_move_guards = makeSquare(parseUci(problem).to);
  return out;
}

/** The engine's best move other than `not` (UCI); undefined if there is none. */
async function otherBest(sf, pos, not, nodes) {
  const infos = await search(sf, pos, nodes, { multipv: 2 });
  return infos.map(i => i.pv[0]).find(m => m !== not);
}

/** `played` and `vs` are UCI moves; `vs` null means the engine's best other move.
    The played move's line runs on `sf` and the alternative's on `sf2` at the same time. Each engine always gets the
    same searches in the same order, so its hash table carries the same history and the lines stay the same every run. */
async function buildFacts({ sf, sf2, sf15 }, fen, played, vs, nodes = NODES) {
  const pos = position(fen);
  const [before, other] = await Promise.all([
    search(sf, pos, nodes).then(r => r[0].score),
    vs ?? otherBest(sf2, pos, played, nodes),
  ]);
  const [threat, threatFacts] = await opponentThreat(sf, pos, nodes, before, QUIET_THREAT);
  if (!played || !other) throw new Error('There is only one legal move here: nothing to compare.');
  const lineNodes = Math.max(Math.floor(nodes / 10), 100_000);
  const line = async (engine, mv) => {
    const { score, pv } = (await search(engine, pos, nodes, { moves: [mv] }))[0];
    const { leaf, leafSans } = lineToLeaf(pos, pv);
    const out = {
      move: san(pos, mv), latest_sf_eval: scoreStr(score), cp: cpOf(score),
      line_with_evals: await lineWithEvals(engine, pos, pv, lineNodes),
      explained_at_position_after: leafSans.join(' '),
      explained_fen: leaf ? fenOf(leaf) : null,
      notes_at_that_position: leaf ? endNotes(leaf, pos.turn) : null,
      sf15_terms: leaf ? await sf15Terms(sf15, leaf, pos.turn) : {},
    };
    if (threat) out.if_opp_plays_the_threat_at_once = await answerToThreat(engine, pos, mv, threat, lineNodes);
    return out;
  };
  const lines = {};
  await Promise.all([
    line(sf, played).then(l => (lines.played = l)),
    line(sf2, other).then(async l => {
      l.prepares = await prepares(sf2, pos, other, played, l.cp, lineNodes);
      lines.alternative = l;
    }),
  ]);
  const a = lines.alternative.sf15_terms, p = lines.played.sf15_terms;
  const diff = Object.keys(a).filter(k => k in p && k !== 'Total').map(k => [k, round2(a[k] - p[k])]);
  const hasTerms = Object.keys(a).length && Object.keys(p).length;
  const leafOf = l => l.explained_fen && position(l.explained_fen);
  return {
    fen,
    side_to_move: pos.turn === 'white' ? 'White' : 'Black',
    eval_before_any_move: scoreStr(before),
    position_before_move: positionBefore(pos),
    imbalances: imbalances(pos),
    opponent_threat: threatFacts,
    material_before_any_move: material(pos, pos.turn),
    values_are_from: "side to move's point of view, in pawns",
    played: lines.played,
    alternative: lines.alternative,
    latest_sf_gap: round2((lines.alternative.cp - lines.played.cp) / 100),
    after_each_line: leafDiff(leafOf(lines.alternative), leafOf(lines.played), pos.turn),
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
  "<side> recapture 2.gxf3 fails (line below)" means the captured piece was defended, but taking back loses: the line after
  "Why 2.gxf3 fails:" plays it out. Explain from its labels what goes wrong (for example the threat it allows) and show its first
  moves. Never call a piece undefended, lost for free or a free shot unless the facts say it is undefended.
  Labels "check", "attacks your|opp's <piece> on <square>" and "threatens <move>" (what that side would play next if allowed) mark threats.
  "pins your|opp's <piece> on <square> to <piece> on <square>" means the first piece cannot move without exposing the second
  (to the king it cannot legally move at all), so it also cannot defend or recapture.
  "pawn gains space" marks a pawn pushed to its 4th rank or beyond; several on one wing are a pawn storm. The SF 15 "Space" term
  hardly counts these, so name the space gain from the labels even when that term is small.
  Structure labels: "<knight|bishop> on outpost <square>" (a pawn-protected square on the 4th-6th rank that no enemy pawn can attack),
  "rook on open|semi-open file", "<side> bishop pair gone", "<side> <file>-pawn isolated", "<side> <file>-pawns doubled",
  "<side> pawn on <square> backward" (behind its neighbours, cannot safely advance), "<side> passed <file>-pawn" (no enemy pawn
  can stop it, SF 15 counts it in Passed), "<side> king shield lost its <file>-pawn" (a pawn in front of the castled king moved
  away or was taken, SF 15 counts it in King safety), "rook on 7th rank" (attacks pawns there or holds the king on its back rank),
  "<side> outpost square <square>" (a pawn move just made that empty square an outpost for that side: no enemy pawn can
  ever attack it again, so a knight or bishop can settle there; the pawn move weakened it for the other side),
  "frees|shuts in <side> bishop on <square> (+|-N squares)" (that move opened or closed the bishop's diagonals; freeing
  your own bad bishop or shutting in the enemy's good one is often the point of a pawn break or a pawn capture).
  They often explain a terms difference.
  "<piece> is trapped" means that piece is attacked and every
  square it can go to is unsafe: if a trapped piece is later captured, explain the trap (which moves attacked it and took
  away its squares), not just the capture. Describe threats, attacks and defences only from
  these labels; do not work out board geometry yourself.
- "position_before_move" lists what was already on the board: a check you had to answer, your pieces in danger,
  opponent pieces you could win, and pinned pieces on both sides. A blunder often ignores one of these: say so first when it applies.
  If "you_are_in_check_from" is set, your first sentence must say you were in check and from which piece,
  and that every legal move had to answer that check. If it is null, do not mention check at all.
- "imbalances" lists what already differs on the board before any move: "yours", "opponents" and "both" (bishop pair,
  outposts, empty "outpost square"s (holes in the enemy pawns that side's pieces can use), rooks on open files, passed
  and weak pawns, holes in the king shield, bad or opposite-coloured bishops, different pieces, a "king still in the
  centre" (not castled, with the enemy queen and pieces on, and the centre open or the enemy king safe)). Unless you
  were in check, your first sentence (at most 20 words) sums up the position from the one or two imbalances that matter
  most and what each side wants from them (a weak pawn is a target, a passed pawn wants to advance, the bishop pair
  wants open lines, a bad bishop wants to be traded or to get outside its pawns while the other side keeps it shut in,
  a king in the centre wants to castle while the other side opens the centre with pawn breaks and exchanges first).
  Use only these labels; if all three are null, skip that sentence. The rules below that say what to lead with apply
  to the explanation that follows it.
- "opponent_threat" (when not null) is what the opponent would play if you could pass a move, and the eval it would reach.
  For each move, "if_opp_plays_the_threat_at_once" plays your move, then the threat, then best play. If the eval stays good
  there, your move stops the threat: explain how, from the labels (for example the reply that punishes the threat). If the eval
  collapses, your move ignored the threat. When the threat decides the gap, lead with it: "the opponent threatened X; the
  better move answers it with Y; your move did not." The threat can be a quiet move, such as a pawn push that starts an attack.
- "prepares" (when not null) is a capture or check that the better move sets up: what you would play next if the opponent
  passed. "line_if_played_at_once" plays it right away instead, and there it fails. "follow_up_fails" (when not null) plays on
  in that line with the capture or check the idea is aiming for, and shows the opponent's answer that refutes it.
  Explain it as an idea, a problem and a solution: the capture or check is the idea; the problem is the opponent's answer in
  "follow_up_fails" when set, else the opponent's reply in "line_if_played_at_once" (say what it does, from its labels); the
  better move comes first so the idea works later. "better_move_guards" (when not null) is the square of that problem move
  that the better move covers: say so, for example "Rf1 guards f2". Otherwise say how it stops the problem only if the labels
  show it. Show the first moves of the line that fails.
  When "prepares" is set, always explain it: it is the main reason the better move works, so lead with it. One exception:
  when the eval collapses in your move's "if_opp_plays_the_threat_at_once" (your move ignored the threat), explain the
  threat first and "prepares" right after it.
- "after_each_line" compares the two positions reached at "explained_at_position_after": "pieces_left" for each line,
  and the imbalance labels (same labels as "imbalances", from your view) that stand after one line but not after the
  other. When the gap is not decided by a capture, a check or a threat, this is where the two lines part: lead with the
  biggest difference (a piece traded off, an outpost taken, a pawn made weak or passed, a bishop freed or shut in, a king
  shield broken) and name the moves in the line that bring it about. It is a fact at "explained_at_position_after", so
  rule 9 lets you give it as the cause of a term. Say "after <move>" so the player knows it is not on the board yet.
- "sf15_terms" are Stockfish 15.1's hand-crafted evaluation terms, measured at the quiet position reached a few moves into each line ("explained_at_position_after"). Their difference says WHY one move is better.
  "notes_at_that_position" describes that same position: "opposite-coloured bishops" makes an endgame drawish even a pawn or two
  down (SF 15 counts it in Winnable), and a bad bishop is one hemmed in by its own fixed centre pawns. When a line
  creates a bad bishop (often by forcing a pawn onto its colour) or trades one off, that is a reason for the move.

Term meanings: Material = piece count. Imbalance = piece combinations (bishop pair, knights love pawns, two rooks overlap).
Pawns = pawn structure (isolated, doubled, backward, connected). Knights/Bishops = outposts, bad bishop (own pawns on its colour, blocked centre), long diagonal, distance to king.
Rooks = open/semi-open files, trapped rook. Mobility = how many useful squares the pieces have. King safety = attackers near the king, pawn shield.
Threats = attacked or hanging pieces. Passed = passed pawns. Space = safe squares behind your pawns. Winnable = how drawish the endgame is.

Rules:
1. Explain why the alternative is better than the played move (or why the played move is fine, if the gap is small).
2. If the line wins or loses material or mates, lead with the concrete tactic, using only moves from the given lines.
3. Only if the SF 15.1 total gap is at least half the latest Stockfish gap, name the 2-3 biggest term differences in plain chess language, with their size in pawns.
4. Otherwise the main reason is in the line (a tactic, a trap, or a plan the classical rules cannot see): point to the moves in the line that decide it. Never invent a reason.
   You may still name up to two terms that favour the better move by at least 0.25 pawns each and match something in the line
   (for example a bishop given up for a knight, or broken king pawns), as part of the reason, with their size. Never present them as the main reason.
5. Never mention moves, squares or pieces that are not supported by the facts. At most 120 words. No headings.
   Stop once the decisive point is made: do not narrate the rest of a line, and do not judge trades you were not told about.
   Never call a piece or side active, passive, cramped, boxed in, loose, tied down or pushed back, and never speak of tempo,
   counterplay or initiative, unless a label says so: cut the sentence instead.
6. The board the player sees is the position before any move. When you describe something that happens later in a line,
   name the moves that lead there first, so a piece that moves during the line is never described as if it already stood there.
   Write every variation on its own line, starting on a new line, like this:
   "Later your bishop on g4 gets attacked:
   14...Rfe8 15.Nbd2 Ne7 16.g3 c5 17.a5 Bg4 18.Ne5"
   Prefer the first few moves of a line: later moves are less reliable.
   Always write move numbers as in that example, with no space after the dot, so it is clear which side plays each move.
7. The "[line ends mid-exchange ...]" note is for you only: do not quote it, just do not count the last capture as final.
8. Only the first move of each line is a choice being judged. Every later move is the engine's best play for both sides:
   never call one careless, a mistake or the cause of the problem. If the eval shifts inside a line, the reason is the
   first move, not a later one.
   Never say the opponent "must", "has to" or is "forced", unless the move answers a check.
   A move's eval is its "latest_sf_eval". Numbers in "if_opp_plays_the_threat_at_once", "line_if_played_at_once",
   "follow_up_fails", a "Why ... fails" line or "eval_if_you_could_pass_and_opp_played_it" are side lines: if you quote
   one, say which line it comes from. Do not sum up a line's evals as a range or a trend ("stays
   around", "drifts to"): quote the eval after a named move. When the eval drops on the first move, say so instead of
   blaming a later move.
9. A term difference is a number, not a reason. Give a cause for a term only from what still stands at
   "explained_at_position_after": a structure label or a capture label on a move up to that point, or
   "notes_at_that_position", and name that move. Pins, attacks and threats do not count: they may be gone by then.
   With no such fact, give the term and its size only: no "because", and do not remark that the cause is not shown.
10. After the imbalance sentence, say in plain chess words what the played move allows and what the better move does
   instead, from the labels: a piece left attacked or pinned, a line opened against a king, a piece traded off, a weakness
   created or fixed. Then show the line. Terms and evals come after that.
11. When a deciding line trades material, say what changed hands in pieces, from its capture labels ("two minor pieces
   for a rook", "your knight for their bishop"), not only the material balance.
12. If a line shows mate ("checkmate", "mates in", "gets mated", "threatens ...#") or checks that strip a king's shield
   ("king shield lost its ..."), the reason is the attack on that king: say so before any material count.`;

export async function explain(facts, apiKey, model = 'claude-haiku-5-5') {
  // Haiku has no server-side fallback; on the others a safety decline is retried on a fallback model
  const fallback = !model.startsWith('claude-haiku');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // the key is the user's own, stored in their browser profile
      'anthropic-dangerous-direct-browser-access': 'true',
      ...fallback && { 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      output_config: { effort: 'high' },
      ...fallback && { fallbacks: 'default' },
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
async function checkNotPlaying(user) {
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
  // the hash and history tables carry over from earlier requests: clear them, so the same request gives the same lines
  await Promise.all([engines.sf, engines.sf2].map(e => e.until(['ucinewgame', 'isready'], l => l === 'readyok')));
  const best = req.best ? parseMove(pos, req.best) : null;
  // you played lichess's move: still explain that move, against the best other move
  if (best === move) move = await otherBest(engines.sf, pos, move, NODES);
  const facts = await buildFacts(engines, req.fen, move, best, NODES);
  const line = k => ({
    move: facts[k].move, eval: facts[k].latest_sf_eval, line: facts[k].line_with_evals,
    threat_line: facts[k].if_opp_plays_the_threat_at_once,
  });
  const gap = Math.abs(facts.latest_sf_gap);
  // the engines' lines differ for reasons too small to explain; a story would only invent one
  const text = gap < EQUAL_GAP
    ? `**${facts.played.move}** is about as good as **${facts.alternative.move}**: the difference is ${gap.toFixed(2)} pawns, `
      + 'which is within the engine\'s noise. Either move is fine.'
    : await llm(facts, apiKey);
  return { text, best: line('alternative'), compared: line('played') };
}

// ---- node ----

/** Node only: the WASM engines as child processes. Returns {sf, sf15, quit}. */
export async function nodeEngines() {
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
  return { ...await startEngines(start), quit: () => procs.forEach(p => p.stdin.end('quit\n')) };
}

if (import.meta.main) { // node 24.2+; undefined in the browser
  const { parseArgs } = await import('node:util');
  const { values: o, positionals: [fen, move] } = parseArgs({
    allowPositionals: true,
    options: { vs: { type: 'string' }, nodes: { type: 'string', default: String(NODES) },
      'no-llm': { type: 'boolean' }, model: { type: 'string' } },
  });
  const engines = await nodeEngines();
  try {
    const pos = position(fen);
    const facts = await buildFacts(engines, fen, parseMove(pos, move), o.vs ? parseMove(pos, o.vs) : null, Number(o.nodes));
    console.log(JSON.stringify(facts, null, 1));
    if (!o['no-llm']) console.log('\n' + await explain(facts, process.env.ANTHROPIC_API_KEY, o.model));
  } finally {
    engines.quit();
  }
}
