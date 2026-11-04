// Positional concepts behind the panel's "Deeper positional read" button: Opus proposes concepts for a fact sheet, each
// backed by board checks; verify() runs the checks and drops a claim unless every one holds; render() turns the
// survivors into the sheet field "verified_concepts" (checks in words, sides as your/opp's).
import { SquareSet, attacks, between, parseSquare, makeSquare, squareFile, squareRank } from './vendor/chessops.js';
import { ask, position, play, sanToUci } from './explain.js';
import { isOutpost } from './features.js';
import { PROPOSER } from './prompt.js';

// the proposer is always Opus, whatever model writes the answer
const PROPOSER_MODEL = 'claude-opus-5-5';
const LIGHT = SquareSet.lightSquares();
const VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };
const START = { white: { knight: ['b1', 'g1'], bishop: ['c1', 'f1'] }, black: { knight: ['b8', 'g8'], bishop: ['c8', 'f8'] } };
const side = s => { const v = String(s).toLowerCase(); if (v === 'white' || v === 'black') return v; throw new Error(`side must be white or black, got ${s}`); };
const sq = s => { const v = parseSquare(s); if (v === undefined) throw new Error(`bad square ${s}`); return v; };
const pieceAt = (b, s) => { const p = b.get(s); if (!p) throw new Error(`no piece on ${makeSquare(s)}`); return p; };
const attackersOf = (pos, s, color) => pos.kingAttackers(s, color, pos.board.occupied).size();
// the SANs of a line's main row, with their move numbers: [{num: '1.', san: 'e4'}, {num: '1...', san: 'e5'}]
const lineSans = l => [...l.line_with_evals.split('\n')[0].matchAll(/\b(\d+\.(?:\.\.)?) (?:you|opp) (\S+?)(?= \[| \(|$)/g)].map(m => ({ num: m[1], san: m[2] }));

/** The primitives: (board position, args) -> a value the check's `expect` is compared with. */
const OPS = {
  piece_on: (pos, { square }) => { const p = pos.board.get(sq(square)); return p ? `${p.color} ${p.role}` : 'empty'; },
  attacks: (pos, { from, to }) => { const f = sq(from); return attacks(pieceAt(pos.board, f), f, pos.board.occupied).has(sq(to)); },
  attackers: (pos, { square, side: c }) => attackersOf(pos, sq(square), side(c)),
  defenders: (pos, { square }) => { const s = sq(square); return attackersOf(pos, s, pieceAt(pos.board, s).color); },
  // squares the piece attacks that are not taken by its own pieces (pseudo-mobility; pawns: their capture squares)
  piece_squares: (pos, { square }) => { const s = sq(square), p = pieceAt(pos.board, s); return attacks(p, s, pos.board.occupied).diff(pos.board[p.color]).size(); },
  // can any `side` pawn ever attack this square (a pawn on a neighbouring file that has not passed it yet)
  pawn_can_ever_attack: (pos, { square, side: c }) => {
    const s = sq(square), color = side(c), r = squareRank(s);
    return [...pos.board.pawn.intersect(pos.board[color])].some(p => Math.abs(squareFile(p) - squareFile(s)) === 1
      && (color === 'white' ? squareRank(p) < r : squareRank(p) > r));
  },
  outpost: (pos, { square, side: c }) => isOutpost(pos.board, sq(square), side(c)),
  pawns_on_colour: (pos, { side: c, colour }) => {
    if (colour !== 'light' && colour !== 'dark') throw new Error(`colour must be light or dark, got ${colour}`);
    const own = pos.board.pawn.intersect(pos.board[side(c)]); return (colour === 'light' ? own.intersect(LIGHT) : own.diff(LIGHT)).size(); },
  file_state: (pos, { file }) => {
    const i = 'abcdefgh'.indexOf(String(file).toLowerCase());
    if (i < 0 || String(file).length !== 1) throw new Error(`bad file ${file}`);
    const f = SquareSet.fromFile(i), w = pos.board.pawn.intersect(pos.board.white).intersects(f), b = pos.board.pawn.intersect(pos.board.black).intersects(f);
    return !w && !b ? 'open' : !w ? 'semi-open for white' : !b ? 'semi-open for black' : 'closed';
  },
  ray_clear: (pos, { from, to }) => { const a = sq(from), z = sq(to), btw = between(a, z); if (btw.isEmpty() && !attacks({ role: 'queen', color: 'white' }, a, SquareSet.empty()).has(z)) throw new Error(`${from}-${to} is not a line`); return !btw.intersects(pos.board.occupied); },
  // no enemy pawn ahead on this or a neighbouring file, and no own pawn ahead on this file (the rear doubled pawn is not passed)
  passed: (pos, { square }) => {
    const s = sq(square), p = pieceAt(pos.board, s), f = squareFile(s), r = squareRank(s);
    if (p.role !== 'pawn') throw new Error(`no pawn on ${square}`);
    const ahead = t => (p.color === 'white' ? squareRank(t) > r : squareRank(t) < r);
    return ![...pos.board.pawn].some(t => ahead(t) && (pos.board.get(t).color === p.color ? squareFile(t) === f : Math.abs(squareFile(t) - f) <= 1));
  },
  king_square: (pos, { side: c }) => makeSquare(pos.board.kingOf(side(c))),
  undeveloped_minors: (pos, { side: c }) => { const color = side(c); return Object.entries(START[color]).reduce((n, [role, ss]) => n + ss.filter(s => { const p = pos.board.get(sq(s)); return p && p.role === role && p.color === color; }).length, 0); },
  material: (pos, { side: c }) => [...pos.board[side(c)]].reduce((n, s) => n + VALUE[pos.board.get(s).role], 0),
  legal_moves: (pos, { square }) => {
    const s = sq(square);
    if (pieceAt(pos.board, s).color !== pos.turn) throw new Error(`the piece on ${square} is not on the side to move`);
    return pos.dests(s).size();
  },
};

/** The positions a check may name: start, played_leaf, better_leaf, or played:N / better:N (after N plies of that line). */
function positions(sheet) {
  const start = position(sheet.fen);
  const at = (l, n) => { const ucis = sanToUci(sheet.fen, lineSans(l).slice(0, n).map(m => m.san)); return ucis.reduce(play, start); };
  const leaf = l => { if (!l.explained_fen) throw new Error('this line has no explained position'); return position(l.explained_fen); };
  return name => {
    if (name === 'start') return start;
    const m = /^(played|better)(?:_leaf|:(\d+))$/.exec(name);
    if (!m) throw new Error(`bad position ${name}`);
    const l = m[1] === 'played' ? sheet.played : sheet.alternative;
    return m[2] === undefined ? leaf(l) : at(l, Number(m[2]));
  };
}

const matches = (v, e) => (e && typeof e === 'object' && !Array.isArray(e)
  ? (e.min === undefined || v >= e.min) && (e.max === undefined || v <= e.max)
  : String(v).toLowerCase() === String(e).toLowerCase());

/** Runs every claim's checks on the board. Returns the claims with {checks: [{..., value, ok, error?}], verified, contrast}. */
export function verify(sheet, claims) {
  const posOf = positions(sheet);
  return claims.map(c => {
    const checks = (Array.isArray(c?.checks) ? c.checks : []).map(k => {
      try {
        if (!OPS[k.op]) throw new Error(`unknown op ${k.op}`);
        const value = OPS[k.op](posOf(k.pos), k.args ?? {});
        return { ...k, value, ok: matches(value, k.expect) };
      } catch (e) { return { ...k, ok: false, error: e.message }; }
    });
    const ok = checks.length > 0 && checks.every(k => k.ok);
    return { ...c, checks, verified: ok, contrast: new Set(checks.map(k => k.pos)).size > 1 };
  });
}

/** The sheet field "verified_concepts" for verify()'s output: only verified claims, or null when none survived. */
export function render(sheet, verified) {
  const you = sheet.side_to_move.toLowerCase();
  const s = c => (side(c) === you ? 'your' : "opp's");
  const yn = v => (v === true ? 'yes' : v === false ? 'no' : v);
  const where = p => {
    if (p === 'start') return 'now, before your move';
    const m = /^(played|better)(?:_leaf|:(\d+))$/.exec(p), l = m[1] === 'played' ? sheet.played : sheet.alternative;
    const sans = m[2] === undefined ? l.explained_at_position_after : lineSans(l).slice(0, Number(m[2])).map(m => m.num + m.san).join(' ');
    return `after ${sans}`;
  };
  const say = ({ op, args: a, value: v }) => ({
    piece_on: () => `${a.square}: ${v === 'empty' ? 'empty' : `${s(v.split(' ')[0])} ${v.split(' ')[1]}`}`,
    attacks: () => `the piece on ${a.from} attacks ${a.to}: ${yn(v)}`,
    attackers: () => `${s(a.side)} pieces attacking ${a.square}: ${v}`,
    defenders: () => `defenders of the piece on ${a.square}: ${v}`,
    piece_squares: () => `the piece on ${a.square} reaches ${v} squares`,
    pawn_can_ever_attack: () => `a pawn of ${s(a.side) === 'your' ? 'yours' : "the opponent's"} can still ever attack ${a.square}: ${yn(v)}`,
    outpost: () => `${a.square} is an outpost for ${s(a.side) === 'your' ? 'you' : 'the opponent'}: ${yn(v)}`,
    pawns_on_colour: () => `${s(a.side)} pawns on ${a.colour} squares: ${v}`,
    file_state: () => `${a.file}-file: ${String(v).replace('for white', `for ${s('white')} rooks`).replace('for black', `for ${s('black')} rooks`)}`,
    ray_clear: () => `nothing stands between ${a.from} and ${a.to}: ${yn(v)}`,
    passed: () => `the pawn on ${a.square} is passed: ${yn(v)}`,
    king_square: () => `${s(a.side)} king on ${v}`,
    undeveloped_minors: () => `${s(a.side)} knights and bishops still on their starting squares: ${v}`,
    material: () => `${s(a.side)} material: ${v}`,
    legal_moves: () => `the piece on ${a.square} has ${v} legal moves`,
  })[op]();
  const out = verified.filter(c => c.verified).map(c => ({ concept: c.concept, claim: c.claim,
    checked: c.checks.map(k => `${where(k.pos)}: ${say(k)}`) }));
  return out.length ? out : null;
}

/** The claim list in Opus's reply: the first [...] span that parses as an array, or null when there is none.
    ponytail: tries every [ / ] pair, quadratic in brackets; fine for replies of a few KB. */
export function claimsIn(reply) {
  const opens = [...reply.matchAll(/\[/g)].map(m => m.index), closes = [...reply.matchAll(/\]/g)].map(m => m.index).reverse();
  for (const i of opens) for (const j of closes) {
    if (j < i) break;
    try { const v = JSON.parse(reply.slice(i, j + 1)); if (Array.isArray(v) && v.every(c => c && typeof c === 'object')) return v; } catch {}
  }
  return null;
}

/** The deeper read's sheet: Opus proposes concepts for `facts`, verify() keeps those whose checks all hold, and they go
    in as "verified_concepts" after "pawn_plan_only_in_better_line". Returns {facts, concepts, read} (concepts null when
    no claim survived; read false when the reply held no claim list). */
export async function withConcepts(facts, apiKey) {
  const claims = claimsIn(await ask(PROPOSER, facts, apiKey, PROPOSER_MODEL));
  const concepts = claims ? render(facts, verify(facts, claims)) : null;
  const out = {};
  for (const [k, v] of Object.entries(facts)) { out[k] = v; if (k === 'pawn_plan_only_in_better_line') out.verified_concepts = concepts; }
  return { facts: out, concepts, read: claims !== null };
}
