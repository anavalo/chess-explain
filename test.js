// Checks the fact builder and request handling with the LLM stubbed out; lichess's status API is stubbed.
// The engines are replayed from test-engines.json, the UCI output recorded from the real WASM engines on one thread
// (node-limited single-thread search is deterministic). A change that sends the engines a new command fails with
// "not recorded": run with --record to search again with the real engines (about 3 minutes) and, if every test
// passes, rewrite the file.
// usage: node test.js [--record]
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Chess, parseFen, parseSquare, parseUci } from './extension/vendor/chessops.js';
import {
  Refused, ask as anthropic, checkNotPlaying, handle, lineToLeaf, moveLabels, nodeEngines, pawnPushes, pickInfos, pins, sanToUci, sf15Terms, trapped,
} from './extension/explain.js';
import { KINDS, endNotes, imbalances, isOutpost, leafDiff, pawnWeaknesses, word } from './extension/features.js';
import { linkMoves, md } from './extension/md.js';
import { JUDGE, LEGEND, PAIR, PROPOSER, checkAnswer, systemFor } from './extension/prompt.js';
import { claimsIn, render, verify, withConcepts } from './extension/concepts.js';

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
// explainer prompt: Haiku gets no rule 15; the legend the judge sees holds no rules
assert.ok(systemFor('claude-haiku-5-5').startsWith(LEGEND) && !systemFor('claude-haiku-5-5').includes('Next time:'));
assert.ok(systemFor('claude-opus-5-5').startsWith(systemFor('claude-haiku-5-5')) && systemFor('claude-opus-5-5').includes('Next time:'));
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
assert.deepEqual(failed('12. Nf3 wins.'), [6]);
assert.deepEqual(failed('12.Nf3 [takes] wins.'), [7]);
assert.deepEqual(failed('12.Qh5 wins.'), [5]);
assert.deepEqual(failed('Your king is in check.'), [5]);
assert.deepEqual(failed('White must take back.'), [5]);
assert.deepEqual(failed('12.Nf3 keeps +0.3, half a pawn (0.5) or 30 cp better.'), [14]);
assert.deepEqual(failed('Stockfish likes 12.Nf3.'), [14]);
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
  only_after_alternative: ['your knight on outpost d5'],
  only_after_played: null,
});
assert.equal(leafDiff(null, pos('8/8/8/8/4k3/4P3/5K2/8 b - - 1 1'), 'white'), null);

// imbalances before any move: doubled rooks on the a-file are one label; both bishop pairs cancel out
assert.deepEqual(imbalances(pos('4r3/R4pk1/2pq1rpp/1p1pn3/1P1Q4/2P1P1P1/4BP1P/R5K1 b - - 2 30')), {
  yours: ['rook on semi-open e-file', 'pawn on c6 backward', 'outpost square c4'],
  opponents: ['rook on open a-file', 'pawn on c3 backward', 'outpost square c5'],
  both: ["piece imbalance: your knight for opp's bishop"],
});
assert.deepEqual(imbalances(pos('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')), { yours: null, opponents: null, both: null });
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
// the claim list is found past brackets in the reasoning; no list at all is told apart from an empty one
assert.deepEqual(claimsIn('The sheet says [takes pawn]. Claims:\n[{"concept": "a"}]\nDone [ok].'), [{ concept: 'a' }]);
assert.deepEqual([claimsIn('none [here]'), claimsIn('[]')], [null, []]);
assert.match(v[2].checks[0].error, /no piece on e4/);
assert.deepEqual(render(cSheet, v), [{ concept: 'centre', claim: 'd4 takes the centre.', checked: [
  'after 1.d4: d4: your pawn', 'after 1.e4: d4: empty', 'after 1.d4 d5: your pieces attacking e5: 1'] }]);
// a sheet without the field the concepts go after fails loudly, before any LLM call
await assert.rejects(withConcepts({ fen: start }, () => assert.fail('called the LLM')), /pawn_plan_only_in_better_line/);
// one Messages API call: the system prompt, the sheet as the user message, the reply's text
let sent;
globalThis.fetch = async (url, { body }) => ((sent = JSON.parse(body)),
  Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fine.' }] }));
assert.equal(await anthropic(PROPOSER, cSheet, 'key', 'claude-opus-5-5'), 'Fine.');
assert.deepEqual([sent.model, sent.system, sent.messages], ['claude-opus-5-5', PROPOSER, [{ role: 'user', content: JSON.stringify(cSheet, null, 1) }]]);
// the deeper read's prompt is the plain one plus the "verified_concepts" entry
for (const m of ['claude-haiku-5-5', 'claude-opus-5-5'])
  assert.ok(systemFor(m, true).includes('"verified_concepts"') && systemFor(m, true).replace(/\n- "verified_concepts"[^]*?swing in the lines still comes first\./, '') === systemFor(m));

// fair play, with a lichess status stub (the real user may be in a game when CI runs): fail closed
globalThis.fetch = async url => {
  const id = new URL(url).searchParams.get('ids');
  return Response.json(id === 'zz_no_such_user_zz' ? [] : [{ id, playing: id === 'in_a_game' }]);
};
await checkNotPlaying('fable6');
for (const user of [undefined, 'zz_no_such_user_zz', 'in_a_game']) await assert.rejects(checkNotPlaying(user), Refused);
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
// the LLM stub: logs each call; the proposer gets `proposer`, the explainer's sheet is kept in `facts`
let calls = [], proposer = null;
const stub = (system, f, model) => (calls.push([system, model]), system === PROPOSER ? proposer : (sheets.push(facts = f), '(stub)'));
const ask = (fen, move, best, opts) => handle(engines, { fen, move, best }, stub, opts);
try {
  const fen = 'r3k2r/1p1bbpp1/pqn1p2p/2ppP3/3P4/2PB1N2/PP1N1PPP/R2Q1RK1 w kq - 2 11';
  let r = await ask(fen, 'dxc5', 'c3c4');
  assert.deepEqual([r.best.move, r.compared.move], ['c4', 'dxc5']);
  // compared move == lichess's move: lichess's move is still the one explained, against the best other move
  r = await ask(fen, 'c4', 'c3c4');
  assert.equal(r.best.move, 'c4');
  assert.notEqual(r.compared.move, 'c4');

  // regression positions: the facts must carry the point a good answer makes
  r = await ask('1r3rk1/p1p2ppp/bb1q4/3p4/BP1Pn3/2P1B3/P4PPP/RN1QR1K1 b - - 4 16', 'Bc4', 'c7c6');
  assert.equal(facts.opponent_threat.move, 'f3'); // White threatens f3; c6 prepares Bc7 and Qxh2#
  assert.match(facts.alternative.if_opp_plays_the_threat_at_once, /you Bc7 \[threatens Qxh2#\]/);
  calls = [];
  r = await ask('r4rk1/p1p2pp1/1pnb1q1p/3p1b2/P2P4/1NP2N2/1P2BPPP/R2QR1K1 b - - 0 13', 'Rfe8', 'c6e7', { depth: true });
  assert.match(r.text, /about as good as/); // equal moves: no LLM call, plain verdict, even with depth on
  assert.deepEqual([calls, r.concepts, r.read], [[], null, undefined]);
  r = await ask('rn3rk1/p1N2pbp/1p2p1p1/2p1n1B1/2P5/5b2/PP2BPPP/3R1RK1 w - - 0 15', 'Nxa8', 'g2f3');
  assert.match(r.compared.line, /opp Bxe2 \[takes bishop, attacks your rook on d1, attacks your rook on f1/); // fork
  r = await ask('r3k1nr/4pp1p/p1ppb1p1/q3b3/N1B1P3/1P6/P1P2PPP/R1BQ1RK1 w kq - 1 12', 'Bd5', 'c1d2');
  assert.match(r.compared.line, /opp cxd5 \[takes bishop/);
  assert.match(facts.alternative.if_opp_plays_the_threat_at_once, /opp Bxc4 .* you Bxa5 \[takes queen/);
  r = await ask('2bq4/r4kb1/n3pn1r/p2pB1Qp/P2P2p1/N1PB4/5PPP/R4RK1 w - - 12 25', 'Qg6+', 'f2f3');
  assert.match(r.compared.line, /opp Rxg6 \[takes queen/);
  r = await ask('r2q1rk1/pp1n1ppb/2p4p/b4p1P/3P4/2PBBN2/PP3PP1/R2QR1K1 w - - 0 16', 'Qd2', 'd1b3');
  assert.match(r.best.line, /you Qb3 \[[^\]]*pins opp's pawn on f7 to king on g8/);
  r = await ask('r1br2k1/1pq1nppp/p1n1p3/8/2B1P3/1NQ1B3/PP3PPP/2R2RK1 w - - 0 1', 'Rcd1', 'f2f4');
  assert.match(r.best.line, /^1\. you f4 \[pawn gains space[,\]]/);
  // the knight on f3 is defended, but gxf3 opens the king: the line must say why White does not take back
  r = await ask('r2qr1k1/ppp2ppp/2bb1pn1/8/2PP4/4BN1P/PP1QNPP1/2R2RK1 w - - 0 1', 'b4', 'd4d5');
  assert.match(r.compared.line, /opp Bxf3 \[takes knight, material -3, your recapture 2\.gxf3 fails \(line below\)\]/);
  assert.match(r.compared.line, /\nWhy 2\.gxf3 fails: 2\. you gxf3 \[takes bishop/);
  assert.match(linkMoves('2.gxf3', [r.compared.line]), /data-line="b4 Bxf3 gxf3"/);
  // Kramnik-Leko 2001: Qa1 prepares Bxd5, which fails at once to Qb6 hitting the queen on b2.
  // With depth on: the proposer, then the explainer with the concepts entry and the verified concepts after the pawn plan
  calls = [];
  const steps = [];
  proposer = `Ideas:\n${JSON.stringify([
    { concept: 'king', claim: 'Your king is on g1.', checks: [{ pos: 'start', op: 'king_square', args: { side: 'white' }, expect: 'g1' }] },
    { concept: 'wrong', claim: 'x', checks: [{ pos: 'start', op: 'king_square', args: { side: 'white' }, expect: 'h1' }] }])}`;
  r = await ask('2rq1rk1/R2n1ppp/4p3/2pb4/5B2/6P1/1Q2PPBP/3R2K1 w - - 0 21', 'e4', 'b2a1',
    { model: 'claude-opus-5-5', depth: true, onStep: t => steps.push(t) });
  assert.deepEqual(calls, [[PROPOSER, 'claude-opus-5-5'], [systemFor('claude-opus-5-5', true), 'claude-opus-5-5']]);
  assert.deepEqual(steps, ['Looking for positional ideas', 'Asking Claude']);
  assert.deepEqual([r.read, r.concepts], [true, [{ concept: 'king', claim: 'Your king is on g1.', checked: ['now, before your move: your king on g1'] }]]);
  assert.equal(r.facts, facts);
  const order = Object.keys(facts);
  assert.equal(order[order.indexOf('pawn_plan_only_in_better_line') + 1], 'verified_concepts');
  assert.equal(facts.verified_concepts, r.concepts);
  assert.equal(facts.prepares.move, 'Bxd5');
  assert.match(facts.prepares.line_if_played_at_once, /opp Qb6 \[attacks your queen on b2/);
  // Skoberne-Suarez 2012: Rf1 prepares Nxg6; at once the engine line avoids Qxh6, which fails to Qxf2+ (Rf1 guards f2).
  // With depth on and no claim list in the proposer's reply: the plain prompt, and the panel is told the reply was unread
  calls = [];
  proposer = 'No ideas.';
  r = await ask('r4rkb/ppR5/3Np1pp/4n3/5N2/4Q3/q4PPP/3R2K1 w - - 2 24', 'Re7', 'd1f1', { depth: true });
  assert.deepEqual(calls, [[PROPOSER, 'claude-opus-5-5'], [systemFor('claude-haiku-5-5'), 'claude-haiku-5-5']]);
  assert.deepEqual([r.read, r.concepts, 'verified_concepts' in facts, facts.verified_concepts], [false, null, true, null]);
  assert.equal(facts.prepares.move, 'Nxg6');
  assert.match(facts.prepares.follow_up_fails, /^Why 25\.Qxh6 fails: 25\. you Qxh6 .* 25\.\.\. opp Qxf2\+ /);
  assert.equal(facts.prepares.better_move_guards, 'f2');

  // every field the explainer and judge prompts quote is on a fact sheet built above, so a renamed field fails here
  const keys = new Set();
  const walk = v => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!Array.isArray(v)) keys.add(k); walk(x); } };
  sheets.forEach(walk);
  const notFields = ['you', 'opp', 'check', 'yes', 'partly', 'no', 'tie', 'labelled', 'line', 'term', 'none']; // quoted labels and verdict values
  const quoted = new Set([...(LEGEND + JUDGE + PAIR).matchAll(/"([a-z][a-z0-9_]*)"/g)].map(m => m[1]));
  assert.deepEqual([...quoted].filter(k => !keys.has(k) && !notFields.includes(k)), []);
  engines.save?.(); // a full run only: a failed one would leave out the searches after the failure
  console.log('ok');
} finally {
  engines.quit();
}
