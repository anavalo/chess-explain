// Checks the fact builder and request handling with the LLM stubbed out. Uses the real WASM engines on one
// thread (node-limited single-thread search is deterministic) and calls lichess for the fair-play check.
// usage: node test.js   (about 3 minutes)
import assert from 'node:assert/strict';
import { Chess, parseFen, parseSquare, parseUci } from './extension/vendor/chessops.js';
import {
  Refused, endNotes, handle, imbalances, isOutpost, leafDiff, moveLabels, nodeEngines, pawnWeaknesses, pins, sanToUci, trapped,
} from './extension/explain.js';
import { linkMoves, md } from './extension/md.js';

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
// lichess's engine line writes castling as the king's two-square move
assert.deepEqual(sanToUci('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', ['O-O', 'O-O-O']), ['e1g1', 'e8c8']);

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

// lichess status stub: the real user may be in a game when CI runs
globalThis.fetch = async url => {
  const id = new URL(url).searchParams.get('ids');
  return Response.json(id === 'zz_no_such_user_zz' ? [] : [{ id, playing: id === 'in_a_game' }]);
};
const engines = await nodeEngines();
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
  for (const user of [undefined, 'zz_no_such_user_zz', 'in_a_game'])
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
  assert.match(r.best.line, /^1\. you f4 \[pawn gains space[,\]]/);
  // the knight on f3 is defended, but gxf3 opens the king: the line must say why White does not take back
  r = await ask('r2qr1k1/ppp2ppp/2bb1pn1/8/2PP4/4BN1P/PP1QNPP1/2R2RK1 w - - 0 1', 'b4', 'd4d5');
  assert.match(r.compared.line, /opp Bxf3 \[takes knight, material -3, your recapture 2\.gxf3 fails \(line below\)\]/);
  assert.match(r.compared.line, /\nWhy 2\.gxf3 fails: 2\. you gxf3 \[takes bishop/);
  assert.match(linkMoves('2.gxf3', [r.compared.line]), /data-line="b4 Bxf3 gxf3"/);
  // Kramnik-Leko 2001: Qa1 prepares Bxd5, which fails at once to Qb6 hitting the queen on b2
  r = await ask('2rq1rk1/R2n1ppp/4p3/2pb4/5B2/6P1/1Q2PPBP/3R2K1 w - - 0 21', 'e4', 'b2a1');
  assert.equal(facts.alternative.prepares.move, 'Bxd5');
  assert.match(facts.alternative.prepares.line_if_played_at_once, /opp Qb6 \[attacks your queen on b2/);
  // Skoberne-Suarez 2012: Rf1 prepares Nxg6; at once the engine line avoids Qxh6, which fails to Qxf2+ (Rf1 guards f2)
  r = await ask('r4rkb/ppR5/3Np1pp/4n3/5N2/4Q3/q4PPP/3R2K1 w - - 2 24', 'Re7', 'd1f1');
  assert.equal(facts.alternative.prepares.move, 'Nxg6');
  assert.match(facts.alternative.prepares.follow_up_fails, /^Why 25\.Qxh6 fails: 25\. you Qxh6 .* 25\.\.\. opp Qxf2\+ /);
  assert.equal(facts.alternative.prepares.better_move_guards, 'f2');
  console.log('ok');
} finally {
  engines.quit();
}
