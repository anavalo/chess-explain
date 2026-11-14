// The deeper read, run before the answer when the panel's positional depth switch is on: the picked model proposes
// concepts for a fact sheet, each backed by board checks; verify() runs the checks and drops a claim unless every one
// holds; render() turns the survivors into the sheet field "verified_concepts" (checks in words, sides as your/opp's).
// withRule() picks the rule line that closes an answer, checked the same way.
import { SquareSet, attacks, between, opposite, parseSquare, makeSquare, squareFile, squareRank } from './vendor/chessops.js';
import { linePlies, position, play, sanToUci } from './explain.js';
import { enemyPawnCanAttack, isOutpost, route } from './features.js';
import { MODEL, PICKER, PLANNER, PROPOSER, stepModels } from './prompt.js';
import { RULE_POOL } from './rules.js';

const LIGHT = SquareSet.lightSquares();
const VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };
const START = { white: { knight: ['b1', 'g1'], bishop: ['c1', 'f1'] }, black: { knight: ['b8', 'g8'], bishop: ['c8', 'f8'] } };
const side = s => { const v = String(s).toLowerCase(); if (v === 'white' || v === 'black') return v; throw new Error(`side must be white or black, got ${s}`); };
const sq = s => { const v = parseSquare(s); if (v === undefined) throw new Error(`bad square ${s}`); return v; };
const pieceAt = (b, s) => { const p = b.get(s); if (!p) throw new Error(`no piece on ${makeSquare(s)}`); return p; };
const attackersOf = (pos, s, color) => pos.kingAttackers(s, color, pos.board.occupied).size();
// the plies of a line's main row: [{no: '1.', san: 'e4'}, {no: '1...', san: 'e5'}]
const lineSans = l => linePlies(l.line_with_evals)[0];
// a position name past "start": played_leaf, better:3, best_leaf (the plan sheet's line), ...
const NAMED = /^(played|better|best)(?:_leaf|:(\d+))$/;
const lineOf = (sheet, name) => ({ played: sheet.played, better: sheet.alternative, best: sheet.best })[name];

const yn = v => (v === true ? 'yes' : v === false ? 'no' : v);

/** The board checks, one row each. `run(position, args)` is the value the check's `expect` is compared with;
    `say(args, value, s)` words that value on the sheet, where `s(side)` is "your" or "opp's". The proposer and the
    planner read of them in prompt.js: a test holds that every row has its line there, and a case of its own. */
export const CHECKS = {
  piece_on: {
    run: (pos, { square }) => { const p = pos.board.get(sq(square)); return p ? `${p.color} ${p.role}` : 'empty'; },
    say: (a, v, s) => `${a.square}: ${v === 'empty' ? 'empty' : `${s(v.split(' ')[0])} ${v.split(' ')[1]}`}`,
  },
  attacks: {
    run: (pos, { from, to }) => { const f = sq(from); return attacks(pieceAt(pos.board, f), f, pos.board.occupied).has(sq(to)); },
    say: (a, v) => `the piece on ${a.from} attacks ${a.to}: ${yn(v)}`,
  },
  attackers: {
    run: (pos, { square, side: c }) => attackersOf(pos, sq(square), side(c)),
    say: (a, v, s) => `${s(a.side)} pieces attacking ${a.square}: ${v}`,
  },
  defenders: {
    run: (pos, { square }) => { const s = sq(square); return attackersOf(pos, s, pieceAt(pos.board, s).color); },
    say: (a, v) => `defenders of the piece on ${a.square}: ${v}`,
  },
  // squares the piece attacks that are not taken by its own pieces (pseudo-mobility; pawns: their capture squares)
  piece_squares: {
    run: (pos, { square }) => { const s = sq(square), p = pieceAt(pos.board, s); return attacks(p, s, pos.board.occupied).diff(pos.board[p.color]).size(); },
    say: (a, v) => `the piece on ${a.square} reaches ${v} squares`,
  },
  // can any `side` pawn ever attack this square (a pawn on a neighbouring file that has not passed it yet)
  pawn_can_ever_attack: {
    run: (pos, { square, side: c }) => enemyPawnCanAttack(pos.board, sq(square), opposite(side(c))),
    say: (a, v, s) => `a pawn of ${s(a.side) === 'your' ? 'yours' : "the opponent's"} can still ever attack ${a.square}: ${yn(v)}`,
  },
  outpost: {
    run: (pos, { square, side: c }) => isOutpost(pos.board, sq(square), side(c)),
    say: (a, v, s) => `${a.square} is an outpost for ${s(a.side) === 'your' ? 'you' : 'the opponent'}: ${yn(v)}`,
  },
  pawns_on_colour: {
    run: (pos, { side: c, colour }) => {
      if (colour !== 'light' && colour !== 'dark') throw new Error(`colour must be light or dark, got ${colour}`);
      const own = pos.board.pawn.intersect(pos.board[side(c)]); return (colour === 'light' ? own.intersect(LIGHT) : own.diff(LIGHT)).size(); },
    say: (a, v, s) => `${s(a.side)} pawns on ${a.colour} squares: ${v}`,
  },
  file_state: {
    run: (pos, { file }) => {
      const i = 'abcdefgh'.indexOf(String(file).toLowerCase());
      if (i < 0 || String(file).length !== 1) throw new Error(`bad file ${file}`);
      const f = SquareSet.fromFile(i), w = pos.board.pawn.intersect(pos.board.white).intersects(f), b = pos.board.pawn.intersect(pos.board.black).intersects(f);
      return !w && !b ? 'open' : !w ? 'semi-open for white' : !b ? 'semi-open for black' : 'closed';
    },
    say: (a, v, s) => `${a.file}-file: ${String(v).replace('for white', `for ${s('white')} rooks`).replace('for black', `for ${s('black')} rooks`)}`,
  },
  ray_clear: {
    run: (pos, { from, to }) => { const a = sq(from), z = sq(to), btw = between(a, z); if (btw.isEmpty() && !attacks({ role: 'queen', color: 'white' }, a, SquareSet.empty()).has(z)) throw new Error(`${from}-${to} is not a line`); return !btw.intersects(pos.board.occupied); },
    say: (a, v) => `nothing stands between ${a.from} and ${a.to}: ${yn(v)}`,
  },
  // no enemy pawn ahead on this or a neighbouring file, and no own pawn ahead on this file (the rear doubled pawn is not passed)
  passed: {
    run: (pos, { square }) => {
      const s = sq(square), p = pieceAt(pos.board, s), f = squareFile(s), r = squareRank(s);
      if (p.role !== 'pawn') throw new Error(`no pawn on ${square}`);
      const ahead = t => (p.color === 'white' ? squareRank(t) > r : squareRank(t) < r);
      return ![...pos.board.pawn].some(t => ahead(t) && (pos.board.get(t).color === p.color ? squareFile(t) === f : Math.abs(squareFile(t) - f) <= 1));
    },
    say: (a, v) => `the pawn on ${a.square} is passed: ${yn(v)}`,
  },
  king_square: {
    run: (pos, { side: c }) => makeSquare(pos.board.kingOf(side(c))),
    say: (a, v, s) => `${s(a.side)} king on ${v}`,
  },
  undeveloped_minors: {
    run: (pos, { side: c }) => { const color = side(c); return Object.entries(START[color]).reduce((n, [role, ss]) => n + ss.filter(s => { const p = pos.board.get(sq(s)); return p && p.role === role && p.color === color; }).length, 0); },
    say: (a, v, s) => `${s(a.side)} knights and bishops still on their starting squares: ${v}`,
  },
  material: {
    run: (pos, { side: c }) => [...pos.board[side(c)]].reduce((n, s) => n + VALUE[pos.board.get(s).role], 0),
    say: (a, v, s) => `${s(a.side)} material: ${v}`,
  },
  // moves the piece needs to get there, the rest of the board standing still (see route() in features.js)
  route: {
    run: (pos, { from, to }) => route(pos.board, sq(from), sq(to)) ?? 'more than 4',
    say: (a, v) => `the piece on ${a.from} can reach ${a.to} in ${v} moves, the other pieces standing still`,
  },
  legal_moves: {
    run: (pos, { square }) => {
      const s = sq(square);
      if (pieceAt(pos.board, s).color !== pos.turn) throw new Error(`the piece on ${square} is not on the side to move`);
      return pos.dests(s).size();
    },
    say: (a, v) => `the piece on ${a.square} has ${v} legal moves`,
  },
};

/** The positions a check may name: start, played_leaf, better_leaf, or played:N / better:N (after N plies of that line);
    on a plan sheet best_leaf and best:N. */
function positions(sheet) {
  const start = position(sheet.fen);
  const at = (l, n) => { const ucis = sanToUci(sheet.fen, lineSans(l).slice(0, n).map(m => m.san)); return ucis.reduce(play, start); };
  const leaf = l => { if (!l.explained_fen) throw new Error('this line has no explained position'); return position(l.explained_fen); };
  return name => {
    if (name === 'start') return start;
    const m = NAMED.exec(name), l = m && lineOf(sheet, m[1]);
    if (!l) throw new Error(`bad position ${name}`);
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
        if (!Object.hasOwn(CHECKS, k.op)) throw new Error(`unknown op ${k.op}`);
        const value = CHECKS[k.op].run(posOf(k.pos), k.args ?? {});
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
  const where = p => {
    if (p === 'start') return 'now, before your move';
    const m = NAMED.exec(p), l = lineOf(sheet, m[1]);
    const sans = m[2] === undefined ? l.explained_at_position_after : lineSans(l).slice(0, Number(m[2])).map(m => m.no + m.san).join(' ');
    return `after ${sans}`;
  };
  const out = verified.filter(c => c.verified).map(c => ({ concept: c.concept, claim: c.claim,
    checked: c.checks.map(k => `${where(k.pos)}: ${CHECKS[k.op].say(k.args ?? {}, k.value, s)}`) }));
  return out.length ? out : null;
}

/** The claim list in the proposer's reply: the first [...] span that parses as an array, or null when there is none.
    ponytail: tries every [ / ] pair, quadratic in brackets; fine for replies of a few KB. */
export function claimsIn(reply) {
  const opens = [...reply.matchAll(/\[/g)].map(m => m.index), closes = [...reply.matchAll(/\]/g)].map(m => m.index).reverse();
  for (const i of opens) for (const j of closes) {
    if (j < i) break;
    try { const v = JSON.parse(reply.slice(i, j + 1)); if (Array.isArray(v) && v.every(c => c && typeof c === 'object')) return v; } catch {}
  }
  return null;
}

/** The deeper read's sheet: the proposer, `model`, suggests concepts for `facts` (one `llm(system, facts, model)` call, see answer()),
    verify() keeps those whose checks all hold, and they go in as "verified_concepts" right after ANCHOR, the slot the
    concepts A/B tested. Returns {facts, concepts, read} (concepts null when no claim survived; read false when the reply
    held no claim list). Throws when the sheet has no ANCHOR, so a renamed field fails the tests instead of dropping
    the concepts. A sheet that already holds an earlier read's concepts loses them first: the proposer never sees them. */
export async function withConcepts({ verified_concepts: old, ...facts }, llm, model = stepModels(MODEL).ideas) {
  if (!(ANCHOR in facts)) throw new Error(`the fact sheet has no "${ANCHOR}" to put the verified concepts after`);
  const claims = claimsIn(await llm(PROPOSER, facts, model));
  const concepts = claims ? render(facts, verify(facts, claims)) : null;
  const out = {};
  for (const [k, v] of Object.entries(facts)) { out[k] = v; if (k === ANCHOR) out.verified_concepts = concepts; }
  return { facts: out, concepts, read: claims !== null };
}
const ANCHOR = 'pawn_plan_only_in_better_line';

/** The rule line that closes an answer: the picker, `model`, picks at most one rule of RULE_POOL for `facts` (one
    `llm(PICKER, facts, model)` call, see answer()). A pick counts only with a pool id, kind "follows" or "bent", a
    "here" tie of 1 to 12 words and board checks that all hold (verify()); a followed rule comes before a bent one.
    Returns "Rule: <the pool's sentence>\nHere: <tie>" ("Rule bent: ..." for a bent one), or null when no pick holds or
    anything fails: the picker never fails an answer. */
export async function withRule(facts, llm, model = stepModels(MODEL).ideas) {
  try {
    const words = s => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;
    const picks = (claimsIn(await llm(PICKER, facts, model)) ?? [])
      .filter(c => (c.kind === 'follows' || c.kind === 'bent') && RULES.has(c.rule) && words(c.here) >= 1 && words(c.here) <= 12);
    const held = verify(facts, picks).filter(c => c.verified);
    const pick = held.find(c => c.kind === 'follows') ?? held.find(c => c.kind === 'bent');
    if (!pick) return null;
    const rule = RULES.get(pick.rule);
    return `${pick.kind === 'follows' ? 'Rule' : 'Rule bent'}: ${rule[0].toLowerCase()}${rule.slice(1)}\nHere: ${String(pick.here).trim()}`;
  } catch {
    return null;
  }
}
const RULES = new Map(RULE_POOL.map(r => [r.id, r.rule]));

/** Find plan's deeper read: `model` proposes plan ideas for the plan sheet `facts` (PLANNER), verify() keeps
    those whose checks all hold, and they go in as "verified_plan_ideas" before "pawn_pushes_in_line". An idea's targets
    ({square, kind: attack|occupy}, for the board) are kept only when one of its checks names the square. Returns
    {facts, ideas, read}: ideas is null when no idea held; read is false when the reply held no claim list. One idea may
    be a manoeuvre the engine line does not play ("beyond_line": true); it counts only with a route check, and a second
    one is dropped. */
export async function withPlan(facts, llm, model = stepModels(MODEL).ideas) {
  const claims = claimsIn(await llm(PLANNER, facts, model));
  // one manoeuvre beyond the engine line at most: the first that holds and shows its route on the board
  let beyond = 0;
  const checked = verify(facts, claims ?? []).map(c => (c.beyond_line && !(c.verified && c.checks.some(k => k.op === 'route') && beyond++ === 0)
    ? { ...c, verified: false } : c));
  const kept = checked.filter(c => c.verified);
  const ideas = render(facts, checked)?.map((idea, i) => {
    const named = new Set(kept[i].checks.flatMap(k => Object.values(k.args ?? {})).map(String));
    const targets = (Array.isArray(kept[i].targets) ? kept[i].targets : [])
      .filter(t => /^[a-h][1-8]$/.test(t?.square) && named.has(t.square) && (t.kind === 'attack' || t.kind === 'occupy'))
      .map(({ square, kind }) => ({ square, kind }));
    return { ...idea, ...kept[i].beyond_line === true && { beyond_line: true }, targets };
  }) ?? null;
  const out = {};
  for (const [k, v] of Object.entries(facts)) { if (k === 'pawn_pushes_in_line') out.verified_plan_ideas = ideas; out[k] = v; }
  return { facts: out, ideas, read: claims !== null };
}

/** The shapes Find plan draws on the lichess board: a green arrow for the plan's first move, and a circle on each idea
    target the plan's text names (the first 4, in idea order): red to attack, green to occupy. */
export function planShapes(sheet, ideas, text) {
  const [uci] = sanToUci(sheet.fen, [sheet.best.move]);
  const shapes = [{ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush: 'green' }], seen = new Set();
  for (const { square, kind } of (ideas ?? []).flatMap(i => i.targets)) {
    if (seen.size === 4 || seen.has(square) || !new RegExp(`(?<![a-h])${square}(?![0-9])`).test(text)) continue;
    seen.add(square);
    shapes.push({ orig: square, brush: kind === 'attack' ? 'red' : 'green' });
  }
  return shapes;
}
