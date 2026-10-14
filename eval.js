// Explains 30 quiet positions from lichess games, where the better move wins on position, not with a tactic.
// The engines give the same lines on every run, so run this before and after a change and diff the two folders.
// usage: ANTHROPIC_API_KEY=... node eval.js [out-dir] [--no-llm]   (out-dir defaults to eval-out)
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// [lichess game, FEN, move played, better move]
const POSITIONS = [
  ['NRzf6Iy4', 'r1bq1rk1/pp1n1pp1/4pb1p/2pp4/3P1P2/2PBPN1P/PP4PB/R2Q1RK1 b - - 0 13', 'Qb6', 'cxd4'],
  ['0fm0O2a2', 'r2qr1k1/4nppp/p2Bp3/1p1pP3/3P4/3QP2R/PP4PP/R5K1 b - - 4 19', 'Ng6', 'Nf5'],
  ['d0xbfBCD', '2rq1rk1/p1p1bppp/1nR1p3/1p6/4PB2/3P2P1/PP3PBP/3QR1K1 w - - 1 17', 'Qc2', 'Qb3'],
  ['Z1hXRLg9', 'r2q1rk1/pp1n1ppb/2p4p/b4p1P/3P4/2PBBN2/PP3PP1/R2QR1K1 w - - 0 16', 'Qd2', 'Qb3'],
  ['2AxSMitS', '2rq1rk1/1p1bbppp/p1np1n2/4pP2/2B1P3/2PP2NP/6P1/RNBQ1RK1 b - - 0 13', 'Be8', 'b5'],
  ['hiMJd5P0', 'r5k1/p2b1rpp/1ppB4/2Pp3Q/3qp3/1P5P/P3RPP1/2R3K1 b - - 0 22', 'b5', 'Re8'],
  ['NRzf6Iy4', 'r1b2rk1/pp1n1pp1/1q2pb1p/2pp4/3P1P2/2PBPN1P/PP4PB/R2Q1RK1 w - - 1 14', 'Rb1', 'Rf2'],
  ['TAMn8epD', '1nb2rk1/pp1pbppp/8/q7/3p4/5Q2/PPPN1PPP/R3KB1R w KQ - 2 13', 'Bd3', 'Bc4'],
  ['jrXaDiU8', 'rn1qk2r/ppb3pp/2p1pp2/8/2NPbP2/2P5/PP2B1PP/R1BQ1RK1 b kq - 0 13', 'Nd7', 'O-O'],
  ['vIAOHcq8', 'r4rk1/p1ppq1pn/1p2p2p/4Pp2/2nP1P2/P1P3PP/3BN1K1/R2Q1R2 b - - 1 17', 'Rad8', 'd6'],
  ['5SYLRz3J', '6k1/2p2p1p/p1Pp1np1/1p3n2/8/1BN2P2/PPP3PP/6K1 w - - 1 25', 'Kf2', 'Ne2'],
  ['C1zHPoby', '1r1r2k1/ppbbqpp1/4p2p/2P1P3/1P5P/2B2BP1/4QP2/1R1R2K1 w - - 5 26', 'Rd2', 'Be4'],
  ['0fm0O2a2', 'r2q1rk1/4nppp/p2Bp3/1p1pP3/3P4/3QP3/PP4PP/R4RK1 w - - 1 18', 'Rf3', 'Bc5'],
  ['Kcq6FpwJ', '7r/p2b2p1/2nkp1B1/3p3P/2nP1PP1/2P5/1P2R3/1K5R b - - 0 28', 'Ne7', 'a5'],
  ['XKFuBk2O', 'r4rn1/pb1nq1kp/1p2p1p1/3pPp2/3P1P2/P2BN3/1P1QN1PP/R4RK1 b - - 0 18', 'h6', 'a6'],
  ['tGREFmBg', 'r6r/p1pbk3/2p1nppp/4p3/N3P3/5NP1/PPP2P1P/2KR3R w - - 1 17', 'c4', 'Nd2'],
  ['5trsxnT6', 'r3r1k1/1p3p1p/3p2p1/p2Pb1q1/2Pp4/PP1B1Q1P/4RPP1/4R1K1 w - - 1 22', 'Re4', 'g3'],
  ['CBgQXgX3', 'r1bqr1k1/ppp2pbp/1n4p1/2BPpn2/2P5/2N2N1P/PP2BPP1/R2Q1RK1 w - - 5 13', 'Re1', 'Bd3'],
  ['VpFFPt53', 'rn3rk1/1p3pp1/p2qp2p/5b2/3P4/P3B2P/1PPN1PP1/1R1Q1RK1 b - - 1 16', 'Qc6', 'Nc6'],
  ['vkyOdAhn', '1r4k1/1p2rpp1/p1p2n1p/P1n1p3/2N1P3/2P3P1/1P3PBP/R3R1K1 b - - 0 21', 'Ncd7', 'Ne8'],
  ['EAzff9oR', '1rbq1rk1/p4ppp/2B2n2/3p4/8/2P1BP2/P1P3PP/R2Q1RK1 b - - 0 13', 'Qd6', 'Ba6'],
  ['PuxlxrwP', 'r4rk1/3qbppp/p4n2/1pp1p3/4P3/1PP1BQN1/1P3PPP/R3R1K1 b - - 2 16', 'Rfe8', 'Qe6'],
  ['8ONAnTC3', 'r2q1rk1/ppp2ppp/2n1b3/3n4/Q1pP4/2P2N2/P2BBPPP/R4R1K w - - 3 13', 'Rab1', 'Ng5'],
  ['uJ7D5kNy', 'r2qr1k1/1p3ppp/p1n1pn2/3p4/3P4/P1N1PBP1/1P3PP1/2RQ1RK1 b - - 0 14', 'e5', 'g6'],
  ['unucJKiW', '4r3/R4pk1/2pq1rpp/1p1pn3/1P1Q4/2P1P1P1/4BP1P/R5K1 b - - 2 30', 'Re7', 'Qe6'],
  ['KwDypsxS', 'r3r1k1/pb1q1pb1/1p1n1n1p/3p2p1/3P2P1/1PNQPBNP/P7/R1B2RK1 b - - 2 21', 'Nde4', 'Rac8'],
  ['rLmNcw8B', 'r1r5/1p1k2pp/p2p4/1P1np3/P2p1P2/1P4P1/1B1P3P/1R2K2R w K - 0 22', 'O-O', 'Rf1'],
  ['DFsQMu23', '2rr2k1/p5bp/1n4p1/1B3p2/8/P4PN1/1P3P1P/1K1R1R2 w - - 2 22', 'h4', 'Ba6'],
  ['tehSwOjl', '4r3/5k1p/p5p1/1pp5/2Pb1BP1/8/P2R1PP1/5K2 w - - 0 27', 'Rc2', 'Re2'],
  ['F2fmLWtB', '8/4r1p1/p4p2/1ppk4/5P1R/8/PPPK2P1/8 w - - 2 31', 'Rh8', 'Rh3'],
];

const args = process.argv.slice(2);
const out = args.find(a => !a.startsWith('--')) ?? 'eval-out';
const flags = args.includes('--no-llm') ? ['--no-llm'] : ['--effort', 'high']; // high: what the panel uses
const cli = fileURLToPath(new URL('extension/explain.js', import.meta.url));
const run = promisify(execFile);
mkdirSync(out, { recursive: true });

// each position runs in its own process (fresh engines), four at a time
const queue = [...POSITIONS];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let p; (p = queue.shift());) {
    const [game, fen, played, better] = p;
    const [, turn, , , , moveNo] = fen.split(' ');
    const name = `${game}-${moveNo}${turn}`; // NRzf6Iy4-13b: Black's 13th move
    let text;
    try {
      text = (await run(process.execPath, [cli, fen, played, '--vs', better, ...flags], { maxBuffer: 1 << 24 })).stdout;
    } catch (e) {
      text = `ERROR: ${e.stderr || e.message}`;
    }
    writeFileSync(`${out}/${name}.txt`, text);
    console.log(name, text.startsWith('ERROR') ? 'failed' : 'ok');
  }
}));
