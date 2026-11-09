// Explain why one chess move is better than another.
//
// Stockfish 19 decides WHICH move is better (eval + main line).
// Stockfish 15's hand-crafted eval explains WHY (term-by-term diff a few moves into each line).
// An LLM turns those numbers into plain language.
//
// Runs in the side panel (engines in Web Workers) and in node (engines as child processes):
//   node extension/explain.js FEN MOVE [--vs MOVE] [--nodes N] [--no-llm] [--model ID] [--deep]
// --deep runs the deeper read before the answer, as the panel's positional depth switch does.
//   node extension/explain.js FEN --plan [--no-llm] [--model ID]
// --plan finds a plan for the side to move instead, as the panel's Find plan button does (--no-llm: the plan sheet only).

import {
  Chess, SquareSet, attacks, castlingSide, kingCastlesTo, makeFen, makeSan, makeSquare, makeUci, opposite, parseFen,
  parseSan, parseUci, squareFile, squareRank,
} from './vendor/chessops.js';
import {
  endNotes, hasBishopPair, imbalances, isOutpost, islandChange, key, leafDiff, orNull, outpostSquares, owner, passedPawns,
  pawnWeaknesses, rookFile, shieldHoles, word,
} from './features.js';
import { PLAN_SYSTEM, systemFor } from './prompt.js';
// concepts.js imports chess helpers from here: a cycle, safe because neither module uses the other's exports at load time
import { planShapes, withConcepts, withPlan } from './concepts.js';

export const NODES = 2_000_000;
const THREADS = 1; // one search thread: a node-limited search then gives the same lines every run
const EQUAL_GAP = 0.3; // pawns; below this both moves are called equal and the LLM is skipped
const ALSO_GAP = 0.1; // pawns; a plan names the engine's second move as "about as good" below this
const ANSWERS = 200; // saved Explain answers kept (see remembered), oldest dropped first
const SHEETS = 20; // fact sheets a panel keeps (see sheetCache), oldest dropped first
const DECLINED = '(the model declined to answer)';
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
    Commands run one at a time, in call order. A dead engine never answers again: tell it with `fail(error)`, and the
    request it is on and every later one reject with that error instead of waiting for ever. When `signal` aborts
    while its commands are with the engine (or before), `stop` follows them, so a search ends at once with its bestmove. */
export function uciEngine(send) {
  let waiting = null, reject = null, dead = null, queue = Promise.resolve();
  const until = (cmds, done, signal) => (queue = queue.then(() => new Promise((resolve, no) => {
    if (dead) return no(dead);
    const lines = [], stop = () => send('stop');
    waiting = l => {
      lines.push(l);
      if (done(l)) { waiting = reject = null; signal?.removeEventListener('abort', stop); resolve(lines); }
    };
    reject = no;
    cmds.forEach(send);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  })));
  const fail = error => {
    dead = error;
    waiting = null;
    reject?.(error);
    queue.catch(() => {}); // requests still in the queue reject after this one; nobody may be waiting for the last
  };
  return { onLine: l => waiting?.(l), until, fail };
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
  const infos = pickInfos(lines).map(l => {
    const m = l.match(INFO);
    return { score: { [m[1]]: Number(m[2]) }, pv: m[4].trim().split(' ') };
  });
  return infos.length ? infos : [{ score: { cp: 0 }, pv: [] }]; // no legal moves
}

const INFO = /^info .* score (cp|mate) (-?\d+)( lowerbound| upperbound)?.*? pv (.*)$/;

/** The info lines search() reads, one per MultiPV line: the last exact one, else the last bound. A bound comes from
    an unfinished iteration (score not exact, pv cut short), so an exact line always wins over it. */
export function pickInfos(lines) {
  const keep = [];
  for (const l of lines) {
    const m = l.match(INFO);
    if (!m) continue;
    const k = Number(l.match(/ multipv (\d+)/)?.[1] ?? 1) - 1;
    if (!m[3] || !keep[k] || keep[k].match(INFO)[3]) keep[k] = l;
  }
  return keep;
}

// ---- board helpers ----

export const position = fen => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
const fenOf = pos => makeFen(pos.toSetup());
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
const forcing = sanText => /[x+#]/.test(sanText); // a capture or a check, from the SAN
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

/** Play the first LEAF_PLIES of the engine line and stop at the last quiet position (no check, last move not
    a capture), so the static eval is not taken in the middle of an exchange. Kept short: the first moves of a
    line are the most reliable, and they are the ones the answer quotes. */
export function lineToLeaf(pos, pv) {
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

/** Run SF 15 `eval` and return {terms: {term: value in pawns}, sides: {term: {yours, theirs}}} from `color`'s side, MG/EG
    blended by phase. sides holds the two-sided terms split by whose pieces score them: yours + theirs = the term, and
    theirs > 0 means their side scores less (their king is less safe), not that yours scores more. */
export async function sf15Terms(sf15, pos, color) {
  const lines = await sf15.until([`position fen ${fenOf(pos)}`, 'eval'], l => l.startsWith('Final evaluation'));
  const ph = phase(pos), sign = color === 'white' ? 1 : -1, terms = {}, sides = {};
  const blend = (mg, eg) => (mg * ph + eg * (128 - ph)) / 128 / SF15_SCALE;
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
function material(pos, color) {
  let total = 0;
  for (const [, p] of pos.board) if (p.role !== 'king') total += VALUE[p.role] * (p.color === color ? 1 : -1);
  return total;
}

/** Enemy pieces newly attacked by the piece that just moved to `sq`, if worth more than it
    or attacked more times than defended. `whose` ("your"/"opp's") names whose pieces they are.
    ponytail: direct attacks only; discovered attacks are not labelled. */
function threats(pos, sq, attackedBefore, whose) {
  const mover = pos.board.get(sq), out = [];
  for (const t of attacks(mover, sq, pos.board.occupied).intersect(pos.board[opposite(mover.color)])) {
    const victim = pos.board.get(t);
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

/** Your quiet pawn moves later in the line (after its first move): [{ move: 'f3', text: '4.f3 (to the square 1.Nd2 left)',
    point }]. `point` marks a push within the first `maxPlies` that does something: it goes to the square the first move
    left, attacks a piece (as the line labels count it) or frees or shuts in a bishop. Flank pushes that only gain space do not. */
export function pawnPushes(pos, pv, you, maxPlies = 10) {
  const first = pv[0] && parseUci(pv[0]), firstSan = pv[0] && `${moveNo(pos)}${san(pos, pv[0])}`, out = [];
  let b = pos;
  for (const [i, uci] of pv.entries()) {
    const mv = parseUci(uci), next = play(b, uci);
    if (i > 0 && b.turn === you && b.board.getRole(mv.from) === 'pawn' && !isCapture(b, mv) && !mv.promotion) {
      const step = b.turn === 'white' ? 8 : -8;
      const room = first.from !== mv.from && [mv.from + step, mv.to].includes(first.from) && b.board.getRole(first.from) === undefined;
      const point = i < maxPlies && (room || threats(next, mv.to, new Set(), "opp's").length > 0
        || bishopReach(b, next, uci).length > 0);
      out.push({ move: san(b, uci), text: `${moveNo(b)}${san(b, uci)}${room ? ` (to the square ${firstSan} left)` : ''}`, point });
    }
    b = next;
  }
  return out;
}

/** The pushes with a point in line `a` that line `b` never plays, as text, or null. */
function onlyIn(a, b) {
  return orNull(a.filter(p => p.point && !b.some(q => q.move === p.move)).map(p => p.text));
}

/** Bishops (other than the mover) whose reach changes by 3+ squares when move `uci` from `b` to `next` moves or takes a
    pawn and so opens or closes diagonals: [{square, color, change}]. */
function bishopReach(b, next, uci) {
  const mv = parseUci(uci), out = [];
  if (b.board.getRole(mv.from) !== 'pawn' && b.board.getRole(mv.to) !== 'pawn' && !isEnPassant(b, mv)) return out;
  const reach = (pos, sq) => attacks(pos.board.get(sq), sq, pos.board.occupied).diff(pos.board[pos.board.getColor(sq)]).size();
  for (const sq of b.board.bishop.intersect(next.board.bishop).without(mv.from)) {
    if (b.board.getColor(sq) !== next.board.getColor(sq)) continue;
    const change = reach(next, sq) - reach(b, sq);
    if (Math.abs(change) >= 3) out.push({ square: sq, color: b.board.getColor(sq), change });
  }
  return out;
}

/** Positional labels for move `uci` from `b` to `next`; `you` is the side the explanation is for. */
export function moveLabels(b, next, uci, you) {
  const mv = parseUci(uci), role = b.board.getRole(mv.from), victim = b.board.getRole(mv.to);
  const labels = [];
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
      || squareRank(next.board.kingOf(them)) === (b.turn === 'white' ? 7 : 0)))
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
export const linePlies = text => {
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
async function lineWithEvals(sf, pos, pv, nodes, maxPlies = 20, you = pos.turn, nested = false) {
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
    let ev;
    if (b.isCheckmate()) ev = 'checkmate';
    else if (b.isEnd()) ev = 'draw';
    else {
      const { score } = (await search(sf, b, nodes))[0];
      ev = scoreStr(pov(score, b, you));
      // what the mover would play next if the other side passed: catches batteries, discovered attacks, mate threats
      const [, threat] = await opponentThreat(sf, b, nodes, score);
      if (threat && forcing(threat.move)) labels.push(`threatens ${threat.move}`); // quiet threats are mostly noise mid-line
      const next = pv[i + 1] && parseUci(pv[i + 1]);
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
function positionBefore(pos) {
  const checkers = [...pos.ctx().checkers].map(s => `${pos.board.getRole(s)} on ${makeSquare(s)}`);
  const pinned = color => orNull(pins(pos, color).map(p => `${pinText(pos, p)}, by ${pos.board.getRole(p.pinner)} on ${makeSquare(p.pinner)}`));
  return {
    you_are_in_check_from: orNull(checkers),
    your_pieces_in_danger: orNull(loosePieces(pos, pos.turn)),
    opponent_pieces_you_can_win: orNull(loosePieces(pos, opposite(pos.turn))),
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
    `scoreNow` is the current eval from the side to move. Returns [threat UCI, facts, centipawns it gains] or [null, null]. */
async function opponentThreat(sf, pos, nodes, scoreNow, min = 100) {
  const p = !pos.isCheck() && passed(pos);
  if (!p) return [null, null];
  const { score, pv } = (await search(sf, p, nodes))[0];
  const threatScore = flip(score); // back to your side
  if (!pv.length || cpOf(scoreNow) - cpOf(threatScore) < min) return [null, null];
  return [pv[0], { move: san(p, pv[0]), eval_if_you_could_pass_and_opp_played_it: scoreStr(threatScore) }, cpOf(scoreNow) - cpOf(threatScore)];
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
  if (!tactic || tactic === played || !forcing(facts.move) || !pos.isLegal(parseUci(tactic))) return null;
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
    if (next && next !== pv[2] && now.isLegal(parseUci(next)) && forcing(san(now, next))) {
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
    same searches in the same order, so its hash table carries the same history and the lines stay the same every run.
    When the two moves are about equal the sheet stops at their scores, the only facts their answer needs. */
async function buildFacts({ sf, sf2, sf15 }, fen, played, vs, nodes = NODES) {
  const pos = position(fen);
  const [before, other] = await Promise.all([
    search(sf, pos, nodes).then(r => r[0].score),
    vs ?? otherBest(sf2, pos, played, nodes),
  ]);
  const [threat, threatFacts] = await opponentThreat(sf, pos, nodes, before, QUIET_THREAT);
  if (!played || !other) throw new Error('There is only one legal move here: nothing to compare.');
  // each move's own search comes first in its line, as it always has, so the about-equal check costs no extra search
  const [rp, ra] = await Promise.all([[sf, played], [sf2, other]].map(([e, mv]) => search(e, pos, nodes, { moves: [mv] }).then(r => r[0])));
  const gap = round2((cpOf(ra.score) - cpOf(rp.score)) / 100);
  const side = pos.turn === 'white' ? 'White' : 'Black';
  const scored = (mv, { score }) => ({ move: san(pos, mv), latest_sf_eval: scoreStr(score), cp: cpOf(score) });
  const equal = { fen, side_to_move: side, played: scored(played, rp), alternative: scored(other, ra), latest_sf_gap: gap };
  if (aboutEqual(equal)) return equal;
  const pushes = {}, sides = {};
  const lineNodes = Math.max(Math.floor(nodes / 10), 100_000);
  const line = async (engine, mv, { score, pv }) => {
    const { leaf, leafSans } = lineToLeaf(pos, pv);
    pushes[mv] = pawnPushes(pos, pv, pos.turn);
    const t = leaf ? await sf15Terms(sf15, leaf, pos.turn) : { terms: {}, sides: {} };
    sides[mv] = t.sides;
    const out = {
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
  const lines = {};
  let prep;
  await Promise.all([
    line(sf, played, rp).then(l => (lines.played = l)),
    line(sf2, other, ra).then(async l => {
      prep = await prepares(sf2, pos, other, played, l.cp, lineNodes);
      lines.alternative = l;
    }),
  ]);
  const a = lines.alternative.sf15_terms, p = lines.played.sf15_terms;
  const diff = Object.keys(a).filter(k => k in p && k !== 'Total').map(k => [k, round2(a[k] - p[k])]);
  const hasTerms = Object.keys(a).length && Object.keys(p).length;
  const leafOf = l => l.explained_fen && position(l.explained_fen);
  return {
    fen,
    side_to_move: side,
    eval_before_any_move: scoreStr(before),
    position_before_move: positionBefore(pos),
    imbalances: imbalances(pos),
    opponent_threat: threatFacts,
    material_before_any_move: material(pos, pos.turn),
    values_are_from: "side to move's point of view, in pawns",
    played: lines.played,
    alternative: lines.alternative,
    latest_sf_gap: gap,
    prepares: prep,
    pawn_plan_only_in_better_line: onlyIn(pushes[other], pushes[played]),
    after_each_line: leafDiff(leafOf(lines.alternative), leafOf(lines.played), pos.turn),
    sf15_term_diff_alternative_minus_played: Object.fromEntries(diff.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))),
    sf15_term_diff_by_side: bySide(diff, sides[other], sides[played]),
    sf15_total_gap: hasTerms ? round2((a.Total ?? 0) - (p.Total ?? 0)) : null,
  };
}

/** The two-sided term differences of at least 0.25, split into your side's part and theirs (see sf15Terms), so
    "their king is less safe" is not told as "your king is safer". Null when none. */
function bySide(diff, a, p) {
  const out = diff.filter(([k, d]) => Math.abs(d) >= 0.25 && a?.[k] && p?.[k])
    .map(([k]) => [k, { yours: round2(a[k].yours - p[k].yours), theirs: round2(a[k].theirs - p[k].theirs) }]);
  return out.length ? Object.fromEntries(out) : null;
}

// ---- the LLM ----

/** One Messages API call: `system`, the fact sheet as the user message. Returns the reply's text. With `onText`, the
    reply is streamed and `onText(text so far)` hears each piece as it is written. */
export async function ask(system, facts, apiKey, model, onText) {
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
      // cached for 5 minutes: a write costs 1.25x input, a read 0.20 $/MTok (Opus 5.5, Sonnet 5.5), so one call in 5
      // minutes pays the write premium and two or more save. A prompt under 512 tokens is simply not cached.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(facts, null, 1) }],
    }),
    signal: AbortSignal.timeout(120_000),
  }).catch(e => { throw new Error(`Could not reach the Anthropic API (${e.message}).`); });
  // an error status is a plain JSON body, streamed or not
  const body = onText && r.ok ? await streamed(r.body, onText) : await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error('Anthropic rejected the API key. Check it in the panel settings.');
  if (!r.ok) throw new Error(`Anthropic API error ${r.status}: ${body.error?.message ?? r.statusText}`);
  if (body.stop_reason === 'refusal') return DECLINED;
  return body.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

/** Reads ask()'s server-sent events into the reply as an unstreamed call returns it: {stop_reason, content}. The text
    is every text delta in order, across text blocks: a decline mid-stream adds a fallback block and the fallback model
    goes on, so the text before it stands. An error event, or a stream cut off before its stop reason, throws. */
async function streamed(stream, onText) {
  const reader = stream.getReader(), utf8 = new TextDecoder();
  let buf = '', text = '', stop_reason = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += utf8.decode(value, { stream: true });
    let end;
    while ((end = buf.indexOf('\n\n')) >= 0) { // one event per blank-line-ended block; its JSON is on the data line
      const data = buf.slice(0, end).match(/^data: (.*)$/m)?.[1];
      buf = buf.slice(end + 2);
      const e = data ? JSON.parse(data) : {};
      if (e.type === 'error') throw new Error(`Anthropic API error: ${e.error?.message ?? e.error?.type}`);
      if (e.delta?.type === 'text_delta') onText(text += e.delta.text);
      stop_reason = e.delta?.stop_reason ?? stop_reason;
    }
  }
  if (!stop_reason) throw new Error('The answer was cut off. Try again.');
  return { stop_reason, content: [{ type: 'text', text }] };
}

/** The `llm(system, facts, model, onText)` that answer(), planAnswer() and the tasks take: ask() with the user's key. */
export const llmWith = apiKey => (system, facts, model, onText) => ask(system, facts, apiKey, model, onText);

// ---- one panel request ----

/** Fair play: fail closed unless lichess confirms `user` is not in a game. request() asks before any engine runs. */
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

/** The fact sheet for `move` (SAN or UCI) in `fen`, against `best` (optional; else the best other move). The panel,
    the CLI and so the eval all build it here, so they all see the same sheet. `signal` stops the build (see abortable):
    it then rejects with an AbortError once the engines are idle, and the next build's ucinewgame leaves no trace of it. */
export async function factSheet(engines, fen, move, best = null, nodes = NODES, { signal } = {}) {
  let pos;
  try { pos = position(fen); } catch { throw new Error('invalid position'); }
  let played = parseMove(pos, move);
  const vs = best ? parseMove(pos, best) : null;
  const e = signal ? abortable(engines, signal) : engines;
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
function abortable(engines, signal) {
  const out = new Set();
  const wrap = e => ({ until: async (cmds, done) => {
    signal.throwIfAborted();
    const p = e.until(cmds, done, signal);
    out.add(p);
    const lines = await p.finally(() => out.delete(p));
    signal.throwIfAborted();
    return lines;
  } });
  return { sf: wrap(engines.sf), sf2: wrap(engines.sf2), sf15: wrap(engines.sf15), idle: () => Promise.allSettled(out) };
}

/** The fact sheets one panel has built, by `fen | move`, as promises, at most SHEETS: a request's (when it has no
    `best`) and the next moves' built ahead. One engine job at a time.
    - get(engines, fen, move, best): factSheet()'s sheet. A kept one serves when `best` is unset or is its alternative
      (a sheet built ahead has best = null: the engine's best other move); one still being built is waited for. Else
      the builds ahead stop and, once the engines are idle, the sheet is built. A failed or stopped build never serves.
    - prepare(engines, user, ahead): builds the sheets for `ahead` ([{fen, next}]) one at a time, each once lichess
      confirms `user` is not in a game (fail closed: a refusal or an error ends it). Sheets only, never an LLM call.
    - stop(): stops the builds ahead; resolves once the engines are idle. */
export function sheetCache() {
  const sheets = new Map();
  let ctl = new AbortController(), idle = Promise.resolve();
  const keep = (key, p) => {
    sheets.delete(key);
    sheets.set(key, p);
    if (sheets.size > SHEETS) sheets.delete(sheets.keys().next().value);
    p.catch(() => sheets.get(key) === p && sheets.delete(key));
    return p;
  };
  const after = job => { const p = idle.then(job); idle = p.then(() => {}, () => {}); return p; };
  const stop = () => (ctl.abort(), idle);
  return {
    async get(engines, fen, move, best = null) {
      const key = `${fen} | ${move}`, sheet = await sheets.get(key)?.catch(() => null);
      // b.best === the played move never matches: the alternative is never the played move
      if (sheet && (!best || sanToUci(fen, [best])[0] === sanToUci(fen, [sheet.alternative.move])[0])) return sheet;
      ctl.abort();
      const p = after(() => factSheet(engines, fen, move, best));
      return best ? p : keep(key, p);
    },
    async prepare(engines, user, ahead) {
      ctl.abort();
      const { signal } = ctl = new AbortController();
      await idle; // the builds just stopped leave the Map first, so a key this list still wants is built again
      try {
        for (const { fen, next } of ahead) {
          const key = `${fen} | ${next}`;
          if (sheets.has(key)) continue;
          await checkNotPlaying(user);
          if (signal.aborted) return;
          await keep(key, after(() => factSheet(engines, fen, next, null, NODES, { signal })));
        }
      } catch {} // a refusal, an error or a stop: nothing more is built ahead
    },
    stop,
  };
}

/** True when the two moves are too close to explain: the engines' lines differ for reasons too small, and a story
    would only invent one. Such a sheet holds only the two moves' scores (older saved sheets hold everything). */
export const aboutEqual = facts => Math.abs(facts.latest_sf_gap) < EQUAL_GAP;

/** The answer for a fact sheet: a plain verdict when the moves are about equal (no LLM call), else the explainer's text,
    after a deeper read when `depth` is on. `llm(system, facts, model, onText)` is one LLM call: ask() with the key, or a
    test stub. `onStep(words)` hears which call comes next; `onText` streams the explainer's text (see ask). Returns {text, facts, concepts, read}: facts as the explainer saw them;
    concepts, the verified concepts (null when none held); read, whether the proposer's reply held a claim list
    (undefined when no deeper read ran). */
export async function answer(facts, llm, { model = 'claude-opus-5-5', depth = false, onStep = () => {}, onText } = {}) {
  if (aboutEqual(facts)) {
    return { facts, concepts: null, text: `**${facts.played.move}** is about as good as **${facts.alternative.move}**: `
      + 'the engine sees no real difference between them. Either move is fine.' };
  }
  let concepts = null, read;
  if (depth) {
    onStep('Looking for positional ideas');
    ({ facts, concepts, read } = await withConcepts(facts, llm));
  }
  onStep('Asking Claude');
  return { text: await llm(systemFor(model, !!facts.verified_concepts), facts, model, onText), facts, concepts, read };
}

/** One request from the panel: fair play first, then the engines, then `task(engines, llm)`, whose result it resolves
    to. `engines()` resolves to the started engines. It is not called, and neither is the task, unless lichess confirms
    `user` is not in a game: a refused request reaches no engine and no LLM. `onStep` gets each stage's name.
    The two tasks are explainMove() and findPlan(). */
export async function request({ user, engines, llm, onStep = () => {} }, task) {
  onStep('Checking you are not in a game');
  await checkNotPlaying(user);
  onStep('Starting Stockfish');
  return task(await engines(), llm);
}

/** The Explain answers already given, in `storage` (chrome.storage.local in the panel) under `answers`: [[key, result]],
    oldest first, at most ANSWERS. The key is the request: fen, move, best, model, depth and the extension's `version`,
    so a new release asks afresh. A saved one resolves to {result, saved: true} once lichess confirms `user` is not in
    a game (fail closed: no engine, no LLM). Else, or when `fresh`, `run()` (a request()) answers and its result is
    saved over any old one, unless it has no text or the model declined. */
export async function remembered(storage, { user, fen, move, best, model, depth, version }, run, { fresh = false } = {}) {
  const key = [fen, move, best ?? '', model, depth ? 'depth' : '', version].join(' | ');
  const saved = async () => (await storage.get('answers')).answers ?? [];
  const hit = !fresh && (await saved()).find(([k]) => k === key);
  if (hit) {
    await checkNotPlaying(user);
    return { result: hit[1], saved: true };
  }
  const got = await run();
  const { text } = got.result;
  // a failed save (get or set) must not lose the answer just paid for
  if (text && text !== DECLINED) {
    try {
      await storage.set({ answers: [...(await saved()).filter(([k]) => k !== key), [key, got.result]].slice(-ANSWERS) });
    } catch (e) {
      console.error(e);
    }
  }
  return got;
}

/** A task's result is what the panel shows for it, in the words the user reads: {head, rows, text, lines, note, shapes}.
    head: {label, pill} over the rows, or null. rows: [{kind: best|compared, label, move, eval}]. text: the answer or
    the plan (markdown). lines: the sheet lines a move link in the text may play, each from the request's position.
    note: a sentence under the text, or null. shapes: for the lichess board, or null. */
const row = (kind, label, line) => ({ kind, label, move: line.move, eval: line.latest_sf_eval });
const explainRows = ({ played, alternative }) => [row('best', 'engine move', alternative), row('compared', 'compared', played)];
// every line that starts at the explained position (prepares.follow_up_fails starts mid-line, so it is left out)
const explainLines = ({ played, alternative, prepares }) => [alternative, played]
  .flatMap(l => [l.line_with_evals, l.if_opp_plays_the_threat_at_once]).concat(prepares?.line_if_played_at_once).filter(Boolean);

/** The Explain task. {fen, move, best} -> answer()'s {text, facts, concepts, read} plus its result. move: the move to
    compare against (SAN or UCI), best: lichess's top move (UCI, optional). The sheet comes from `sheet(engines, fen,
    move, best)`: factSheet(), or a sheetCache's get. `onSheet(rows, lines)` hears the result's rows and lines once the
    sheet is built, before any LLM call; `llm` and the other `opts` go to answer(). */
export async function explainMove(engines, req, llm, { onSheet = () => {}, sheet: build = factSheet, ...opts } = {}) {
  const sheet = await build(engines, req.fen, req.move, req.best);
  onSheet(explainRows(sheet), explainLines(sheet));
  const a = await answer(sheet, llm, opts);
  return { ...a, result: {
    head: null,
    rows: explainRows(a.facts),
    text: a.text,
    lines: explainLines(a.facts),
    // a deeper read that added nothing says why
    note: a.read === undefined || a.concepts ? null
      : a.read ? 'No positional idea passed the board checks.' : 'Could not read the positional ideas in the reply.',
    shapes: null,
  } };
}

// ---- a plan for the side to move ----

/** "tactical" when the engine line mates, wins at least a pawn's worth of material by its quiet end, or has to meet a
    threat worth a pawn or more (`threatGain`, centipawns; a smaller one is a plan, such as a pawn push); else "positional". */
function planKind(pos, score, leaf, threatGain) {
  if ('mate' in score || threatGain >= 100) return 'tactical';
  return leaf && material(leaf, pos.turn) - material(pos, pos.turn) >= 1 ? 'tactical' : 'positional';
}

/** The plan sheet for the side to move in `fen`: the engine's best move and its line with labels (on sf only; the
    lichess engine need not be on), what is on the board, the threat, and SF 15's terms where the line turns quiet. */
export async function planFacts({ sf, sf2, sf15 }, fen, nodes = NODES) {
  let pos;
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

/** The plan for a plan sheet, as answer() is for a fact sheet: the strongest model's plan ideas checked on the board
    (withPlan), then `model` writes the plan from the ideas that held. No idea held, or no idea list in the planner's
    reply: throws, saying which, and the writer is never called. Returns {text, facts, ideas}. The eval starts here
    from a saved sheet. */
export async function planAnswer(sheet, llm, { model = 'claude-opus-5-5', onStep = () => {} } = {}) {
  onStep('Looking for plan ideas');
  // the planner plans the best line only; the writer gets the about-as-good move for one sentence
  const { also_good = null, ...rest } = sheet;
  const { facts: planned, ideas, read } = await withPlan(rest, llm);
  if (!ideas) throw new Error(read ? 'No clear plan found here.' : 'Could not read the plan ideas in the reply.');
  const facts = { ...planned, also_good };
  onStep('Asking Claude');
  return { text: await llm(PLAN_SYSTEM, facts, model), facts, ideas };
}

/** The Find plan task: the plan sheet and its planAnswer(), plus its result (see explainMove), whose shapes are
    planShapes(). `opts` go to planAnswer(). */
export async function findPlan(engines, fen, llm, { nodes = NODES, ...opts } = {}) {
  const a = await planAnswer(await planFacts(engines, fen, nodes), llm, opts);
  const { best, also_good, side_to_move, plan_kind } = a.facts;
  return { ...a, result: {
    head: { label: `Plan for ${side_to_move}`, pill: plan_kind === 'tactical' ? 'Tactical' : 'Positional' },
    rows: [row('best', 'first move', best), ...also_good ? [row('also', 'about as good', also_good)] : []],
    text: a.text,
    lines: [best.line_with_evals, also_good?.line_with_evals].filter(Boolean),
    note: null,
    shapes: planShapes(a.facts, a.ideas, a.text),
  } };
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
      'no-llm': { type: 'boolean' }, model: { type: 'string' }, deep: { type: 'boolean' }, plan: { type: 'boolean' } },
  });
  if (o.deep && o['no-llm']) throw new Error('--deep needs the LLM');
  const engines = await nodeEngines();
  const llm = llmWith(process.env.ANTHROPIC_API_KEY);
  try {
    const nodes = Number(o.nodes);
    if (o['no-llm']) console.log(JSON.stringify(await (o.plan ? planFacts(engines, fen, nodes) : factSheet(engines, fen, move, o.vs, nodes)), null, 1));
    else {
      const { facts, text } = o.plan ? await planAnswer(await planFacts(engines, fen, nodes), llm, { model: o.model })
        : await answer(await factSheet(engines, fen, move, o.vs, nodes), llm, { model: o.model, depth: o.deep });
      console.log(JSON.stringify(facts, null, 1));
      console.log('\n' + text);
    }
  } finally {
    engines.quit();
  }
}
