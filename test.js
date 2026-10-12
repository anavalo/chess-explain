// Checks the fact builder and request handling with the LLM stubbed out. Uses the real WASM engines on one
// thread (node-limited single-thread search is deterministic) and calls lichess for the fair-play check.
// usage: node test.js   (about 3 minutes)
import assert from 'node:assert/strict';
import { Chess, parseFen, parseSquare } from './extension/vendor/chessops.js';
import { Refused, handle, nodeEngines, trapped } from './extension/explain.js';
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
  console.log('ok');
} finally {
  engines.quit();
}
