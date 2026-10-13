// Checks the fact builder and request handling with the LLM stubbed out. Uses the real WASM engines on one
// thread (node-limited single-thread search is deterministic) and calls lichess for the fair-play check.
// usage: node test.js   (about 3 minutes)
import assert from 'node:assert/strict';
import { Chess, parseFen, parseSquare, parseUci } from './extension/vendor/chessops.js';
import {
  Refused, endNotes, handle, isOutpost, moveLabels, nodeEngines, pawnWeaknesses, pins, trapped,
} from './extension/explain.js';
import { md } from './extension/md.js';

const pos = fen => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();

// markdown renderer
assert.equal(md('**Bc4** loses.\n\nc6 *holds*.'), '<p><strong>Bc4</strong> loses.</p><p>c6 <em>holds</em>.</p>');
assert.equal(md('Terms:\n- **Material** +0.5\n- Mobility'),
  '<p>Terms:</p><ul><li><strong>Material</strong> +0.5</li><li>Mobility</li></ul>');
assert.equal(md('1. f3\n2. Bc7'), '<ol><li>f3</li><li>Bc7</li></ol>');
assert.equal(md('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
assert.equal(md('Qxh2# and 2*3'), '<p>Qxh2# and 2*3</p>');

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
assert.deepEqual([...pawnWeaknesses(pos('4k3/8/8/8/8/2P5/2P5/4K3 w - - 0 1').board, 'white')], ['c-pawns doubled', 'c-pawn isolated']);
assert.deepEqual([...pawnWeaknesses(pos('4k3/8/8/4p3/2P1P3/3P4/8/4K3 w - - 0 1').board, 'white')], ['pawn on d3 backward']);
const labels = (fen, uci) => { const p = pos(fen), q = p.clone(); q.play(parseUci(uci)); return moveLabels(p, q, uci, 'white'); };
assert.deepEqual(labels('4k3/8/8/8/8/2n5/1PP5/4K3 w - - 0 1', 'b2c3'), ['your c-pawns doubled', 'your c-pawn isolated']);
assert.deepEqual(labels('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1d1'), ['rook on open file']);
assert.deepEqual(labels('2b1kb2/8/8/8/8/8/8/2R1K3 w - - 0 1', 'c1c8'), ["opp's bishop pair gone"]);
assert.deepEqual(labels('4k3/8/8/8/4P3/2N5/8/4K3 w - - 0 1', 'c3d5'), ['knight on outpost d5']);
assert.deepEqual(endNotes(pos('2b1k3/8/8/8/8/8/8/2B1K3 w - - 0 1'), 'white'), ['opposite-coloured bishops']);
assert.deepEqual(endNotes(pos('4k3/8/4p3/3pP3/3P4/8/8/2B1K3 w - - 0 1'), 'white'),
  ['your bishop on c1 is bad: your pawns on d4, e5 are fixed on its colour']);

const engines = await nodeEngines(1);
let facts;
const stub = f => ((facts = f), '(stub)');
const ask = (fen, move, best) => handle(engines, { fen, move, best, user: 'fable6' }, null, stub);
try {
  const fen = 'r3k2r/1p1bbpp1/pqn1p2p/2ppP3/3P4/2PB1N2/PP1N1PPP/R2Q1RK1 w kq - 2 11';
  let r = await ask(fen, 'dxc5', 'c3c4');
  assert.deepEqual([r.best.move, r.compared.move], ['c4', 'dxc5']);
  // compared move == lichess's move: lichess's move is still the one explained, against the best other move
  r = await ask(fen, 'c4', 'c3c4');
  assert.equal(r.best.move, 'c4');
  assert.notEqual(r.compared.move, 'c4');
  for (const user of [undefined, 'zz_no_such_user_zz'])
    await assert.rejects(handle(engines, { fen, move: 'dxc5', user }, null, stub), Refused);

  // regression positions: the facts must carry the point a good answer makes
  r = await ask('1r3rk1/p1p2ppp/bb1q4/3p4/BP1Pn3/2P1B3/P4PPP/RN1QR1K1 b - - 4 16', 'Bc4', 'c7c6');
  assert.equal(facts.opponent_threat.move, 'f3'); // White threatens f3; c6 prepares Bc7 and Qxh2#
  assert.match(facts.alternative.if_opp_plays_the_threat_at_once, /you Bc7 \[threatens Qxh2#\]/);
  r = await ask('r4rk1/p1p2pp1/1pnb1q1p/3p1b2/P2P4/1NP2N2/1P2BPPP/R2QR1K1 b - - 0 13', 'Rfe8', 'c6e7');
  assert.match(r.text, /about as good as/); // equal moves: no LLM call, plain verdict
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
  assert.match(r.best.line, /^1\. you f4 \[pawn gains space\]/);
  // the knight on f3 is defended, but gxf3 opens the king: the line must say why White does not take back
  r = await ask('r2qr1k1/ppp2ppp/2bb1pn1/8/2PP4/4BN1P/PP1QNPP1/2R2RK1 w - - 0 1', 'b4', 'd4d5');
  assert.match(r.compared.line, /opp Bxf3 \[takes knight, material -3, your recapture 2\.gxf3 fails \(line below\)\]/);
  assert.match(r.compared.line, /\nWhy 2\.gxf3 fails: 2\. you gxf3 \[takes bishop/);
  console.log('ok');
} finally {
  engines.quit();
}
