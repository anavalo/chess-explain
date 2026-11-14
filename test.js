// Checks the fact builder and request handling with the LLM stubbed out; lichess's status API is stubbed.
// The engines are replayed from test-engines.json, the UCI output recorded from the real WASM engines on one thread
// (node-limited single-thread search is deterministic). A change that sends the engines a new command fails with
// "not recorded": run with --record to search again with the real engines (about 3 minutes) and, if every test
// passes, rewrite the file.
// usage: node test.js [--record]
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Chess, makeUci, parseFen, parseSquare, parseUci } from './extension/vendor/chessops.js';
import {
  DECLINED, ask as anthropic, factSheet, llmWith, uciEngine, lineToLeaf, moveLabels, nodeEngines, pawnPushes, pickInfos, pins, sanToUci, sf15Terms, trapped,
} from './extension/explain.js';
import {
  Refused, answer, checkNotPlaying, explainMove, explainRequest, findPlan, firstSentence, keepReason, moveLabel, panelRequests, planAnswer, recentReasons, remembered, request, sheetCache,
} from './extension/request.js';
import { KINDS, endNotes, holes, imbalances, route, isOutpost, leafDiff, pawnWeaknesses, word } from './extension/features.js';
import { lichessBoard } from './extension/lichess.js';
import { linkMoves, md } from './extension/md.js';
import { JUDGE, LEGEND, PAIR, PICKER, PLANNER, PLAN_SYSTEM, PROPOSER, checkAnswer, stepModels, systemFor, withConceptsEntry } from './extension/prompt.js';
import { CHECKS, claimsIn, planShapes, render, verify, withConcepts, withPlan, withRule } from './extension/concepts.js';
import { RULE_POOL } from './extension/rules.js';

const pos = fen => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();

// markdown renderer
assert.equal(md('**Bc4** loses.\n\nc6 *holds*.'), '<p><strong>Bc4</strong> loses.</p><p>c6 <em>holds</em>.</p>');
assert.equal(md('Terms:\n- **Material** +0.5\n- Mobility'),
  '<p>Terms:</p><ul><li><strong>Material</strong> +0.5</li><li>Mobility</li></ul>');
assert.equal(md('1. f3\n2. Bc7'), '<ol><li>f3</li><li>Bc7</li></ol>');
assert.equal(md('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
assert.equal(md('Qxh2# and 2*3'), '<p>Qxh2# and 2*3</p>');

// move links: each numbered variation links to its line at that move; a "Why" line keeps its main line's moves
// before it; a move with two possible histories (1...Kd8) or no move number before it (Kd2) is not linked
const links = html => [...html.matchAll(/<a href="#" data-line="([^"]*)">([^<]*)<\/a>/g)].map(m => `${m[2]}: ${m[1]}`);
assert.deepEqual(links(linkMoves(md('1.Ra7 Kd8 2.Kd2+ wins.\n\n1...Kd8 and Kd2. Not 1.Rb1 Kd8 2.Kf2 Kc7.'), [
    '1. you Ra7 (+9) 1... opp Kd8 (+9) 2. you Kd2 (+9)',
    '1. you Rb1 [x] (+9) 1... opp Kd8 (+9) 2. you Kd2 (+9)\nWhy 2.Kf2 fails: 2. you Kf2 (+9)',
  ])), ['1.Ra7: Ra7', 'Kd8: Ra7 Kd8', '2.Kd2+: Ra7 Kd8 Kd2', '1.Rb1: Rb1', 'Kd8: Rb1 Kd8', '2.Kf2: Rb1 Kd8 Kf2']);
// explainer prompt: the legend, then the rules with rule 15 and the two-move size words; the legend the judge sees holds no rules
assert.ok(systemFor().startsWith(LEGEND) && systemFor().includes('Next time:'));
assert.ok(systemFor().includes('"loses less"') && !systemFor().includes('more than that "winning"'));
assert.ok(!LEGEND.includes('\nRules:'));
// the legend quotes every label kind's wording (it wraps lines, so match across whitespace); a sample is the placeholders
const legend = LEGEND.replace(/\s+/g, ' ');
for (const [kind, { sample }] of Object.entries(KINDS))
  if (sample) assert.ok(legend.includes(word({ kind, ...sample }, 'move')), `legend lacks ${kind}: ${word({ kind, ...sample }, 'move')}`);
assert.equal(Object.values(KINDS).filter(k => !k.sample).length, 2); // pieceImbalance and badBishop: described, not quoted

// rule checks: each answer fails exactly the rules listed; move numbers, squares and ranks are not numbers
const sheet = { played: { line_with_evals: '12. you Nf3 [x] (+0.3) 12... opp Nc6 (+0.2)' } };
const failed = answer => checkAnswer(answer, sheet).map(c => c.rule);
assert.deepEqual(failed('After 12.Nf3 Nc6 your rook reaches the 7th rank.\nNext time: ask what Nf3 gives up.'), []);
assert.deepEqual(failed('word '.repeat(121)), [5]);
assert.deepEqual(checkAnswer('word '.repeat(150), sheet, { maxWords: 200 }), []); // a plan may run to 200 words
assert.deepEqual(failed('12. Nf3 wins.'), [6]);
assert.deepEqual(failed('12.Nf3 [takes] wins.'), [7]);
assert.deepEqual(failed('12.Qh5 wins.'), [5]);
assert.deepEqual(failed('Your king is in check.'), [5]);
assert.deepEqual(failed('White must take back.'), [5]);
assert.deepEqual(failed('12.Nf3 keeps +0.3, half a pawn (0.5) or 30 cp better.'), [14]);
assert.deepEqual(failed('Stockfish likes 12.Nf3.'), [14]);
// the rule line in place of "Next time:": the pool's sentence is not the writer's (no story word or move check reads
// it); its "Here:" tie is checked with the text, and flagged over 12 words
assert.deepEqual(failed('After 12.Nf3 Nc6 your rook reaches the 7th rank.\nRule: we keep the initiative with Nbd7.\nHere: your rook on the 7th rank.'), []);
assert.deepEqual(failed('12.Nf3 wins.\nRule bent: we trade.\nHere: your +0.3 edge.'), [14]);
assert.deepEqual(failed(`12.Nf3 wins.\nRule: we trade.\nHere: ${'word '.repeat(13)}`), [15]);
// a still-losing better move called an edge or winning; "winning a pawn" is a capture, and a positive eval may say edge
const losing = { ...sheet, alternative: { cp: -40 } };
assert.deepEqual(checkAnswer('12.Nf3 is a small edge and winning.', losing).map(c => c.problem), ['absolute eval: a small edge winning']);
assert.deepEqual(checkAnswer('12.Nf3 loses less, winning a pawn.', losing), []);
assert.deepEqual(checkAnswer('12.Nf3 is a small edge.', { ...sheet, alternative: { cp: 40 } }), []);
assert.deepEqual(failed('Next time: ask.\nThen play on.'), [15]);
assert.deepEqual(failed(`Next time: ${'word '.repeat(16)}`), [15]);

assert.deepEqual(sanToUci('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', ['O-O', 'O-O-O']), ['e1g1', 'e8c8']);

// later pawn pushes: Nd2 leaves f3 for the f-pawn, e4 attacks the queen; h3 and the knight's own move have no point
const e4fen = 'r2qk2r/1p1n1ppp/4pn2/p4b2/PpBP4/1Q2PN2/1P3PPP/R1B2RK1 w - - 0 1';
assert.deepEqual(pawnPushes(pos(e4fen), sanToUci(e4fen, ['Nd2', 'Nb6', 'Bb5+', 'Ke7', 'Re1', 'Qd5', 'f3', 'Rac8', 'e4', 'Qxd4+', 'Kh1', 'g6', 'h3']), 'white')
  .map(p => [p.text, p.point]), [['4.f3 (to the square 1.Nd2 left)', true], ['5.e4', true], ['7.h3', false]]);

// white bishop on a7: attacked by the rook, b6 is covered by the c7 pawn, b8 by the rook
assert.deepEqual(trapped(pos('r3k3/B1p5/1p6/8/8/8/8/4K3 w - - 0 1')), [parseSquare('a7')]);
assert.deepEqual(trapped(pos('r3k3/B7/1p6/8/8/8/8/4K3 w - - 0 1')), []); // Bxb6 escapes

// bishop on g2 pins the c6 pawn to the queen on b7; with queen and pawn swapped it is a skewer, not a pin
assert.deepEqual(pins(pos('k7/1q6/2p5/8/8/8/6B1/K7 w - - 0 1'), 'black'),
  [{ pinner: parseSquare('g2'), pinned: parseSquare('c6'), behind: parseSquare('b7') }]);
assert.deepEqual(pins(pos('k7/1p6/2q5/8/8/8/6B1/K7 w - - 0 1'), 'black'), []);
assert.deepEqual(pins(pos('6k1/8/8/8/8/8/8/3r1RK1 w - - 0 1'), 'white'), []); // Rxd1 just takes the pinner

// structure: outposts, pawn weaknesses, move labels, notes at the end of a line
assert.equal(isOutpost(pos('4k3/8/8/8/4P3/8/8/4K3 w - - 0 1').board, parseSquare('d5'), 'white'), true);
assert.equal(isOutpost(pos('4k3/8/2p5/8/4P3/8/8/4K3 w - - 0 1').board, parseSquare('d5'), 'white'), false); // ...c5 hits it
assert.deepEqual(pawnWeaknesses(pos('4k3/8/8/8/8/2P5/2P5/4K3 w - - 0 1').board, 'white'),
  [{ kind: 'doubled', file: 'c' }, { kind: 'isolated', file: 'c' }]);
assert.deepEqual(pawnWeaknesses(pos('4k3/8/8/4p3/2P1P3/3P4/8/4K3 w - - 0 1').board, 'white'), [{ kind: 'backward', square: 'd3' }]);
const labels = (fen, uci) => { const p = pos(fen), q = p.clone(); q.play(parseUci(uci)); return moveLabels(p, q, uci, 'white'); };
assert.deepEqual(labels('4k3/8/8/8/8/2n5/1PP5/4K3 w - - 0 1', 'b2c3'), ['your c-pawns doubled', 'your c-pawn isolated']);
assert.deepEqual(labels('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1d1'), ['rook on open file']);
assert.deepEqual(labels('2b1kb2/8/8/8/8/8/8/2R1K3 w - - 0 1', 'c1c8'), ["opp's bishop pair gone"]);
assert.deepEqual(labels('4k3/8/8/8/4P3/2N5/8/4K3 w - - 0 1', 'c3d5'), ['knight on outpost d5']);
assert.deepEqual(labels('4k3/8/8/3p4/2P5/8/8/4K3 w - - 0 1', 'c4d5'), ['your d-pawn isolated', 'your passed d-pawn']);
assert.deepEqual(labels('6k1/8/8/8/8/8/5PPP/6K1 w - - 0 1', 'g2g4'), ['pawn gains space', 'your king shield lost its g-pawn']);
assert.deepEqual(labels('6k1/8/8/8/8/8/5PPP/6K1 w - - 0 1', 'h2h3'), []); // luft keeps the shield
assert.deepEqual(labels('4k3/1p6/8/8/8/8/8/R3K3 w - - 0 1', 'a1a7'), ['rook on 7th rank']);
// c4 can no longer reach d4, and nothing on the e-file can take d5 again: both squares become outposts
assert.deepEqual(labels('4k3/8/8/4p3/8/8/2P5/4K3 w - - 0 1', 'c2c4'), ['pawn gains space', 'your outpost square d5', "opp's outpost square d4"]);
assert.deepEqual(labels('8/8/4k3/8/8/8/8/R3K3 w - - 0 1', 'a1a7'), []); // nothing to attack there
// d2-d4 opens the c1 bishop's diagonal; a pawn move on the other wing does not
assert.deepEqual(labels('4k3/8/8/8/8/8/3P3P/2B1K3 w - - 0 1', 'd2d4'), ['pawn gains space', 'frees your bishop on c1 (+5 squares)']);
assert.deepEqual(labels('4k3/8/8/8/8/8/3P3P/2B1K3 w - - 0 1', 'h2h3'), []);
// bxc3 joins the b- and d-pawns into one island; taking an isolated pawn is no island change for its owner
assert.deepEqual(labels('4k3/2p5/8/8/8/2n5/1P1P4/4K3 w - - 0 1', 'b2c3'), ['your pawn islands 2 to 1']);
assert.deepEqual(labels('4k3/p1p5/8/8/8/8/8/R3K3 w - - 0 1', 'a1a7'), ['rook on 7th rank']);
assert.deepEqual(endNotes(pos('2b1k3/8/8/8/8/8/8/2B1K3 w - - 0 1'), 'white'), ['opposite-coloured bishops']);
assert.deepEqual(endNotes(pos('4k3/8/4p3/3pP3/3P4/8/8/2B1K3 w - - 0 1'), 'white'),
  ['your bishop on c1 is bad: your pawns on d4, e5 are fixed on its colour']);
// what one line's end has that the other's does not, from White's view, whoever is to move there:
// line A traded the bishops off and put a knight on d5; line P kept them
assert.deepEqual(leafDiff(pos('r4rk1/pp3ppp/8/3Np3/4P3/8/PPP2PPP/R4RK1 b - - 0 15'),
  pos('r1b2rk1/pp3ppp/2p5/4p3/2B1P3/2N5/PPP2PPP/R4RK1 b - - 0 15'), 'white'), {
  pieces_left: { alternative: 'you: R R N, opp: R R', played: 'you: R R B N, opp: R R B' },
  only_after_alternative: ['your knight on outpost d5', 'your hole d6'],
  only_after_played: null,
});
assert.equal(leafDiff(null, pos('8/8/8/8/4k3/4P3/5K2/8 b - - 1 1'), 'white'), null);

// imbalances before any move: doubled rooks on the a-file are one label; both bishop pairs cancel out
assert.deepEqual(imbalances(pos('4r3/R4pk1/2pq1rpp/1p1pn3/1P1Q4/2P1P1P1/4BP1P/R5K1 b - - 2 30')), {
  yours: ['rook on semi-open e-file', 'pawn on c6 backward', 'outpost square c4', 'hole d3', 'hole f3'],
  opponents: ['rook on open a-file', 'pawn on c3 backward', 'outpost square c5'],
  both: ["piece imbalance: your knight for opp's bishop"],
});
assert.deepEqual(imbalances(pos('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')), { yours: null, opponents: null, both: null });
// Silman's b6 and d6 holes (Xie Jun-Larsen): no black pawn can ever cover them and no white pawn defends them yet.
// Only holes a piece can use soon, the two nearest: f6 (the bishop reaches it in 2, as d6) loses the tie to d6
assert.deepEqual(imbalances(pos('r1b2rk1/1p1nqpbp/2p2np1/p3p3/P3P3/2NQBN1P/1PP1BPP1/R4RK1 w - - 0 1')).yours, ['hole b6', 'hole d6']);
// a light-squared bishop can use f5 but not the dark b6 and d6; a knight on d1 reaches f5 and b6 first; one on a1 needs
// 4 moves to b6 and d6, too far to count
assert.deepEqual(holes(pos('4k3/8/2p5/4p3/8/8/8/3BK3 w - - 0 1').board, 'white').map(h => h.square), ['f5']);
assert.deepEqual(holes(pos('4k3/8/2p5/4p3/8/8/8/3NK3 w - - 0 1').board, 'white').map(h => h.square), ['f5', 'b6']);
assert.deepEqual(holes(pos('4k3/8/2p5/4p3/8/8/8/N3K3 w - - 0 1').board, 'white').map(h => h.square), ['f5']);
// routes: own pieces block, an enemy piece can be taken but not passed; no route for pawns
const xl = pos('r1b2rk1/1p1nqpbp/2p2np1/p3p3/P3P3/2NQBN1P/1PP1BPP1/R4RK1 w - - 0 1').board, at = parseSquare;
assert.deepEqual([route(xl, at('f3'), at('d6')), route(xl, at('e3'), at('b6')), route(xl, at('d3'), at('d7')), route(xl, at('d3'), at('d8'), 1), route(xl, at('a4'), at('a5'))],
  [3, 1, 1, undefined, undefined]);
// White's king on e2 while Black's has castled; with both kings home and able to castle there is no imbalance
assert.ok(imbalances(pos('rnbq2n1/ppp3kr/3p3p/8/2BPPPpb/2N1B3/PPP1K3/R2Q3R b - - 0 13')).opponents.includes('king still in the centre'));
assert.ok(!JSON.stringify(imbalances(pos('r3k2r/1pqn1pb1/p2p1np1/N2Pp2p/8/4BP2/PPPQB1PP/R3K2R w KQkq - 6 14'))).includes('king still'));
// without queens the king belongs in the centre
assert.ok(!JSON.stringify(imbalances(pos('r1b2rk1/pp3ppp/2n5/8/8/2N5/PPP2PPP/R1B1KB1R w KQ - 0 12'))).includes('king still'));

// SF 15 terms: middlegame column with all pieces on, endgame column with none, from the asking side's view, in pawns
const evalTable = ['|      Term    |    White    |    Black    |    Total    |', '|              |   MG    EG  |   MG    EG  |   MG    EG  |',
  '|     Mobility |  0.85  1.26 |  0.83  1.20 |  1.00  2.00 |', 'Final evaluation       +0.10 (white side)'];
const fakeSf15 = { until: async () => evalTable };
assert.deepEqual(await sf15Terms(fakeSf15, pos('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), 'white'), { terms: { Mobility: 0.58 }, sides: { Mobility: { yours: 0.49, theirs: -0.48 } } });
assert.deepEqual(await sf15Terms(fakeSf15, pos('4k3/4p3/8/8/8/8/4P3/4K3 w - - 0 1'), 'black'), { terms: { Mobility: -1.15 }, sides: { Mobility: { yours: 0.69, theirs: -0.73 } } });

// the leaf: the last quiet position in the first plies, before an exchange; a line that is all captures falls back to its end
const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
assert.deepEqual(lineToLeaf(pos(start), sanToUci(start, ['e4', 'd5', 'exd5', 'Qxd5'])).leafSans, ['1.e4', 'd5']);
const afterD5 = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
assert.deepEqual(lineToLeaf(pos(afterD5), sanToUci(afterD5, ['exd5', 'Qxd5'])).leafSans, ['2.exd5', 'Qxd5']);
const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
assert.deepEqual(lineToLeaf(pos(afterE4), sanToUci(afterE4, ['e5', 'Nf3', 'Nc6'])).leafSans, ['1...e5', '2.Nf3', 'Nc6']);

// deeper read: a claim survives only if every check holds; the survivors go in after the pawn plan, in words
const cSheet = {
  fen: start, side_to_move: 'White', pawn_plan_only_in_better_line: null, latest_sf_gap: 0.5,
  played: { line_with_evals: '1. you e4 (+0.30) 1... opp e5 (+0.30)', explained_fen: null },
  alternative: { line_with_evals: '1. you d4 (+0.30) 1... opp d5 (+0.30)', explained_at_position_after: '1.d4 d5', explained_fen: 'rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq d6 0 2' },
};
const claims = [
  { concept: 'centre', claim: 'd4 takes the centre.', checks: [
    { pos: 'better:1', op: 'piece_on', args: { square: 'd4' }, expect: 'white pawn' },
    { pos: 'played:1', op: 'piece_on', args: { square: 'd4' }, expect: 'empty' },
    { pos: 'better_leaf', op: 'attackers', args: { square: 'e5', side: 'white' }, expect: { min: 1 } }] },
  { concept: 'wrong', claim: 'x', checks: [{ pos: 'start', op: 'piece_on', args: { square: 'd4' }, expect: 'white pawn' }] },
  { concept: 'broken', claim: 'y', checks: [{ pos: 'start', op: 'attacks', args: { from: 'e4', to: 'e5' }, expect: true }] },
];
const v = verify(cSheet, claims);
assert.deepEqual(v.map(c => [c.verified, c.contrast]), [[true, true], [false, false], [false, false]]);
// checks that cannot be answered fail instead of passing vacuously
const one = (fen, k) => verify({ ...cSheet, fen }, [{ concept: 'c', claim: 'c', checks: [{ pos: 'start', ...k }] }])[0].checks[0];
assert.ok(one(start, { op: 'legal_moves', args: { square: 'g8' }, expect: 0 }).error); // black knight, white to move
assert.ok(one(start, { op: 'passed', args: { square: 'g1' }, expect: true }).error); // not a pawn
const doubled = '4k3/8/8/4P3/4P3/8/8/4K3 w - - 0 1';
assert.deepEqual([one(doubled, { op: 'passed', args: { square: 'e5' }, expect: true }).ok, one(doubled, { op: 'passed', args: { square: 'e4' }, expect: false }).ok], [true, true]);
assert.ok(one(start, { op: 'file_state', args: { file: 'E' }, expect: 'closed' }).ok);
assert.ok(one(start, { op: 'file_state', args: { file: 'z' }, expect: 'open' }).error);
assert.ok(one(start, { op: 'pawns_on_colour', args: { side: 'white', colour: 'white' }, expect: 4 }).error);
assert.ok(verify(cSheet, [{ concept: 'c', claim: 'c', checks: [{ pos: 'played_leaf', op: 'piece_on', args: { square: 'e4' }, expect: 'white pawn' }] }])[0].checks[0].error);
assert.deepEqual(verify(cSheet, [null, { concept: 'c', checks: 'x' }]).map(c => c.verified), [false, false]);
// sides render the same whatever their case
assert.deepEqual(render(cSheet, verify(cSheet, [{ concept: 'k', claim: 'k', checks: [{ pos: 'start', op: 'king_square', args: { side: 'White' }, expect: 'e1' }] }]))[0].checked, ['now, before your move: your king on e1']);
// every board check, once: its value on a board and its wording on the sheet. A row with no case here fails.
const rows = {
  piece_on: [start, { square: 'e7' }, 'black pawn', "e7: opp's pawn"],
  attacks: [start, { from: 'g1', to: 'f3' }, true, 'the piece on g1 attacks f3: yes'],
  attackers: [start, { square: 'f6', side: 'black' }, 3, "opp's pieces attacking f6: 3"], // the g8 knight and two pawns
  defenders: [start, { square: 'e2' }, 4, 'defenders of the piece on e2: 4'],
  piece_squares: [start, { square: 'g1' }, 2, 'the piece on g1 reaches 2 squares'], // f3 and h3; e2 is its own pawn's
  pawn_can_ever_attack: [start, { square: 'e5', side: 'black' }, true, "a pawn of the opponent's can still ever attack e5: yes"],
  outpost: [start, { square: 'e5', side: 'white' }, false, 'e5 is an outpost for you: no'],
  pawns_on_colour: [start, { side: 'black', colour: 'light' }, 4, "opp's pawns on light squares: 4"],
  file_state: [doubled, { file: 'e' }, 'semi-open for black', "e-file: semi-open for opp's rooks"],
  ray_clear: [start, { from: 'a1', to: 'a8' }, false, 'nothing stands between a1 and a8: no'],
  passed: [doubled, { square: 'e5' }, true, 'the pawn on e5 is passed: yes'],
  king_square: [start, { side: 'black' }, 'e8', "opp's king on e8"],
  undeveloped_minors: [start, { side: 'white' }, 4, 'your knights and bishops still on their starting squares: 4'],
  material: [start, { side: 'white' }, 39, 'your material: 39'],
  route: [start, { from: 'g1', to: 'e5' }, 2, 'the piece on g1 can reach e5 in 2 moves, the other pieces standing still'],
  legal_moves: [start, { square: 'g1' }, 2, 'the piece on g1 has 2 legal moves'],
};
assert.deepEqual(Object.keys(rows).sort(), Object.keys(CHECKS).sort());
for (const [op, [fen, args, value, words]] of Object.entries(rows)) {
  const k = one(fen, { op, args, expect: value });
  assert.ok(k.ok, `${op}: ${k.error ?? JSON.stringify(k.value)}`);
  assert.equal(render({ ...cSheet, fen }, [{ verified: true, checks: [k] }])[0].checked[0], `now, before your move: ${words}`);
}
assert.match(one(start, { op: 'toString', args: {}, expect: 'x' }).error, /unknown op/);
// the proposer and the planner are told of every row, and of nothing that is not a row; route is the planner's alone
const told = prompt => [...prompt.matchAll(/^- ([a-z_]+) \{/gm)].map(m => m[1]).sort();
assert.deepEqual(told(PLANNER), Object.keys(CHECKS).sort());
assert.deepEqual(told(PROPOSER), Object.keys(CHECKS).filter(op => op !== 'route').sort());
// the rule picker gets the proposer's check rows word for word, and every rule of the pool; the pool has at most the
// 231 rules stage 0 tested, unique ids and no source
const rowLines = prompt => prompt.split('\n').filter(l => /^- [a-z_]+ \{/.test(l));
assert.deepEqual(rowLines(PICKER), rowLines(PROPOSER));
assert.ok(RULE_POOL.length > 0 && RULE_POOL.length <= 231 && new Set(RULE_POOL.map(r => r.id)).size === RULE_POOL.length);
assert.ok(!/flores/i.test(JSON.stringify(RULE_POOL)) && RULE_POOL.every(r => PICKER.includes(`\n${r.id}: ${r.rule}\n`)));
// the claim list is found past brackets in the reasoning; no list at all is told apart from an empty one
assert.deepEqual(claimsIn('The sheet says [takes pawn]. Claims:\n[{"concept": "a"}]\nDone [ok].'), [{ concept: 'a' }]);
assert.deepEqual([claimsIn('none [here]'), claimsIn('[]')], [null, []]);
assert.match(v[2].checks[0].error, /no piece on e4/);
assert.deepEqual(render(cSheet, v), [{ concept: 'centre', claim: 'd4 takes the centre.', checked: [
  'after 1.d4: d4: your pawn', 'after 1.e4: d4: empty', 'after 1.d4 d5: your pieces attacking e5: 1'] }]);
// a sheet without the field the concepts go after fails loudly, before any LLM call
await assert.rejects(withConcepts({ fen: start }, () => assert.fail('called the LLM')), /pawn_plan_only_in_better_line/);
// a sheet that holds an earlier read's concepts (the eval's --facts on a --deep run): the proposer never sees them,
// and the new ones take their place
{
  const seen = [], again = await withConcepts({ ...cSheet, verified_concepts: ['old'] }, async (system, facts) => (seen.push(facts), JSON.stringify(claims)));
  assert.deepEqual([seen[0], again.facts.verified_concepts], [cSheet, again.concepts]);
  assert.equal(again.concepts[0].concept, 'centre');
}
// Find plan's deeper read: best:N / best_leaf name the plan line's positions; an idea keeps only targets its checks name
const pSheet = {
  fen: start, side_to_move: 'White', plan_kind: 'positional',
  best: { move: 'e4', line_with_evals: '1. you e4 (+0.30) 1... opp e5 (+0.30) 2. you Nf3 (+0.30)', explained_at_position_after: '1.e4 e5 2.Nf3',
    explained_fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' },
  pawn_pushes_in_line: null,
};
const planner = JSON.stringify([
  { concept: 'centre', claim: 'e4 takes the centre and the knight hits e5.', targets: [{ square: 'e5', kind: 'attack' }, { square: 'h7', kind: 'attack' }, { square: 'e4', kind: 'occupy' }, { square: 'e', kind: 'occupy' }],
    checks: [{ pos: 'best:1', op: 'piece_on', args: { square: 'e4' }, expect: 'white pawn' }, { pos: 'best_leaf', op: 'attacks', args: { from: 'f3', to: 'e5' }, expect: true },
      { pos: 'best_leaf', op: 'file_state', args: { file: 'e' }, expect: 'closed' }] },
  { concept: 'wrong', claim: 'x', targets: [{ square: 'd4', kind: 'occupy' }], checks: [{ pos: 'start', op: 'piece_on', args: { square: 'd4' }, expect: 'white pawn' }] }]);
const pr = await withPlan(pSheet, (system, f, model) => (assert.deepEqual([system, model], [PLANNER, 'claude-fable-5-2']), planner)); // the default pick's ideas model
assert.deepEqual(pr.ideas, [{ concept: 'centre', claim: 'e4 takes the centre and the knight hits e5.',
  checked: ['after 1.e4: e4: your pawn', 'after 1.e4 e5 2.Nf3: the piece on f3 attacks e5: yes', 'after 1.e4 e5 2.Nf3: e-file: closed'],
  targets: [{ square: 'e5', kind: 'attack' }, { square: 'e4', kind: 'occupy' }] }]);
assert.deepEqual(Object.keys(pr.facts).slice(-2), ['verified_plan_ideas', 'pawn_pushes_in_line']);
// a reply with no idea list is told apart from one whose ideas all failed
const unread = await withPlan(pSheet, async () => 'No plan.'), noneHeld = await withPlan(pSheet, async () => '[]');
assert.deepEqual([unread.ideas, unread.read, noneHeld.ideas, noneHeld.read], [null, false, null, true]);
assert.equal(pr.read, true);
// a saved plan sheet to its plan, as the eval's --facts does: the planner, then the writer, both with their own prompt
const pCalls = [];
const pa = await planAnswer(pSheet, (system, f, model) => (pCalls.push([system, model]), system === PLANNER ? planner : 'Play 1.e4.'), { model: 'claude-fable-5-2' });
assert.deepEqual(pCalls, [[PLANNER, 'claude-fable-5-2'], [PLAN_SYSTEM, 'claude-fable-5-2']]); // the picked model plans and writes
// a pick of two models, joined by '+': the first makes the ideas call, the second writes
assert.deepEqual([stepModels('m1'), stepModels('m1+m2')], [{ ideas: 'm1', writer: 'm1' }, { ideas: 'm1', writer: 'm2' }]);
pCalls.length = 0;
await planAnswer(pSheet, (system, f, model) => (pCalls.push([system, model]), system === PLANNER ? planner : 'Play 1.e4.'), { model: 'm1+m2' });
assert.deepEqual(pCalls, [[PLANNER, 'm1'], [PLAN_SYSTEM, 'm2']]);
assert.deepEqual([pa.text, pa.ideas, pa.facts.verified_plan_ideas], ['Play 1.e4.', pr.ideas, pr.ideas]);
await assert.rejects(planAnswer(pSheet, async () => 'No plan.'), /Could not read the plan ideas in the reply/);
await assert.rejects(planAnswer(pSheet, async () => '[]'), /No clear plan found here/);
// the board: an arrow for the first move, circles only on targets the text names, red to attack, at most 4
assert.deepEqual(planShapes(pSheet, pr.ideas, 'Play 1.e4, then hit **e5**.'),
  [{ orig: 'e2', dest: 'e4', brush: 'green' }, { orig: 'e5', brush: 'red' }, { orig: 'e4', brush: 'green' }]);
assert.deepEqual(planShapes(pSheet, pr.ideas, 'Nothing named; Ne55 is no square.'), [{ orig: 'e2', dest: 'e4', brush: 'green' }]);
const many = [{ targets: ['a3', 'b3', 'c3', 'd3', 'f3'].map(square => ({ square, kind: 'occupy' })) }];
assert.equal(planShapes(pSheet, many, 'a3 b3 c3 d3 f3').length, 5);
// the lichess board, on a fake of lichess's page: its analysis controller, its sounds and the user tag. Each page
// function is re-parsed from its source text, as chrome.scripting sends it, so one that leans on a name from
// lichess.js fails here too.
{
  const other = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1';
  const fakePage = ({ allowed = true, engineOn = true, study, ongoing = false, data } = {}) => {
    const cg = () => ({ drawn: null, setAutoShapes(shapes) { this.drawn = shapes; } });
    const nodes = { '': { fen: start, children: [{ san: 'e4' }], ceval: { pvs: [{ moves: ['d2d4', 'd7d5'] }] } }, zz: { fen: other, children: [] } };
    const sounds = [];
    const ctrl = {
      path: '', node: nodes[''], chessground: cg(),
      isCevalAllowed: () => allowed, cevalEnabled: () => engineOn, study, ongoing, data,
      userJumpIfCan(path) { if (nodes[path]) [ctrl.path, ctrl.node] = [path, nodes[path]]; },
      playUciList(ucis) {
        for (const uci of ucis) {
          ctrl.path += uci;
          ctrl.node = nodes[ctrl.path] = { fen: `after ${ctrl.path}`, children: [] };
          globalThis.window.site.sound.move(ctrl.node);
        }
      },
      setChessground(c) { ctrl.chessground = c; },
      setAutoShapes() { ctrl.chessground.setAutoShapes(['auto']); },
    };
    globalThis.window = { site: { analysis: ctrl, sound: { move: node => sounds.push(node.fen) } } };
    globalThis.document = { querySelector: sel => sel === '#user_tag' && { textContent: ' fable6 ' } };
    return { ctrl, sounds, cg };
  };
  const board = lichessBoard(async (func, args = []) => new Function(`return (${func})`)()(...args));
  // one read for both flows; lichess's top move only while lichess shows its engine
  let page = fakePage();
  assert.deepEqual(await board.read(), { fen: start, path: '', best: 'd2d4', next: 'e4', user: 'fable6', ahead: [], game: null });
  // the game: the study chapter's id, else the game's; none on a board that is no game
  fakePage({ data: { game: { id: 'AbCd1234' } } });
  assert.equal((await board.read()).game, 'AbCd1234');
  fakePage({ data: { game: { id: 'synthetic' } } });
  assert.equal((await board.read()).game, null);
  fakePage({ data: { game: { id: 'synthetic' } }, study: { data: { chapter: { id: 'ch4pt3r1' } } } });
  assert.equal((await board.read()).game, 'ch4pt3r1');
  fakePage({ engineOn: false });
  assert.equal((await board.read()).best, undefined);
  // the rule, decided in read(): where lichess allows its engine, and it fails closed
  const refused = /does not allow its engine here \(a game in progress, or a broadcast\)/;
  fakePage({ allowed: false });
  await assert.rejects(board.read(), refused);
  delete fakePage().ctrl.isCevalAllowed;
  await assert.rejects(board.read(), refused);
  // and in a study where lichess does not allow it: computer analysis turned off, or an interactive lesson
  fakePage({ allowed: false, engineOn: false, study: {} });
  assert.deepEqual(await board.read(), { fen: start, path: '', best: undefined, next: 'e4', user: 'fable6', ahead: [], game: null });
  // but not in a broadcast or with a game in progress; an `ongoing` that cannot be read fails closed
  for (const page of [{ study: { relay: {} } }, { study: {}, ongoing: true }, { study: {}, ongoing: null }]) {
    fakePage({ allowed: false, ...page });
    await assert.rejects(board.read(), refused);
  }
  // the same side's next two turns on the game line (first children, two and four plies on), each with its next
  // move; one with no next move is left out
  page = fakePage();
  const n5 = { id: 'ee', san: 'Bb5', fen: 'f5', children: [] }, n4 = { id: 'dd', san: 'Nc6', fen: 'f4', children: [n5] };
  const n3 = { id: 'cc', san: 'Nf3', fen: 'f3', children: [n4] }, n2 = { id: 'bb', san: 'e5', fen: 'f2', children: [n3] };
  const n1 = { id: 'aa', san: 'e4', fen: 'f1', children: [n2, { id: 'xx', san: 'c5', fen: 'side line', children: [{ san: 'Nf3' }] }] };
  Object.assign(page.ctrl, { path: '', node: { fen: start, children: [n1] } });
  assert.deepEqual((await board.read()).ahead, [{ fen: 'f2', path: 'aabb', next: 'Nf3' }, { fen: 'f4', path: 'aabbccdd', next: 'Bb5' }]);
  Object.assign(page.ctrl, { path: 'aa', node: n1 });
  assert.deepEqual((await board.read()).ahead, [{ fen: 'f3', path: 'aabbcc', next: 'Nc6' }]);
  fakePage();
  delete globalThis.window.site.analysis;
  await assert.rejects(board.read(), /Open a lichess analysis board or study/);
  // a line: back to the position that was read, the moves played from there, one sound for the last, sounds restored
  page = fakePage();
  page.ctrl.userJumpIfCan('zz');
  const soundMove = globalThis.window.site.sound.move;
  await board.play(start, '', ['e2e4', 'e7e5']);
  assert.equal(page.ctrl.path, 'e2e4e7e5');
  assert.deepEqual(page.sounds, ['after e2e4e7e5']);
  assert.equal(globalThis.window.site.sound.move, soundMove);
  await assert.rejects(board.play('8/8/8/8/8/8/8/8 w - - 0 1', '', ['e2e4']), /Could not go back to the explained position/);
  // no moves: the board only goes to the position (the about-equal verdict's Find plan)
  page = fakePage();
  await board.play(other, 'zz', []);
  assert.equal(page.ctrl.path, 'zz');
  assert.deepEqual(page.sounds, []);
  // shapes: added to lichess's own on the position they belong to, kept when lichess rebuilds the board, then cleared
  page = fakePage();
  const arrow = { orig: 'e2', dest: 'e4', brush: 'green' };
  await board.draw(start, [arrow]);
  assert.deepEqual(page.ctrl.chessground.drawn, ['auto', arrow]);
  page.ctrl.userJumpIfCan('zz');
  page.ctrl.setAutoShapes();
  assert.deepEqual(page.ctrl.chessground.drawn, ['auto']);
  page.ctrl.userJumpIfCan('');
  page.ctrl.setChessground(page.cg());
  page.ctrl.setAutoShapes();
  assert.deepEqual(page.ctrl.chessground.drawn, ['auto', arrow]);
  await board.clear();
  assert.deepEqual(page.ctrl.chessground.drawn, ['auto']);
  delete globalThis.window;
  delete globalThis.document;
}
// one Messages API call: the system prompt, the sheet as the user message, the reply's text
let sent;
globalThis.fetch = async (url, { body }) => ((sent = JSON.parse(body)),
  Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fine.' }] }));
assert.equal(await anthropic(PROPOSER, cSheet, 'key', 'claude-opus-5-5'), 'Fine.');
const cached = text => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
assert.deepEqual([sent.model, sent.system, sent.messages], ['claude-opus-5-5', cached(PROPOSER), [{ role: 'user', content: JSON.stringify(cSheet, null, 1) }]]);
// prompt caching: with depth on, the proposer's prompt and then the explainer's and the rule picker's go as one cached block each
{
  const seen = [];
  globalThis.fetch = async (url, { body }) => (seen.push(JSON.parse(body).system), Response.json({ stop_reason: 'end_turn',
    content: [{ type: 'text', text: seen.length === 1 ? JSON.stringify(claims) : 'Fine.' }] }));
  const r = await answer(cSheet, llmWith('key'), { model: 'claude-opus-5-5', depth: true });
  assert.deepEqual([r.text, r.concepts.length], ['Fine.', 1]);
  assert.deepEqual(seen, [cached(PROPOSER), cached(systemFor(true)), cached(PICKER)]);
}
// streaming: with onText the reply comes as server-sent events, cut here at awkward bytes (mid-line, mid-event, inside
// a UTF-8 character). onText hears the text so far after each piece; thinking and the fallback block add none; the text
// returned is the unstreamed one. An error event throws and closes the connection; a refusal stop is the decline, as
// unstreamed. A stream that stops arriving says so; so does a reply that cannot be read.
{
  const parts = ['**Nf3** keeps ', 'the knight — and ', 'wins the e5 pawn.'];
  const sse = events => {
    const bytes = new TextEncoder().encode(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(''));
    const cuts = [...Array(Math.ceil(bytes.length / 9)).keys()].map(i => i * 9).concat(bytes.indexOf(0xe2) + 1, bytes.length).sort((a, b) => a - b);
    return new ReadableStream({ start(c) { cuts.slice(1).forEach((end, i) => c.enqueue(bytes.slice(cuts[i], end))); c.close(); }, cancel() { cancelled++; } });
  };
  let cancelled = 0;
  const delta = (index, delta) => ['content_block_delta', { index, delta }];
  const transcript = (stop, mid = []) => [
    ['message_start', { message: { id: 'msg', role: 'assistant', content: [] } }],
    ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }],
    delta(0, { type: 'thinking_delta', thinking: '' }), delta(0, { type: 'signature_delta', signature: 'sig' }),
    ['content_block_stop', { index: 0 }],
    ['content_block_start', { index: 1, content_block: { type: 'text', text: '' } }],
    ['ping', {}], delta(1, { type: 'text_delta', text: parts[0] }), ...mid, delta(1, { type: 'text_delta', text: parts[1] }),
    ['content_block_stop', { index: 1 }],
    ['content_block_start', { index: 2, content_block: { type: 'fallback' } }], ['content_block_stop', { index: 2 }],
    ['content_block_start', { index: 3, content_block: { type: 'text', text: '' } }],
    delta(3, { type: 'text_delta', text: parts[2] }), ['content_block_stop', { index: 3 }],
    ['message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 9 } }], ['message_stop', {}]];
  let events, streamedReq;
  globalThis.fetch = async (url, { body }) => {
    const b = JSON.parse(body);
    if (!b.stream) return Response.json({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: parts[0] + parts[1] },
      { type: 'fallback' }, { type: 'text', text: parts[2] }] });
    streamedReq = b;
    return new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } });
  };
  const heard = [];
  events = transcript('end_turn');
  const text = await anthropic(PROPOSER, cSheet, 'key', 'claude-opus-5-5', t => heard.push(t));
  assert.deepEqual(heard, [parts[0], parts[0] + parts[1], parts.join('')]);
  assert.equal(text, parts.join(''));
  assert.equal(text, await anthropic(PROPOSER, cSheet, 'key', 'claude-opus-5-5'));
  assert.deepEqual([streamedReq.stream, streamedReq.fallbacks, streamedReq.system], [true, 'default', cached(PROPOSER)]);
  events = transcript('end_turn', [['error', { error: { type: 'overloaded_error', message: 'Overloaded' } }]]);
  await assert.rejects(anthropic(PROPOSER, cSheet, 'key', 'claude-opus-5-5', () => {}), /Anthropic API error: Overloaded/);
  assert.equal(cancelled, 1);
  events = transcript('refusal');
  assert.equal(await anthropic(PROPOSER, cSheet, 'key', 'claude-opus-5-5', () => {}), '(the model declined to answer)');
  events = transcript('end_turn').slice(0, -2); // cut off before its stop reason: not an answer
  await assert.rejects(anthropic(PROPOSER, cSheet, 'key', 'claude-opus-5-5', () => {}), /cut off/);
  assert.equal(cancelled, 1); // a stream read to its end has nothing left to close
  globalThis.fetch = async () => new Response(new ReadableStream({ pull(c) { c.error(new Error('timed out')); } }));
  await assert.rejects(anthropic(PROPOSER, cSheet, 'key', 'claude-opus-5-5', () => {}), /stopped arriving \(timed out\)/);
  globalThis.fetch = async () => new Response('<html>');
  await assert.rejects(anthropic(PROPOSER, cSheet, 'key', 'claude-opus-5-5'), /Could not read the reply/);
}
// the deeper read's prompt is the plain one plus the "verified_concepts" entry
assert.ok(systemFor(true).includes('"verified_concepts"') && systemFor(true)
  .replace(/\n- "verified_concepts"[^]*?swing in the lines still comes first\./, '') === systemFor());
// recent reasons: their entry goes after the "verified_concepts" entry, or after the pawn plan's without it
{
  const entry = `
- "recent_reasons" (when not null) are reasons already given for earlier moves of this game ("said": the earlier answer's
  first sentence; "ideas": its positional ideas). Do not repeat one unless it is the decisive point here, and then say so briefly.`;
  const end = 'swing in the lines still comes first.', pawnEnd = "better move cleared that pawn's way. See rule 13.";
  assert.equal(systemFor(true, true), systemFor(true).replace(end, end + entry));
  assert.equal(systemFor(false, true), systemFor().replace(pawnEnd, pawnEnd + entry));
  assert.equal(systemFor(true, false), systemFor(true));
}
// eval --deep gives both judges the same entry
for (const p of [JUDGE, PAIR]) assert.ok(withConceptsEntry(p).includes('"verified_concepts"'));

// fair play, with a lichess status stub (the real user may be in a game when CI runs): fail closed
globalThis.fetch = async url => {
  const id = new URL(url).searchParams.get('ids');
  return Response.json(id === 'zz_no_such_user_zz' ? [] : [{ id, playing: id === 'in_a_game' }]);
};
await checkNotPlaying('fable6');
for (const user of [undefined, 'zz_no_such_user_zz', 'in_a_game']) await assert.rejects(checkNotPlaying(user), Refused);
// one panel request: a refused one never asks for the engines and never runs its task (so no LLM either)
for (const user of [undefined, 'in_a_game'])
  await assert.rejects(request({ user, engines: () => assert.fail('asked for the engines'), llm: 'the llm' }, () => assert.fail('ran the task')), Refused);
// a free user: lichess is asked, then the engines are, then the task runs with them and the LLM; each stage is named
{
  const order = [], status = globalThis.fetch;
  globalThis.fetch = (...args) => (order.push('lichess asked'), status(...args));
  const got = await request({ user: 'fable6', engines: async () => (order.push('engines asked for'), 'the engines'), llm: 'the llm', onStep: s => order.push(s) },
    (e, llm) => (order.push('task'), [e, llm]));
  assert.deepEqual(got, ['the engines', 'the llm']);
  assert.deepEqual(order, ['Checking you are not in a game', 'lichess asked', 'Starting Stockfish', 'engines asked for', 'task']);
}
// a dead engine: the request it is on rejects, and so does every later one; one that died idle rejects the next request
{
  const sent = [], dead = uciEngine(l => sent.push(l));
  const on = dead.until(['go nodes 1'], l => l.startsWith('bestmove')), queued = dead.until(['isready'], l => l === 'readyok');
  await new Promise(setImmediate);
  assert.deepEqual(sent, ['go nodes 1']); // the first request is with the engine, the second waits its turn
  dead.fail(new Error('Stockfish crashed'));
  const idle = uciEngine(() => {});
  idle.fail(new Error('Stockfish crashed'));
  for (const r of await Promise.allSettled([on, queued, dead.until(['isready'], () => true), idle.until(['isready'], () => true)]))
    assert.equal(r.reason?.message, 'Stockfish crashed');
  // a live one still answers
  const live = uciEngine(l => queueMicrotask(() => live.onLine(l === 'isready' ? 'readyok' : l)));
  assert.deepEqual(await live.until(['isready'], l => l === 'readyok'), ['readyok']);
}
// a fact sheet explainMove can show and keepReason can keep
const xSheet = { ...cSheet, played: { ...cSheet.played, move: 'e4', latest_sf_eval: '+0.30' }, alternative: { ...cSheet.alternative, move: 'd4', latest_sf_eval: '+0.30' } };
// the answer cache, through explainRequest: the same request again shows the saved result after lichess's status check
// alone (no engine, no LLM); a game in progress still refuses it; another best, depth or version asks afresh; so does
// Ask again. The same two moves are the same request: no best finds the answer saved for a best, and a best finds the
// one saved without, when it is that answer's engine move. An about-equal verdict is never saved
{
  const status = globalThis.fetch, data = {};
  const storage = { get: async k => structuredClone({ [k]: data[k] }), set: async o => void Object.assign(data, structuredClone(o)) };
  let asked, started, reply = 'Saved.';
  globalThis.fetch = async (url, init) => (asked.push(new URL(url).host), url.startsWith('https://api.anthropic.com/')
    ? Response.json(reply ? { stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] } : { stop_reason: 'refusal', content: [] })
    : status(url, init));
  const base = { user: 'fable6', fen: 'the fen', move: 'Nf3', best: 'd2d4', model: 'claude-opus-5-5', depth: true, version: '0.62' };
  const explain = async (req, opts) => {
    asked = [], started = 0;
    const got = await explainRequest(storage, { user: req.user, fen: req.fen, path: '', game: null, best: req.best }, req.move,
      { depth: req.depth, model: req.model, version: req.version, engines: async () => (started++, 'the engines'), llm: llmWith('key'), sheet: async () => xSheet, ...opts });
    return [got.result.text, got.saved, [...new Set(asked)], started]; // a deeper read asks the API twice
  };
  const fresh = ['Saved.', false, ['lichess.org', 'api.anthropic.com'], 1];
  assert.deepEqual(await explain(base), fresh);
  assert.deepEqual(await explain(base), ['Saved.', true, ['lichess.org'], 0]);
  await assert.rejects(explain({ ...base, user: 'in_a_game' }), Refused);
  assert.deepEqual([asked, started], [['lichess.org'], 0]);
  for (const other of [{ best: 'e2e4' }, { depth: false }, { model: 'claude-fable-5-2' }, { version: '0.63' }])
    assert.deepEqual(await explain({ ...base, ...other }), fresh);
  const served = ['Saved.', true, ['lichess.org'], 0];
  assert.deepEqual(await explain({ ...base, best: null }), served);
  const unset = { ...base, fen: start, move: 'e4', best: null }; // xSheet compares e4 with d4
  assert.deepEqual(await explain(unset), fresh);
  assert.deepEqual(await explain({ ...unset, best: 'd2d4' }), served);
  assert.deepEqual(await explain({ ...unset, best: 'c2c4' }), fresh);
  assert.deepEqual(await explain(unset), served);
  // Ask again with a best: its answer, saved beside the one without a best, is the one both requests find next
  reply = 'Again.';
  assert.deepEqual(await explain({ ...unset, best: 'd2d4' }, { fresh: true }), ['Again.', false, ['lichess.org', 'api.anthropic.com'], 1]);
  assert.deepEqual([(await explain({ ...unset, best: 'd2d4' }))[0], (await explain(unset))[0]], ['Again.', 'Again.']);
  const equal = { sheet: async () => ({ ...xSheet, latest_sf_gap: 0.1 }) };
  for (let i = 0; i < 2; i++)
    assert.deepEqual((await explain({ ...base, fen: 'an equal fen' }, equal)).slice(1), [false, ['lichess.org'], 1]);
  reply = 'Asked again.';
  assert.deepEqual(await explain(base, { fresh: true }), ['Asked again.', false, ['lichess.org', 'api.anthropic.com'], 1]);
  assert.deepEqual((await explain(base))[0], 'Asked again.'); // the fresh answer replaced the saved one
  // a decline is not saved
  reply = null;
  const declined = { ...base, fen: 'another fen' };
  assert.deepEqual(await explain(declined), ['(the model declined to answer)', false, ['lichess.org', 'api.anthropic.com'], 1]);
  assert.equal((await explain(declined))[1], false);
  // at most 200 answers, the oldest dropped first
  for (let i = 0; i < 200; i++) await remembered(storage, { ...base, fen: i }, async () => ({ result: { text: 'x' }, facts: xSheet }));
  assert.deepEqual([data.answers.length, data.answers[0][0], data.answers.at(-1)[0]],
    [200, '0 | Nf3 | d2d4 | depth | claude-opus-5-5 | 0.62', '199 | Nf3 | d2d4 | depth | claude-opus-5-5 | 0.62']);
  // a storage that fails (get or set) still shows the answer just paid for
  const logged = console.error, gone = async () => { throw new Error('gone'); };
  console.error = () => {};
  for (const broken of [{ get: gone, set: gone }, { ...storage, set: gone }])
    assert.equal((await remembered(broken, base, async () => ({ result: { text: 'x' }, facts: xSheet }), { fresh: true })).result.text, 'x');
  console.error = logged;
}
// remembered reasons: an answer's first sentence and its move with its number
assert.equal(firstSentence('\n  **Nf3** keeps the e5 pawn. It also develops!\nNext time: x.'), '**Nf3** keeps the e5 pawn.');
assert.equal(firstSentence('After 12.Nf3 you win! Then'), 'After 12.Nf3 you win!');
assert.equal(firstSentence('No full stop'), 'No full stop');
assert.deepEqual([moveLabel(start, 'e4'), moveLabel(afterE4, 'e5')], ['1. e4', '1... e5']);
// the reasons per game: the last 4 moves of each, at most 50 games; a position gets those of earlier moves of its line
// (strict path prefixes), oldest first, never another game's; a decline or an about-equal verdict is not kept
{
  const data = {}, storage = { get: async k => structuredClone({ [k]: data[k] }), set: async o => void Object.assign(data, structuredClone(o)) };
  const facts = { fen: start, played: { move: 'e4' }, latest_sf_gap: 0.5 };
  const keep = (game, path, text, more = {}) => keepReason(storage, game, path, 'e4', { text, facts, concepts: null, ...more });
  await keep('g1', 'aa', 'First. More.', { concepts: [{ concept: 'centre' }] });
  await keep('g1', 'aabb', 'Second.');
  await keep('g1', 'aabbcc', 'Side line.');
  await keep('g1', 'aadd', 'Other branch.');
  await keep('g2', 'aa', 'Other game.');
  await keep(null, 'aa', 'No game.');
  await keep('g1', 'aabbccee', '(the model declined to answer)');
  await keep('g1', 'aabbccee', 'Equal.', { facts: { ...facts, latest_sf_gap: 0.1 } });
  assert.deepEqual(await recentReasons(storage, 'g1', 'aabbccee'), [
    { move: '1. e4', said: 'First.', ideas: ['centre'] }, { move: '1. e4', said: 'Second.', ideas: [] }, { move: '1. e4', said: 'Side line.', ideas: [] }]);
  assert.deepEqual((await recentReasons(storage, 'g1', 'aabb')).map(r => r.said), ['First.']); // not its own
  assert.deepEqual(await recentReasons(storage, 'g3', 'aabb'), []);
  assert.deepEqual(await recentReasons(storage, null, 'aabb'), []);
  await keep('g1', 'aabbccff', 'Fifth.');
  assert.deepEqual(data.reasons.find(([g]) => g === 'g1')[1].map(e => e.said), ['Second.', 'Side line.', 'Other branch.', 'Fifth.']);
  // the compared move was the better one: the sheet's played is the best other move, the reason is the compared move's
  await keepReason(storage, 'g4', 'aa', 'd2d4', { text: 'Better.', facts: { ...facts, alternative: { move: 'd4' } }, concepts: null });
  assert.deepEqual(await recentReasons(storage, 'g4', 'aabb'), [{ move: '1. d4', said: 'Better.', ideas: [] }]);
  for (let i = 0; i < 50; i++) await keep(`n${i}`, 'aa', 'x.');
  assert.deepEqual([data.reasons.length, data.reasons[0][0]], [50, 'n0']);
}
// answer(): the reasons go last in the writer's facts only, with their legend entry; without any, nothing changes
{
  for (const depth of [false, true]) {
    const calls = [], picked = [];
    const llm = async (system, facts) => (system === PICKER ? (picked.push(facts), '[]') : (calls.push([system, facts]), system === PROPOSER ? JSON.stringify(claims) : 'Fine.'));
    const recent = [{ move: '1. e4', said: 'First.', ideas: [] }];
    await answer(cSheet, llm, { depth, recent });
    await answer(cSheet, llm, { depth, recent: [] });
    const [w, plain] = depth ? [calls[1], calls[3]] : [calls[0], calls[1]];
    if (depth) assert.ok(!('recent_reasons' in calls[0][1]) && !('recent_reasons' in calls[2][1])); // the proposer's
    assert.deepEqual(picked, [plain[1], plain[1]]); // the rule picker's: the writer's facts, without the reasons
    assert.deepEqual(Object.keys(w[1]), [...Object.keys(plain[1]), 'recent_reasons']);
    assert.deepEqual(w[1].recent_reasons, recent);
    assert.equal(w[0], systemFor(depth, true));
    assert.equal(plain[0], systemFor(depth));
    assert.deepEqual(plain[1], depth ? (await withConcepts(cSheet, async () => JSON.stringify(claims))).facts : cSheet);
  }
}
// the rule line (withRule): a pool rule whose checks all hold, as "Rule:" / "Here:", a followed rule before a bent one;
// a failing check, no check, an unknown id, another kind, an empty tie or one over 12 words, no list or a picker that
// throws: null
{
  const d4 = [{ pos: 'better:1', op: 'piece_on', args: { square: 'd4' }, expect: 'white pawn' }];
  const pick = (rule, kind = 'follows', here = 'your d4 pawn', checks = d4) => ({ rule, kind, here, checks });
  const line = (...picks) => withRule(cSheet, async (system, f, model) => (assert.deepEqual([system, f, model], [PICKER, cSheet, 'claude-fable-5-2']), JSON.stringify(picks)));
  const [a, b] = RULE_POOL, said = r => r.rule[0].toLowerCase() + r.rule.slice(1);
  assert.equal(await line(pick(a.id)), `Rule: ${said(a)}\nHere: your d4 pawn`);
  assert.equal(await line(pick(a.id, 'bent'), pick(b.id)), `Rule: ${said(b)}\nHere: your d4 pawn`);
  assert.equal(await line(pick(a.id, 'bent')), `Rule bent: ${said(a)}\nHere: your d4 pawn`);
  for (const bad of [pick(a.id, 'follows', 'x', [{ ...d4[0], expect: 'empty' }]), pick(a.id, 'follows', 'x', []), pick('Z9-999'), pick(a.id, 'maybe'),
    pick(a.id, 'follows', ' '), pick(a.id, 'follows', 'word '.repeat(13))])
    assert.equal(await line(bad), null);
  assert.equal(await withRule(cSheet, async () => 'No rule.'), null);
  assert.equal(await withRule(cSheet, async () => { throw new Error('down'); }), null);
  // in answer(): the rule line takes the place of the "Next time:" line, or closes a text that has none; no rule line
  // (a failing check, an unknown id, a picker that throws) leaves the text as written, and a decline stays a decline
  const text = 'd4 takes the centre.\nNext time: ask what e4 gives up.', rule = `Rule: ${said(a)}\nHere: your d4 pawn`;
  const good = JSON.stringify([pick(a.id)]);
  const run = async (reply, written = text) => (await answer(cSheet, async system => {
    if (system !== PICKER) return written;
    if (reply instanceof Error) throw reply;
    return reply;
  })).text;
  assert.equal(await run(good), `d4 takes the centre.\n${rule}`);
  assert.equal(await run(good, 'd4 takes the centre.\n\n**Next time:** ask.\n'), `d4 takes the centre.\n\n${rule}`);
  assert.equal(await run(good, 'd4 takes the centre.'), `d4 takes the centre.\n${rule}`);
  for (const reply of [JSON.stringify([pick(a.id, 'follows', 'x', [{ ...d4[0], expect: 'empty' }])]), JSON.stringify([pick('Z9-999')]), new Error('down')])
    assert.equal(await run(reply), text);
  assert.equal(await run(good, DECLINED), DECLINED);
  // the stream: until the picker settles (after the writer's last piece), nothing from "Next time:" on shows, nor a
  // last line that may yet become it; then the closed text, once
  let settle;
  const heard = [], pieces = ['d4 takes', ' the centre.\nN', 'ext ti', 'me: ask what e4 gives up.'];
  const streamed = answer(cSheet, (system, f, model, onText) => (system === PICKER ? new Promise(r => { settle = () => r(good); })
    : (async () => { let t = ''; for (const p of pieces) onText(t += p); return t; })()), { onText: t => heard.push(t) });
  await new Promise(setImmediate);
  assert.deepEqual(heard, ['d4 takes', 'd4 takes the centre.\n', 'd4 takes the centre.\n', 'd4 takes the centre.\n']);
  settle();
  assert.deepEqual([(await streamed).text, heard.slice(4)], [`d4 takes the centre.\n${rule}`, [`d4 takes the centre.\n${rule}`]]);
}
// a walk through a game with explainRequest: each position is paid for once, though the reasons sent with it change
// after every answer. Forward 1 to 6, back 6 to 1, forward again, then move 7 three times: 7 paid runs of 21 requests.
// Each paid run sends the reasons kept for the earlier moves of its line, and keeps its own
{
  const data = {}, storage = { get: async k => structuredClone({ [k]: data[k] }), set: async o => void Object.assign(data, structuredClone(o)) };
  globalThis.fetch = async url => Response.json([{ id: new URL(url).searchParams.get('ids'), playing: false }]);
  const paid = [], steps = [];
  const llm = async (system, facts) => (system === PICKER ? '[]' : (paid.push(facts.recent_reasons?.map(r => r.said) ?? []), `Reason ${paid.length}.`));
  const explain = async path => (await explainRequest(storage, { user: 'fable6', fen: `fen@${path}`, path, game: 'g1', best: null }, 'e4',
    { depth: false, version: '0.64', engines: async () => 'the engines', llm, sheet: async () => xSheet, onRun: () => steps.push('run'), onStep: s => steps.push(s) }));
  const p = n => 'aabbccddeeffgghh'.slice(0, n * 2), plies = [1, 2, 3, 4, 5, 6];
  const said = [];
  for (const n of [...plies, ...plies.toReversed(), ...plies]) said.push((await explain(p(n))).result.text);
  assert.deepEqual(said, [...plies, ...plies.toReversed(), ...plies].map(n => `Reason ${n}.`));
  const again = [];
  for (let i = 0; i < 3; i++) again.push(await explain(p(7)));
  assert.deepEqual(again.map(g => [g.result.text, g.saved]), [['Reason 7.', false], ['Reason 7.', true], ['Reason 7.', true]]);
  assert.equal(paid.length, 7);
  assert.deepEqual([paid[0], paid[5], paid[6]], [[], ['Reason 2.', 'Reason 3.', 'Reason 4.', 'Reason 5.'],
    ['Reason 3.', 'Reason 4.', 'Reason 5.', 'Reason 6.']]); // the last 4 kept
  assert.deepEqual(steps.slice(0, 5), ['run', 'Checking you are not in a game', 'Starting Stockfish', 'Analysing e4', 'Asking Claude']);
  // other reasons sent with the same position serve its saved answer
  const req = { user: 'fable6', fen: `fen@${p(3)}`, move: 'e4', best: null, depth: false, version: '0.64', recent: [{ move: '1. e4', said: 'Else.', ideas: [] }] };
  assert.deepEqual((await remembered(storage, req, async () => assert.fail('paid again'))).result.text, 'Reason 3.');
  // a failed reason save still shows the answer just paid for
  const logged = console.error;
  console.error = () => {};
  const broken = { get: storage.get, set: async o => { if (o.reasons) throw new Error('gone'); return storage.set(o); } };
  const got = await explainRequest(broken, { user: 'fable6', fen: 'new', path: 'zz', game: 'g1', best: null }, 'e4',
    { depth: false, version: '0.64', engines: async () => 'the engines', llm, sheet: async () => xSheet });
  console.error = logged;
  assert.deepEqual([got.result.text, got.saved], ['Reason 8.', false]);
}
// the sheets of the next moves, built ahead on fake engines. A search answers a millisecond later, or at once on `stop`,
// with the first legal moves, scored by the position and by the searches the engine ran since ucinewgame (as its hash
// table would), so a command an aborted build sent after the next build's ucinewgame would change that build's sheet
{
  globalThis.fetch = async url => { const id = new URL(url).searchParams.get('ids'); return Response.json([{ id, playing: id === 'in_a_game' }]); };
  const sent = [], searches = () => sent.filter(l => l.startsWith('go ')).length;
  const hash = t => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_003, 7);
  const legal = p => [...p.allDests()].flatMap(([from, to]) => [...to].filter(t => p.board.getRole(from) !== 'king' || Math.abs(from % 8 - t % 8) < 2)
    .map(t => makeUci({ from, to: t, promotion: p.board.getRole(from) === 'pawn' && (t < 8 || t >= 56) ? 'queen' : undefined }))).sort();
  const fake = () => {
    let n = 0, multipv = 1, fen, pending = null;
    const say = (...ls) => setImmediate(() => ls.forEach(l => e.onLine(l)));
    const e = uciEngine(line => {
      sent.push(line);
      if (line === 'ucinewgame') n = 0;
      else if (line === 'isready') say('readyok');
      else if (line === 'eval') say('Final evaluation +0.10 (white side)');
      else if (line.startsWith('setoption name MultiPV value ')) multipv = Number(line.split(' ').pop());
      else if (line.startsWith('position fen ')) fen = line.slice(13);
      else if (line === 'stop') pending?.();
      else if (line.startsWith('go ')) {
        const p = pos(fen), firsts = (line.split(' searchmoves ')[1]?.split(' ') ?? legal(p)).slice(0, multipv), k = n++;
        const pv = m => { const q = p.clone(), out = [m]; q.play(parseUci(m)); while (out.length < 3 && legal(q).length) { out.push(legal(q)[0]); q.play(parseUci(out.at(-1))); } return out; };
        const infos = firsts.map((m, i) => `info depth 1 multipv ${i + 1} score cp ${hash(fen + m) % 300 - 150 + k} pv ${pv(m).join(' ')}`);
        const t = setTimeout(() => pending(), 1);
        pending = () => { clearTimeout(t); pending = null; say(...infos, `bestmove ${firsts[0] ?? '(none)'}`); };
      }
    });
    return e;
  };
  const eng = { sf: fake(), sf2: fake(), sf15: fake() }, llm = async () => '(stub)';
  const afterE5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
  const next = [{ fen: afterE4, path: 'aa', next: 'e5' }, { fen: afterE5, path: 'aabb', next: 'Nf3' }];
  const ref = await factSheet(eng, afterE4, 'e5'), refStart = await factSheet(eng, start, 'd4');
  // an Explain, then the next two positions built ahead: stepping forward searches nothing and gets the same sheet
  const cache = sheetCache();
  const first = await explainMove(eng, { fen: start, move: 'e4', best: null }, llm, { sheet: cache.get });
  await cache.prepare(eng, 'fable6', next);
  let s0 = searches();
  assert.deepEqual((await explainMove(eng, { fen: afterE4, move: 'e5', best: null }, llm, { sheet: cache.get })).facts, ref);
  // lichess's best move served too when it is the sheet's alternative. Another move, or the played one, is built and
  // kept in the old sheet's place: the same request again searches nothing
  const alt = sanToUci(afterE4, [ref.alternative.move])[0];
  assert.equal(await cache.get(eng, afterE4, 'e5', alt), await cache.get(eng, afterE4, 'e5'));
  assert.equal(searches(), s0);
  for (const best of [legal(pos(afterE4)).find(m => m !== alt && m !== 'e7e5'), 'e7e5']) {
    s0 = searches();
    const built = await cache.get(eng, afterE4, 'e5', best);
    assert.ok(searches() > s0, best);
    s0 = searches();
    assert.equal(await cache.get(eng, afterE4, 'e5', best), built);
    assert.equal(searches(), s0);
  }
  // the same request again: its own sheet (kept)
  s0 = searches();
  assert.deepEqual(await cache.get(eng, start, 'e4'), first.facts);
  assert.equal(searches(), s0);
  // fair play first: a user in a game gets nothing built ahead
  const refused = sheetCache();
  await refused.prepare(eng, 'in_a_game', next);
  s0 = searches();
  assert.deepEqual(await refused.get(eng, afterE4, 'e5'), ref);
  assert.ok(searches() > s0);
  // another request during a build ahead: the build stops (stop sent mid-search), the engines go idle, and the
  // request's sheet is the uninterrupted one. The stopped sheet is never served: asked for, it is built afresh, the same
  const busy = sheetCache();
  sent.length = 0;
  const bg = busy.prepare(eng, 'fable6', [{ fen: start, path: 'zz', next: 'd4' }]);
  while (searches() < 3) await new Promise(r => setTimeout(r, 1));
  assert.deepEqual(await busy.get(eng, afterE4, 'e5'), ref);
  assert.ok(sent[sent.indexOf('stop') - 1]?.startsWith('go nodes'), 'stop follows a search');
  await bg;
  s0 = searches();
  assert.deepEqual(await busy.get(eng, start, 'd4'), refStart);
  assert.ok(searches() > s0);
  // a second prepare over the position whose build the first is running: the stopped build leaves, it is built again
  const twice = sheetCache();
  s0 = searches();
  const p1 = twice.prepare(eng, 'fable6', [next[1]]);
  while (searches() === s0) await new Promise(r => setTimeout(r, 1));
  await twice.prepare(eng, 'fable6', [next[1]]);
  await p1;
  s0 = searches();
  assert.deepEqual(await twice.get(eng, afterE5, 'Nf3'), await cache.get(eng, afterE5, 'Nf3'));
  assert.equal(searches(), s0);
  // a build stopped at once rejects with an AbortError, and the next sheet is the same
  const ctl = new AbortController(), early = factSheet(eng, start, 'd4', null, 1, { signal: ctl.signal });
  ctl.abort();
  await assert.rejects(early, { name: 'AbortError' });
  assert.deepEqual(await factSheet(eng, start, 'd4'), refStart);
  // no best (lichess's engine off, or a sheet built ahead): the better move is the higher-scored of the compared move
  // and the engine's best other move (a3 here), so a compared move that outscores it is the engine move, as when
  // lichess names it. A best that is named stays the better move, even where it scores lower
  const rows = async (move, best = null) => (await explainMove(eng, { fen: start, move, best }, llm)).result.rows.map(r => r.move);
  assert.deepEqual([await rows('e4'), await rows('Nc3'), await rows('Nc3', 'a2a3')], [['a3', 'e4'], ['Nc3', 'a3'], ['a3', 'Nc3']]);
  // such a sheet, built ahead, serves the request that names the compared move as lichess's best
  const top = sheetCache();
  await top.prepare(eng, 'fable6', [{ fen: start, path: 'zz', next: 'Nc3' }]);
  s0 = searches();
  const better = await top.get(eng, start, 'Nc3', 'b1c3');
  assert.deepEqual([better.alternative.move, better.played.move, better.latest_sf_gap > 0, searches()], ['Nc3', 'a3', true, s0]);

  // the panel's requests (panelRequests), on a board stub, these engines and a storage; the tab in front is found a
  // moment later, as chrome.tabs answers
  {
    const data = {}, storage = { get: async k => structuredClone({ [k]: data[k] }), set: async o => void Object.assign(data, structuredClone(o)) };
    const at = (fen, path, more) => ({ fen, path, best: undefined, next: undefined, user: 'fable6', game: 'g1', ahead: [], ...more });
    const log = [];
    let here, front = 1;
    const board = { tab: 1, read: async () => (log.push('read'), here), play: async (...line) => void log.push(['play', ...line]) };
    const requests = panelRequests({ storage, version: '0.71', engines: async () => eng,
      activeBoard: async () => (await new Promise(setImmediate), { ...board, tab: front }) }); // another tab may show the same game
    const asked = [], writer = async (system, facts, model) => (system === PICKER ? '[]' : (asked.push(model), `Answer ${asked.length}.`));
    const explain = (ask, hear) => requests.explain(board, writer, { move: '', depth: false, model: 'm1', ...ask }, hear);
    const done = async p => { const got = await p; await got?.ahead; return got; }; // the request, then its build ahead
    // the board's next game move unless one is typed; neither is an error, and the next request still runs
    here = at(start, '');
    await assert.rejects(explain(), /No next game move here/);
    here = at(start, '', { next: 'e4' });
    const heard = [], first = await done(explain({}, { onSheet: (rows, lines, b) => heard.push(b) }));
    assert.deepEqual([first.result.rows.map(r => r.move), first.result.text, first.saved, first.again, first.b, heard],
      [['a3', 'e4'], 'Answer 1.', false, null, here, [here]]);
    assert.deepEqual((await done(explain({ move: 'Nc3' }))).result.rows.map(r => r.move), ['Nc3', 'a3']);
    // the same request again: the saved answer, which says so and offers its request again
    const saved = await done(explain());
    assert.deepEqual([saved.result.text, saved.result.note, saved.saved, saved.again],
      ['Answer 1.', 'Saved answer.', true, { b: here, move: 'e4', depth: false, model: 'm1' }]);
    // asked again from another position, with other settings and another user logged in: the first request, afresh,
    // for the user the board shows now
    here = at(afterE4, 'aa', { next: 'e5', user: 'other_user' });
    const again = await done(explain({ move: 'Nf6', depth: true, model: 'm2', again: saved.again }));
    assert.deepEqual([again.result.rows.map(r => r.move), again.result.text, again.saved, again.again, again.b, asked],
      [['a3', 'e4'], 'Answer 3.', false, null, { ...saved.b, user: 'other_user' }, ['m1', 'm1', 'm1']]);
    // the next move's sheet is built once the request is over (a step forward then searches nothing), but only while
    // the board is on its line in the tab in front, and never once another request has started
    const from = move => at(start, '', { next: 'h4', ahead: [{ fen: afterE5, path: 'aabb', next: move }] });
    const built = async move => { here = at(afterE5, 'aabb', { next: move }); s0 = searches(); await done(explain()); return searches() === s0; };
    here = from('d4');
    await done(explain());
    assert.equal(await built('d4'), true);
    [here, front] = [from('a4'), 2];
    await done(explain());
    front = 1;
    assert.equal(await built('a4'), false, 'another tab in front');
    here = from('b4');
    let got = await explain();
    here = at(afterE4, ''); // another game, at its first position: the same path, another board
    await got.ahead;
    assert.equal(await built('b4'), false, 'the board left the line');
    // one request at a time: a plan under way makes the next one resolve to null, before it reads the board
    here = from('c4');
    got = await explain();
    log.length = 0;
    const failing = requests.plan(board, writer, { model: 'm1' });
    assert.deepEqual([requests.busy(), await explain()], [true, null]);
    await assert.rejects(failing, /Could not read the plan ideas in the reply/);
    assert.deepEqual([requests.busy(), log.filter(l => l === 'read').length], [false, 2]); // the plan's read, the build ahead's
    await got.ahead;
    assert.equal(await built('c4'), false, 'a request started meanwhile');
    // a plan stops a build ahead under way before its own searches start, and the sheet half built is never served
    here = from('g4');
    got = await explain();
    s0 = searches();
    while (searches() === s0) await new Promise(r => setTimeout(r, 1));
    const mark = sent.length;
    await assert.rejects(requests.plan(board, writer, { model: 'm1' }), /Could not read the plan ideas in the reply/);
    assert.ok(sent.slice(mark).indexOf('stop') >= 0 && sent.slice(mark).indexOf('stop') < sent.slice(mark).indexOf('ucinewgame'), 'stop comes before the plan sheet starts');
    await got.ahead;
    assert.equal(await built('g4'), false, 'stopped by a plan');
    // Find plan for an about-equal verdict's position: the board goes there before it is read
    const idea = JSON.stringify([{ concept: 'home', claim: 'The e-pawn is still at home.', targets: [],
      checks: [{ pos: 'start', op: 'piece_on', args: { square: 'e2' }, expect: 'white pawn' }] }]);
    here = at(start, '');
    log.length = 0;
    const steps = [], planned = await requests.plan(board, async system => (system === PLANNER ? idea : 'The plan.'),
      { model: 'm1', at: { fen: start, path: '' } }, { onStep: s => steps.push(s) });
    assert.deepEqual(log, [['play', start, '', []], 'read']);
    assert.deepEqual([planned.result.head.label, planned.result.text, planned.b, steps], ['Plan for White', 'The plan.', here,
      ['Checking you are not in a game', 'Starting Stockfish', "Finding the engine's plan", 'Looking for plan ideas', 'Asking Claude']]);
  }
}
delete globalThis.fetch; // nothing past here may call out

const RECORDED = new URL('test-engines.json', import.meta.url);
const record = process.argv.includes('--record');

/** The real engines, with every reply logged per engine as {cmds, lines}. Search output keeps only what search() reads:
    per MultiPV line the info line pickInfos() picks, cut to multipv, score and pv, and the bestmove. The caller gets the
    same cut lines, so a recording run sees what a replay will. */
async function recordingEngines() {
  const real = await nodeEngines(), log = { sf: [], sf2: [], sf15: [] };
  // depth, nodes, speed and the like vary with the build and machine: drop them so only a change in the facts fails CI.
  // SF 15 prints a blank line after "Final evaluation", which lands in the next reply or nowhere, by how stdout is
  // chunked: blank lines are dropped too (sf15Terms reads only the table rows)
  const trim = lines => !lines.at(-1).startsWith('bestmove') ? lines.filter(l => l)
    : [...pickInfos(lines).map(l => l.replace(/ (depth|seldepth|nodes|nps|time|hashfull|tbhits) \d+/g, '')), lines.at(-1)];
  const wrap = k => ({ until: async (cmds, done) => { const lines = trim(await real[k].until(cmds, done)); log[k].push({ cmds, lines }); return lines; } });
  // the two sides share sf15, and which one asks first depends on machine speed. Replay only keeps the order of
  // replies to the same commands, so a stable sort by command keeps the file the same on every machine
  const key = e => e.cmds.join('\n'), byCmds = (a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  const save = () => writeFileSync(RECORDED, JSON.stringify(Object.fromEntries(Object.entries(log).map(([k, v]) => [k, v.sort(byCmds)]))) + '\n');
  return { sf: wrap('sf'), sf2: wrap('sf2'), sf15: wrap('sf15'), quit: real.quit, save };
}

/** Engines that answer from the recording: each engine replays its replies to the same commands, in the order recorded.
    Each engine has its own hash history, so the same command can get a different reply on sf and sf2: never shared. */
function recordedEngines() {
  const engine = rec => {
    const q = new Map();
    for (const { cmds, lines } of rec) { const key = cmds.join('\n'); q.set(key, [...(q.get(key) ?? []), lines]); }
    return { until: async cmds => q.get(cmds.join('\n'))?.shift()
      ?? assert.fail(`${q.has(cmds.join('\n')) ? 'asked more times than' : 'not'} recorded (node test.js --record): ${cmds.join(' | ')}`) };
  };
  const log = JSON.parse(readFileSync(RECORDED, 'utf8'));
  return { sf: engine(log.sf), sf2: engine(log.sf2), sf15: engine(log.sf15), quit: () => {} };
}

const engines = record ? await recordingEngines() : recordedEngines();
let facts;
const sheets = [];
// the LLM stub: logs each call (and whether it streams); the proposer gets `proposer`, the rule picker `picker`, the
// explainer's sheet is kept in `facts`
let calls = [], proposer = null, picker = '[]';
const stub = (system, f, model, onText) => (calls.push([system, model, ...onText ? ['streams'] : []]),
  system === PROPOSER ? proposer : system === PICKER ? picker : (sheets.push(facts = f), '(stub)'));
const ask = (fen, move, best, opts) => explainMove(engines, { fen, move, best }, stub, opts);
try {
  const fen = 'r3k2r/1p1bbpp1/pqn1p2p/2ppP3/3P4/2PB1N2/PP1N1PPP/R2Q1RK1 w kq - 2 11';
  let r = await ask(fen, 'dxc5', 'c3c4');
  assert.deepEqual(r.result.rows.map(m => m.move), ['c4', 'dxc5']);
  // compared move == lichess's move: lichess's move is still the one explained, against the best other move
  r = await ask(fen, 'c4', 'c3c4');
  assert.equal(r.result.rows[0].move, 'c4');
  assert.notEqual(r.result.rows[1].move, 'c4');

  // regression positions: the facts must carry the point a good answer makes
  r = await ask('1r3rk1/p1p2ppp/bb1q4/3p4/BP1Pn3/2P1B3/P4PPP/RN1QR1K1 b - - 4 16', 'Bc4', 'c7c6');
  assert.equal(facts.opponent_threat.move, 'f3'); // White threatens f3; c6 prepares Bc7 and Qxh2#
  assert.match(facts.alternative.if_opp_plays_the_threat_at_once, /you Bc7 \[threatens Qxh2#\]/);
  assert.ok(r.result.lines.includes(facts.alternative.if_opp_plays_the_threat_at_once)); // a link may play the threat line too
  calls = [];
  r = await ask('r4rk1/p1p2pp1/1pnb1q1p/3p1b2/P2P4/1NP2N2/1P2BPPP/R2QR1K1 b - - 0 13', 'Rfe8', 'c6e7', { depth: true });
  assert.match(r.text, /about as good as/); // equal moves: no LLM call (no rule picker either), plain verdict, even with depth on
  assert.equal(r.result.equal, true); // and the panel offers Find plan
  assert.deepEqual([calls, r.concepts, r.read], [[], null, undefined]);
  assert.deepEqual([r.result.rows.map(m => m.move), r.result.lines, r.result.note], [['Ne7', 'Rfe8'], [], null]);
  assert.deepEqual(Object.keys(r.facts), ['fen', 'side_to_move', 'played', 'alternative', 'latest_sf_gap']); // stops at the scores
  r = await ask('rn3rk1/p1N2pbp/1p2p1p1/2p1n1B1/2P5/5b2/PP2BPPP/3R1RK1 w - - 0 15', 'Nxa8', 'g2f3');
  assert.match(r.facts.played.line_with_evals, /opp Bxe2 \[takes bishop, attacks your rook on d1, attacks your rook on f1/); // fork
  // the result: what the panel shows, row by row, and the lines a move link may play
  assert.deepEqual(r.result.rows, [{ kind: 'best', label: 'engine move', move: 'gxf3', eval: r.facts.alternative.latest_sf_eval },
    { kind: 'compared', label: 'compared', move: 'Nxa8', eval: r.facts.played.latest_sf_eval }]);
  assert.notEqual(r.result.rows[0].eval, r.result.rows[1].eval);
  assert.deepEqual([r.result.head, r.result.text, r.result.note, r.result.shapes], [null, '(stub)', null, null]);
  assert.deepEqual(r.result.lines.slice(0, 1).concat(r.result.lines.includes(r.facts.played.line_with_evals)), [r.facts.alternative.line_with_evals, true]);
  r = await ask('r3k1nr/4pp1p/p1ppb1p1/q3b3/N1B1P3/1P6/P1P2PPP/R1BQ1RK1 w kq - 1 12', 'Bd5', 'c1d2');
  assert.match(r.facts.played.line_with_evals, /opp cxd5 \[takes bishop/);
  assert.match(facts.alternative.if_opp_plays_the_threat_at_once, /opp Bxc4 .* you Bxa5 \[takes queen/);
  r = await ask('2bq4/r4kb1/n3pn1r/p2pB1Qp/P2P2p1/N1PB4/5PPP/R4RK1 w - - 12 25', 'Qg6+', 'f2f3');
  assert.match(r.facts.played.line_with_evals, /opp Rxg6 \[takes queen/);
  r = await ask('r2q1rk1/pp1n1ppb/2p4p/b4p1P/3P4/2PBBN2/PP3PP1/R2QR1K1 w - - 0 16', 'Qd2', 'd1b3');
  assert.match(r.facts.alternative.line_with_evals, /you Qb3 \[[^\]]*pins opp's pawn on f7 to king on g8/);
  // with depth on and every idea failing its board checks: the result's note says so
  proposer = JSON.stringify([{ concept: 'wrong', claim: 'x', checks: [{ pos: 'start', op: 'king_square', args: { side: 'white' }, expect: 'h1' }] }]);
  r = await ask('r1br2k1/1pq1nppp/p1n1p3/8/2B1P3/1NQ1B3/PP3PPP/2R2RK1 w - - 0 1', 'Rcd1', 'f2f4', { depth: true });
  assert.deepEqual([r.read, r.concepts, r.result.note], [true, null, 'No positional idea passed the board checks.']);
  assert.match(r.facts.alternative.line_with_evals, /^1\. you f4 \[pawn gains space[,\]]/);
  // the knight on f3 is defended, but gxf3 opens the king: the line must say why White does not take back
  r = await ask('r2qr1k1/ppp2ppp/2bb1pn1/8/2PP4/4BN1P/PP1QNPP1/2R2RK1 w - - 0 1', 'b4', 'd4d5');
  assert.match(r.facts.played.line_with_evals, /opp Bxf3 \[takes knight, material -3, your recapture 2\.gxf3 fails \(line below\)\]/);
  assert.match(r.facts.played.line_with_evals, /\nWhy 2\.gxf3 fails: 2\. you gxf3 \[takes bishop/);
  assert.match(linkMoves('2.gxf3', r.result.lines), /data-line="b4 Bxf3 gxf3"/);
  // Kramnik-Leko 2001: Qa1 prepares Bxd5, which fails at once to Qb6 hitting the queen on b2.
  // With depth on: the proposer, then the explainer with the concepts entry and the verified concepts after the pawn plan
  calls = [];
  const steps = [], sheetSeen = [];
  proposer = `Ideas:\n${JSON.stringify([
    { concept: 'king', claim: 'Your king is on g1.', checks: [{ pos: 'start', op: 'king_square', args: { side: 'white' }, expect: 'g1' }] },
    { concept: 'wrong', claim: 'x', checks: [{ pos: 'start', op: 'king_square', args: { side: 'white' }, expect: 'h1' }] }])}`;
  r = await ask('2rq1rk1/R2n1ppp/4p3/2pb4/5B2/6P1/1Q2PPBP/3R2K1 w - - 0 21', 'e4', 'b2a1',
    { model: 'claude-fable-5-2', depth: true, onStep: t => steps.push(t), onSheet: (...a) => sheetSeen.push([calls.length, ...a]), onText: () => {} });
  // the picked model proposes, writes and picks the rule line; only the explainer streams; the panel gets the rows and
  // lines before any LLM call
  assert.deepEqual(calls, [[PROPOSER, 'claude-fable-5-2'], [systemFor(true), 'claude-fable-5-2', 'streams'], [PICKER, 'claude-fable-5-2']]);
  assert.deepEqual(sheetSeen, [[0, r.result.rows, r.result.lines]]);
  assert.deepEqual(steps, ['Looking for positional ideas', 'Asking Claude']);
  // a pick of two models: the first proposes and picks the rule line, the second writes; with depth off the proposer is not called
  const split = [], by = (system, f, model) => (split.push([system, model]), system === PROPOSER ? proposer : '(stub)');
  await answer(r.facts, by, { model: 'm1+m2', depth: true });
  await answer(r.facts, by, { model: 'm1+m2' });
  assert.deepEqual(split, [[PROPOSER, 'm1'], [systemFor(true), 'm2'], [PICKER, 'm1'], [systemFor(true), 'm2'], [PICKER, 'm1']]);
  assert.deepEqual([r.read, r.concepts], [true, [{ concept: 'king', claim: 'Your king is on g1.', checked: ['now, before your move: your king on g1'] }]]);
  assert.equal(r.result.note, null);
  assert.equal(r.facts, facts);
  const order = Object.keys(facts);
  assert.equal(order[order.indexOf('pawn_plan_only_in_better_line') + 1], 'verified_concepts');
  assert.equal(facts.verified_concepts, r.concepts);
  assert.equal(facts.prepares.move, 'Bxd5');
  assert.match(facts.prepares.line_if_played_at_once, /opp Qb6 \[attacks your queen on b2/);
  // the result's lines hold the at-once line too, so the panel links its moves: it starts at the explained position
  assert.match(linkMoves('21.Bxd5 exd5 22.Rxd5 Qb6', r.result.lines), /data-line="Bxd5 exd5 Rxd5 Qb6">Qb6</);
  // Skoberne-Suarez 2012: Rf1 prepares Nxg6; at once the engine line avoids Qxh6, which fails to Qxf2+ (Rf1 guards f2).
  // With depth on and no claim list in the proposer's reply: the plain prompt, and the panel is told the reply was unread
  calls = [];
  proposer = 'No ideas.';
  r = await ask('r4rkb/ppR5/3Np1pp/4n3/5N2/4Q3/q4PPP/3R2K1 w - - 2 24', 'Re7', 'd1f1', { depth: true });
  assert.deepEqual(calls, [[PROPOSER, 'claude-fable-5-2'], [systemFor(), 'claude-opus-5-5'], [PICKER, 'claude-fable-5-2']]); // the default pick: one model for the ideas and the rule, one writes
  assert.deepEqual([r.read, r.concepts, 'verified_concepts' in facts, facts.verified_concepts], [false, null, true, null]);
  assert.equal(r.result.note, 'Could not read the positional ideas in the reply.');
  assert.ok(!r.result.lines.includes(facts.prepares.follow_up_fails)); // it starts mid-line: a link could not play it
  assert.equal(facts.prepares.move, 'Nxg6');
  assert.match(facts.prepares.follow_up_fails, /^Why 25\.Qxh6 fails: 25\. you Qxh6 .* 25\.\.\. opp Qxf2\+ /);
  assert.equal(facts.prepares.better_move_guards, 'f2');

  // Find plan on a quiet position: our own engine picks f4, the planner's checks run on its line, the writer gets PLAN_SYSTEM
  const quiet = 'r1br2k1/1pq1nppp/p1n1p3/8/2B1P3/1NQ1B3/PP3PPP/2R2RK1 w - - 0 1', planCalls = [], planSteps = [];
  // and one manoeuvre beyond the line: the b3 knight to the b6 hole, backed by its route; one with no route check and a
  // second one (to d6, which every short route reaches only over a square a black pawn covers) are dropped
  const toHole = (square, checks) => ({ concept: 'knight to the hole', claim: `Later the knight heads for ${square}.`, beyond_line: true,
    targets: [{ square, kind: 'occupy' }], checks });
  const holeChecks = (sq, moves = 3) => [{ pos: 'start', op: 'route', args: { from: 'b3', to: sq }, expect: moves },
    { pos: 'start', op: 'pawn_can_ever_attack', args: { square: sq, side: 'black' }, expect: false }];
  const kingside = JSON.stringify([{ concept: 'kingside space', claim: 'f4 grabs space.', targets: [{ square: 'f4', kind: 'occupy' }],
    checks: [{ pos: 'start', op: 'piece_on', args: { square: 'f4' }, expect: 'empty' }, { pos: 'best:1', op: 'piece_on', args: { square: 'f4' }, expect: 'white pawn' }] },
  toHole('c5', [holeChecks('c5')[1]]), toHole('b6', holeChecks('b6')), toHole('d6', holeChecks('d6', 'more than 4'))]);
  const planStub = (system, f, model) => (planCalls.push([system, model]), system === PLANNER ? kingside : (sheets.push(f), 'Push to **f4** with 1.f4.'));
  const plan = await findPlan(engines, quiet, planStub, { onStep: t => planSteps.push(t) });
  assert.deepEqual(planCalls, [[PLANNER, 'claude-fable-5-2'], [PLAN_SYSTEM, 'claude-opus-5-5']]); // the default pick
  assert.deepEqual(planSteps, ['Looking for plan ideas', 'Asking Claude']);
  assert.deepEqual([plan.facts.plan_kind, plan.facts.side_to_move], ['positional', 'White']);
  assert.match(plan.facts.best.line_with_evals, /^1\. you f4 \[pawn gains space/);
  // the plan's result: a head over one row, the engine line to link, the shapes for the board
  assert.deepEqual(plan.result, { head: { label: 'Plan for White', pill: 'Positional' },
    rows: [{ kind: 'best', label: 'first move', move: 'f4', eval: plan.facts.best.latest_sf_eval }],
    text: 'Push to **f4** with 1.f4.', lines: [plan.facts.best.line_with_evals], note: null,
    shapes: [{ orig: 'f2', dest: 'f4', brush: 'green' }, { orig: 'f4', brush: 'green' }] });
  assert.match(linkMoves(md(plan.result.text), plan.result.lines), /<strong>f4<\/strong> with <a href="#" data-line="f4">1\.f4<\/a>/);
  assert.deepEqual(plan.ideas.map(i => [i.concept, i.beyond_line, i.targets.map(t => t.square)]), [['kingside space', undefined, ['f4']], ['knight to the hole', true, ['b6']]]);
  assert.deepEqual(plan.ideas[1].checked, ['now, before your move: the piece on b3 can reach b6 in 3 moves, the other pieces standing still',
    "now, before your move: a pawn of the opponent's can still ever attack b6: no"]);
  assert.match(plan.facts.imbalances.yours.join(), /hole b6/);
  assert.equal(plan.facts.also_good, null); // h3 is the engine's second move, but too far behind f4 to call about as good
  // Stein-Ljubojevic 1971 (Marovic p16): Nf6, the book's move, is about as good as the engine's Bf8. The planner never
  // sees it; the writer gets it with its labelled line, and the panel shows it as a second row whose line links
  const seen = [];
  const closeStub = (system, f) => (seen.push([system, 'also_good' in f]), system === PLANNER
    ? JSON.stringify([{ concept: 'king', claim: 'Your king is on g8.', checks: [{ pos: 'start', op: 'king_square', args: { side: 'black' }, expect: 'g8' }] }])
    : (sheets.push(f), '(stub)'));
  const p16 = await findPlan(engines, '3r2k1/1pn2qbp/pN1p2p1/P1pP1p1n/2N5/3Q4/1PPB1PPP/4R1K1 b - - 2 21', closeStub);
  assert.deepEqual(seen, [[PLANNER, false], [PLAN_SYSTEM, true]]);
  assert.deepEqual(p16.result.rows.map(m => [m.kind, m.move]), [['best', 'Bf8'], ['also', 'Nf6']]);
  assert.match(p16.facts.also_good.line_with_evals, /^21\.\.\. you Nf6 \[attacks opp's pawn on d5/);
  assert.deepEqual(p16.result.lines, [p16.facts.best.line_with_evals, p16.facts.also_good.line_with_evals]);
  // no idea holds: an error, and the writer is never called
  planCalls.length = 0;
  await assert.rejects(findPlan(engines, quiet, (system, f, m) => (planCalls.push(system), '[]')), /No clear plan found here/);
  assert.deepEqual(planCalls, [PLANNER]);

  // every field the explainer and judge prompts quote is on a fact sheet built above, so a renamed field fails here
  const keys = new Set();
  const walk = v => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!Array.isArray(v)) keys.add(k); walk(x); } };
  sheets.forEach(walk);
  const notFields = ['you', 'opp', 'check', 'yes', 'partly', 'no', 'tie', 'labelled', 'line', 'term', 'none', 'tactical', 'positional', 'must', 'forced', 'hole']; // quoted labels and verdict values
  const quoted = new Set([...(LEGEND + JUDGE + PAIR + PLAN_SYSTEM).matchAll(/"([a-z][a-z0-9_]*)"/g)].map(m => m[1]));
  assert.deepEqual([...quoted].filter(k => !keys.has(k) && !notFields.includes(k)), []);
  engines.save?.(); // a full run only: a failed one would leave out the searches after the failure
  console.log('ok');
} finally {
  engines.quit();
}
