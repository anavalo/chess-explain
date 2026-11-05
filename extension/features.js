// The features: structural facts about one side's pawns and pieces, the one table that words them as labels, and the
// imbalances and leaf diffs built from them. Pure board code: no engine, no LLM.

import { FILE_NAMES, SquareSet, attacks, makeSquare, opposite, pawnAttacks, squareFile, squareRank } from './vendor/chessops.js';

/** Whose pieces a label is about, on a sheet written for `you`: 'your' or "opp's". */
export const owner = (color, you) => (color === you ? 'your' : "opp's");

const LIGHT = SquareSet.lightSquares(), DARK = SquareSet.darkSquares();
const files = fs => fs.map(f => SquareSet.fromFile(f)).reduce((a, b) => a.union(b));
const CENTRE_FILES = files([2, 3, 4, 5]); // c-f
const HOLE_FILES = files([1, 2, 3, 4, 5, 6]); // b-g
const ahead = (color, sq) => (color === 'white' ? sq + 8 : sq - 8);
const sameColour = sq => (LIGHT.has(sq) ? LIGHT : DARK);
/** A sheet field with nothing in it is null, not []. */
export const orNull = list => (list.length ? list : null);

// ---- features: structural facts about one side's pawns and pieces, and the one place they are worded ----

/** A feature's identity: two features with the same key are the same fact (two rooks on one open file are one). */
export const key = f => `${f.kind} ${f.square ?? f.file ?? ''}`;
const uniq = features => [...new Map(features.map(f => [key(f), f])).values()];

/** The label kinds: how a feature of each kind reads on the fact sheet, without its owner, and a `sample` feature with
    placeholder fields whose wording (in the 'move' form) the sheet legend quotes, so a test keeps the two in step. A kind
    with no sample is one the legend describes in other words. `ctx` is 'move' for a label on a move in a line, where a rook
    file and the bishop pair read differently from the position labels. */
export const KINDS = {
  bishopPair: { word: (f, ctx) => (ctx === 'move' ? 'bishop pair gone' : 'bishop pair'), sample: {} },
  outpost: { word: f => `${f.role} on outpost ${f.square}`, sample: { role: '<knight|bishop>', square: '<square>' } },
  outpostSquare: { word: f => `outpost square ${f.square}`, sample: { square: '<square>' } },
  hole: { word: f => `hole ${f.square}`, sample: { square: '<square>' } },
  rookFile: { word: (f, ctx) => (ctx === 'move' ? `rook on ${f.open} file` : `rook on ${f.open} ${f.file}-file`), sample: { open: 'open|semi-open' } },
  passed: { word: f => `passed ${f.file}-pawn`, sample: { file: '<file>' } },
  doubled: { word: f => `${f.file}-pawns doubled`, sample: { file: '<file>' } },
  isolated: { word: f => `${f.file}-pawn isolated`, sample: { file: '<file>' } },
  backward: { word: f => `pawn on ${f.square} backward`, sample: { square: '<square>' } },
  shieldHole: { word: f => `king shield lost its ${f.file}-pawn`, sample: { file: '<file>' } },
  kingInCentre: { word: () => 'king still in the centre', sample: {} },
  islands: { word: f => `pawn islands ${f.from} to ${f.to}`, sample: { from: 'N', to: 'M' } }, // the count changed on one move
  islandCount: { word: f => `pawns in ${f.count} islands`, sample: { count: 'N' } }, // the count at the end of a line, when the two lines differ
  // shared by both sides, so worded with their owner, from `you`'s view
  pieceImbalance: { word: ({ mine, theirs }) => `piece imbalance: ${mine && theirs ? `your ${mine} for opp's ${theirs}` : mine ? `your extra ${mine}` : `opp's extra ${theirs}`}` },
  oppositeBishops: { word: () => 'opposite-coloured bishops', sample: {} },
  badBishop: { word: (f, ctx, you) => `${owner(f.color, you)} bishop on ${f.square} is bad: ${owner(f.color, you)} pawns on ${f.fixed.join(', ')} are fixed on its colour` },
};
export const word = (f, ctx, you) => KINDS[f.kind].word(f, ctx, you);

export function hasBishopPair(board, color) {
  const bishops = board.bishop.intersect(board[color]);
  return bishops.intersects(LIGHT) && bishops.intersects(DARK);
}

/** A square on `color`'s 4th-6th rank, protected by a `color` pawn, that no enemy pawn can ever attack.
    ponytail: an enemy pawn that is blocked still counts as able to attack it. */
export function isOutpost(board, sq, color) {
  const r = squareRank(sq), rel = color === 'white' ? r : 7 - r;
  if (rel < 3 || rel > 5 || !pawnAttacks(opposite(color), sq).intersects(board.pawn.intersect(board[color]))) return false;
  return !enemyPawnCanAttack(board, sq, color);
}

/** Can an enemy pawn of `color`'s opponent ever attack `sq`: one on a neighbouring file that has not gone past it.
    ponytail: an enemy pawn that is blocked still counts as able to attack it. */
export function enemyPawnCanAttack(board, sq, color) {
  const r = squareRank(sq);
  for (const p of board.pawn.intersect(board[opposite(color)]))
    if (Math.abs(squareFile(p) - squareFile(sq)) === 1 && (color === 'white' ? squareRank(p) > r : squareRank(p) < r)) return true;
  return false;
}

/** The fewest moves the piece on `from` needs to reach `to`, every other piece standing still: it cannot pass through
    pieces or land on its own, it may land on (take) an enemy piece but not go on from there, and it does not stop on
    a square an enemy pawn attacks on the way (the pawn would take it). Undefined past `max` moves. Pieces only: a
    pawn's route is not worked out. */
export function route(board, from, to, max = 4) {
  const piece = board.get(from);
  if (!piece || piece.role === 'pawn') return undefined;
  const occupied = board.occupied.without(from), own = board[piece.color].without(from), enemy = board[opposite(piece.color)];
  const pawns = board.pawn.intersect(enemy);
  const hit = sq => pawnAttacks(piece.color, sq).intersects(pawns); // an enemy pawn attacks sq
  let frontier = [from], seen = SquareSet.empty().with(from);
  for (let n = 1; n <= max && frontier.length; n++) {
    const next = [];
    for (const sq of frontier)
      for (const t of attacks(piece, sq, occupied).diff(own)) {
        if (t === to) return n;
        if (seen.has(t)) continue;
        seen = seen.with(t);
        if (!enemy.has(t) && !hit(t)) next.push(t);
      }
    frontier = next;
  }
  return undefined;
}

/** Holes for `color` in the enemy camp (its 5th-6th rank, b-g files): squares no enemy pawn can ever attack, next to an
    enemy pawn that has gone past them, with no pawn on them and none of `color`'s pawns defending them (that is an
    outpost). Silman's holes, where a piece can settle for good. Only the two a piece of `color` can reach soonest, and
    only those a knight reaches in 3 moves or a bishop of the square's colour in 2: a far hole nobody can use is noise. */
export function holes(board, color) {
  const found = [], theirs = board.pawn.intersect(board[opposite(color)]);
  const knights = [...board.knight.intersect(board[color])], bishops = [...board.bishop.intersect(board[color])];
  const camp = SquareSet.fromRank(color === 'white' ? 4 : 3).union(SquareSet.fromRank(color === 'white' ? 5 : 2));
  for (const sq of HOLE_FILES.intersect(camp).diff(board.pawn)) {
    const f = squareFile(sq), sides = SquareSet.fromFile(f - 1).union(SquareSet.fromFile(f + 1));
    if (!theirs.intersects(sides) || enemyPawnCanAttack(board, sq, color)) continue;
    if (pawnAttacks(opposite(color), sq).intersects(board.pawn.intersect(board[color]))) continue; // an outpost
    const moves = [...knights.map(k => (k === sq ? 0 : route(board, k, sq, 3))), ...bishops.map(b => (b === sq ? 0 : route(board, b, sq, 2)))]
      .filter(n => n !== undefined);
    if (moves.length) found.push({ sq, near: Math.min(...moves) });
  }
  // ponytail: two holes at most, nearest first (ties by square); raise if answers miss a third that matters
  return found.sort((a, b) => a.near - b.near || a.sq - b.sq).slice(0, 2).sort((a, b) => a.sq - b.sq)
    .map(({ sq }) => ({ kind: 'hole', square: makeSquare(sq) }));
}

/** Empty outposts for `color`: holes in the enemy pawns that a `color` knight or bishop could take. Only next to an
    enemy pawn that has gone past it; with no enemy pawn near, every pawn-protected square would count.
    ponytail: c-f files only, where a piece there matters most; add the wings if answers miss a g5/b5 hole. */
export function outpostSquares(board, color) {
  const out = [], theirs = board.pawn.intersect(board[opposite(color)]);
  for (const sq of CENTRE_FILES.diff(board[color]).diff(board.pawn)) {
    const f = squareFile(sq), sides = SquareSet.fromFile(f - 1).union(SquareSet.fromFile(f + 1));
    if (theirs.intersects(sides) && isOutpost(board, sq, color)) out.push({ kind: 'outpostSquare', square: makeSquare(sq) });
  }
  return out;
}

/** `color`'s isolated, doubled and backward pawns, as SF 15 defines them (src/pawns.cpp). */
export function pawnWeaknesses(board, color) {
  const own = board.pawn.intersect(board[color]), theirs = board.pawn.diff(own), out = [];
  for (const p of own) {
    const f = squareFile(p), file = SquareSet.fromFile(f), name = FILE_NAMES[f];
    const neighbours = own.intersect(SquareSet.fromFile(Math.max(f - 1, 0)).union(SquareSet.fromFile(Math.min(f + 1, 7)))).diff(file);
    if (own.intersect(file).size() > 1) out.push({ kind: 'doubled', file: name });
    if (neighbours.isEmpty()) { out.push({ kind: 'isolated', file: name }); continue; }
    // behind all its neighbours, and the square in front is blocked or attacked by an enemy pawn
    const behind = [...neighbours].every(n => (color === 'white' ? squareRank(n) > squareRank(p) : squareRank(n) < squareRank(p)));
    const up = ahead(color, p);
    if (behind && (theirs.has(up) || pawnAttacks(color, up).intersects(theirs))) out.push({ kind: 'backward', square: makeSquare(p) });
  }
  return uniq(out);
}

/** The change in `color`'s pawn islands (groups of pawns on adjacent files) from board `x` to board `y`, or null when the
    counts are equal or `color` has a different number of pawns on each: fewer islands from losing a pawn is no better structure. */
export function islandChange(x, y, color) {
  const pawns = board => board.pawn.intersect(board[color]);
  const count = board => { const f = new Set([...pawns(board)].map(squareFile)); return [...f].filter(i => !f.has(i - 1)).length; };
  const n = count(x), m = count(y);
  return n !== m && pawns(x).size() === pawns(y).size() ? { kind: 'islands', from: n, to: m } : null;
}

/** `color`'s passed pawns: no enemy pawn ahead of it on its own or a neighbouring file. */
export function passedPawns(board, color) {
  const own = board.pawn.intersect(board[color]), theirs = board.pawn.diff(own), out = [];
  for (const p of own) {
    const f = squareFile(p), r = squareRank(p);
    if (![...theirs].some(t => Math.abs(squareFile(t) - f) <= 1 && (color === 'white' ? squareRank(t) > r : squareRank(t) < r)))
      out.push({ kind: 'passed', file: FILE_NAMES[f] });
  }
  return uniq(out);
}

/** Holes in the pawn shield of `color`'s castled king (on its back rank, not on the d/e-file): files next to
    the king with no own pawn on the 2nd or 3rd rank. Files as in SF 15's shelter (king file kept within b-g). */
export function shieldHoles(board, color) {
  const out = [], k = board.kingOf(color), back = color === 'white' ? 0 : 7;
  if (k === undefined || squareRank(k) !== back || squareFile(k) === 3 || squareFile(k) === 4) return out;
  const own = [...board.pawn.intersect(board[color])], c = Math.min(Math.max(squareFile(k), 1), 6);
  for (let f = c - 1; f <= c + 1; f++)
    if (!own.some(p => squareFile(p) === f && Math.abs(squareRank(p) - back) <= 2)) out.push({ kind: 'shieldHole', file: FILE_NAMES[f] });
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

/** A rook on `sq` on an open or semi-open (no `color` pawn) file, else null. */
export function rookFile(board, sq, color) {
  const pawns = board.pawn.intersect(SquareSet.fromFile(squareFile(sq)));
  const open = pawns.isEmpty() ? 'open' : pawns.intersects(board[color]) ? null : 'semi-open';
  return open && { kind: 'rookFile', open, file: FILE_NAMES[squareFile(sq)] };
}

/** The pawn and square features of one side, `(board, color) -> [feature]`, for a position and for the change a move makes. */
const STRUCTURE = [passedPawns, pawnWeaknesses, shieldHoles, outpostSquares, holes];

/** Silman's imbalances as features: what already differs on the board before any move, for the side to move
    ("yours"), the opponent, and both (the piece imbalance and the end notes). Each list may be empty.
    ponytail: structure only; space, development and initiative are left to the SF 15 terms. */
export function features(pos, you = pos.turn) {
  const b = pos.board, them = opposite(you);
  const side = color => {
    const out = [];
    if (hasBishopPair(b, color) && !hasBishopPair(b, opposite(color))) out.push({ kind: 'bishopPair' });
    for (const sq of b[color].intersect(b.knight.union(b.bishop)))
      if (isOutpost(b, sq, color)) out.push({ kind: 'outpost', role: b.getRole(sq), square: makeSquare(sq) });
    for (const sq of b[color].intersect(b.rook)) {
      const file = rookFile(b, sq, color);
      if (file) out.push(file);
    }
    for (const detect of STRUCTURE) out.push(...detect(b, color));
    if (kingInCentre(pos, color)) out.push({ kind: 'kingInCentre' });
    return uniq(out);
  };
  // pieces one side has more of than the other: "your bishop for opp's knight", "opp's extra rook"
  const extra = (c, d) => ['queen', 'rook', 'bishop', 'knight'].flatMap(r =>
    Array(Math.max(0, b[r].intersect(b[c]).size() - b[r].intersect(b[d]).size())).fill(r)).join(' and ');
  const mine = extra(you, them), theirs = extra(them, you);
  const both = [...mine || theirs ? [{ kind: 'pieceImbalance', mine, theirs }] : [], ...endNoteFeatures(pos)];
  return { yours: side(you), opponents: side(them), both };
}

/** The imbalances worded for the fact sheet; a side with none is null. */
export function imbalances(pos, you = pos.turn) {
  const f = features(pos, you);
  return { yours: orNull(f.yours.map(x => word(x))), opponents: orNull(f.opponents.map(x => word(x))), both: orNull(f.both.map(x => word(x, undefined, you))) };
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
  // [whose, feature] pairs; `whose` is null for a feature both sides share, which is worded with its owner inside
  const flat = pos => {
    const f = features(pos, you);
    return [...f.yours.map(x => ['your', x]), ...f.opponents.map(x => ["opp's", x]), ...f.both.map(x => [null, x])];
  };
  const a = flat(leafA), p = flat(leafP);
  for (const color of [you, opposite(you)]) {
    const islands = islandChange(leafA.board, leafP.board, color);
    if (islands) {
      a.push([owner(color, you), { kind: 'islandCount', count: islands.from }]);
      p.push([owner(color, you), { kind: 'islandCount', count: islands.to }]);
    }
  }
  // the same fact at both leaves is the same owner and every field equal; a wording change cannot alter that
  const same = ([w, f], [v, g]) => w === v && JSON.stringify(f) === JSON.stringify(g);
  const only = (x, y) => orNull(x.filter(e => !y.some(o => same(e, o))).map(([whose, f]) => (whose ? `${whose} ${word(f)}` : word(f, undefined, you))));
  return {
    pieces_left: { alternative: piecesLeft(leafA.board, you), played: piecesLeft(leafP.board, you) },
    only_after_alternative: only(a, p),
    only_after_played: only(p, a),
  };
}

/** Features of the position at the end of a line, shared by both sides: opposite-coloured bishops and bad bishops
    (at least two own centre pawns on the bishop's colour, each blocked by an enemy pawn). */
function endNoteFeatures(pos) {
  const b = pos.board, out = [];
  const w = b.bishop.intersect(b.white), k = b.bishop.intersect(b.black);
  if (w.size() === 1 && k.size() === 1 && w.intersects(LIGHT) !== k.intersects(LIGHT)) out.push({ kind: 'oppositeBishops' });
  for (const sq of b.bishop) {
    const color = b.getColor(sq);
    const fixed = [...b.pawn.intersect(b[color]).intersect(sameColour(sq)).intersect(CENTRE_FILES)]
      .filter(p => b.pawn.intersect(b[opposite(color)]).has(ahead(color, p)));
    if (fixed.length >= 2) out.push({ kind: 'badBishop', square: makeSquare(sq), color, fixed: fixed.map(makeSquare) });
  }
  return out;
}

/** The end-of-line features worded for the fact sheet, from `you`'s view; null when there are none. */
export function endNotes(pos, you) {
  return orNull(endNoteFeatures(pos).map(f => word(f, undefined, you)));
}
