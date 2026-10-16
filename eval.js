// Explains 132 quiet positions from lichess games, where the better move wins on position, not with a tactic.
// The engines give the same lines on every run, so run this before and after a change and diff the two folders.
// usage: ANTHROPIC_API_KEY=... node eval.js [out-dir] [--no-llm] [--model ID] [--facts DIR] [--summary] [--judge]   (out-dir defaults to eval-out)
// out-dir/summary.txt flags format slips in each answer; node eval.js out-dir --summary re-checks without a run.
// --facts DIR reuses DIR's fact sheets (no engines), so only the LLM runs, 16 at a time.
// --judge has Claude Opus grade each answer against its fact sheet (a few cents per answer, kept in <name>.judge.json).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SYSTEM, explain } from './extension/explain.js';

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
  // rapid games, average rating 2700-2800, 2026-10-12..15: the played move loses 0.5-1.6 pawns to the engine's
  // best (at least 0.3 at the eval's 2M nodes), and the first 3 plies of both lines hold no capture or check
  ['orzMpKP1', 'r4rk1/4bppp/2p2n2/p3pQB1/Np1qP3/1P1P4/1PP3PP/R4R1K b - - 4 19', 'h6', 'Rab8'],
  ['EusqhACq', '1b3rk1/5pp1/p1p1r2p/5q2/PnNP4/4B1P1/1P3P1P/2RR1QK1 b - - 3 28', 'Rfe8', 'Na2'],
  ['lMdZrvEa', '4kb1r/p1pp1ppp/4q3/2PpP3/3Q4/Pr2B3/1P3PPP/R4K1R w k - 2 17', 'Rd1', 'Qd2'],
  ['lMdZrvEa', '4k2r/p2pbpp1/2p5/2PpPq1p/3B3P/Pr6/1P1Q1PP1/3R1K1R w k - 0 21', 'Kg1', 'Qc1'],
  ['L26hFB6w', '2r5/1br3k1/4p3/1p6/1N1b2NP/PR3P2/1P2K3/7R w - - 2 49', 'Kd2', 'Rd1'],
  ['H7t0ucoI', '1r1r1qk1/R2b2p1/4pn1p/5p2/1PNQ4/7P/1B3PP1/R5K1 b - - 10 35', 'Nd5', 'Bb5'],
  ['H7t0ucoI', 'r3rnk1/3b1qp1/4p2p/N3Rp2/1P6/2Q5/1B3PPP/4R1K1 b - - 0 28', 'Red8', 'Ng6'],
  ['Vov01cVS', '2krr3/p1q2pp1/2p4p/2P1N3/1p2P3/7b/PQP2PP1/R4RK1 w - - 0 23', 'Nd3', 'f4'],
  ['H3d2z4Y0', 'rr6/p2k1ppp/2p2n2/q7/P2Pp3/Q3P1P1/5P1P/R4KNR w - - 1 19', 'Kg2', 'Ne2'],
  ['peXFmRmC', '4q2r/1kr2p2/2b1pQp1/3pP1Np/p1pP1PP1/PpP4R/1P5P/4R1K1 b - - 0 32', 'Rg8', 'Re7'],
  ['dyCWjlZk', '2r3k1/b4ppp/pq6/4Pb2/P2p1P2/1N3Q2/1P1B2PP/5R1K w - - 0 27', 'a5', 'Ba5'],
  ['dyCWjlZk', '2rq1rk1/b4ppp/p7/4Pb2/P2p1P2/1N3Q2/1P1B2PP/R4R1K w - - 5 25', 'Rac1', 'Bb4'],
  ['HmlUQVtJ', '5r1k/8/5q1p/p2Qb3/1p5P/6P1/5PK1/3B1R2 b - - 2 44', 'Bc7', 'Qf5'],
  ['eqNckBaj', 'r4r2/1p1q1ppk/3p3p/2bPpN2/p5P1/P1P5/1P1Q1PKP/4RR2 b - - 0 22', 'Ra6', 'b5'],
  ['nnEJJnGD', 'r1bqr1k1/Bp3ppp/2n2n2/1N1pp3/8/2PQ2P1/PP2PP1P/R3KB1R w KQ - 1 14', 'Be3', 'Bc5'],
  ['NwkBxFEa', '3r1k2/4nr1p/p1q1pBp1/1pppP3/6PP/2P3K1/PPQ2P2/3R1R2 b - - 4 30', 'Re8', 'Rd7'],
  ['2SeIpuCP', 'r3kb1r/ppq1pppp/P1p2n2/4Pb2/8/2N5/1P2PPPP/R1BQKB1R b KQkq - 0 11', 'Ng4', 'Nd7'],
  ['Yj0dh7BT', 'r7/6pk/2R4p/p7/7N/4P2P/2P1n1PK/8 w - - 3 35', 'Rb6', 'Nf3'],
  ['msxOAU8M', '4r1k1/5p2/p2p3P/1p4P1/1P3K2/P4N2/2P2R2/3r4 w - - 1 54', 'Nd2', 'Rg2'],
  ['wZ15P57b', 'rnb1k2r/ppp2ppp/3bpq2/4N3/3PB3/6P1/PPP2P1P/R1BQ1K1R w kq - 3 14', 'Ng4', 'h4'],
  ['NDQvjObo', 'r2q1rk1/pp2ppbp/1nnp2p1/5b2/2PP1B2/2N2N1P/PP2BPP1/R2Q1RK1 b - - 8 11', 'h6', 'e5'],
  ['E0mXk2Og', 'r2q1rk1/1p2b1pp/p1n2p2/2p1p3/6b1/2NP1N2/PPP2PPP/R1BQR1K1 w - - 3 13', 'Be3', 'h3'],
  ['L7yPcyea', '4r3/R3pk2/4n3/R5p1/2P1b1P1/6K1/8/8 w - - 2 55', 'R7a6', 'Re5'],
  ['NJbj8VgI', 'r2qr1k1/5pp1/bp4np/p3p3/PnN5/3PPN1P/1PB2QP1/2R2RK1 w - - 2 20', 'Nfd2', 'Rfd1'],
  ['0de71ZRa', '1r3n2/pp3k1p/5P2/2pNn2p/2P1B3/1P6/1K2R3/8 w - - 0 34', 'Rf2', 'Rh2'],
  ['0de71ZRa', '1r2kn2/pp4pp/5p2/P1pNnB2/2P5/1P5P/4R1P1/2K5 w - - 4 27', 'g4', 'Nf4'],
  ['n8PpluAU', '2r1r3/4k3/1npb2p1/1p3pNp/p2P3P/P5P1/1PR1BP2/3R2K1 b - - 3 23', 'Kd7', 'Rc7'],
  ['qAhPCCM7', '1r1qnrk1/p6p/2Rp2pb/p2Pp3/8/PP3P1P/4N1P1/3QBR1K b - - 1 28', 'Nf6', 'Ng7'],
  ['NSey1DLg', '3r1k2/p3bppp/1p2p3/r7/Pn1BP3/1P3BP1/5P1P/2RR2K1 b - - 2 23', 'Na6', 'f6'],
  ['FduYSIGx', 'r1bq2k1/1p3pp1/2pb3p/p2pr3/P4P2/2NB4/1PQ1N1PP/R4R1K b - - 0 19', 'Rh5', 'Re3'],
  ['FduYSIGx', 'r1bqrnk1/1p2bpp1/2p2n1p/p2p4/P2P3B/2NBPP2/1P2N1PP/R2Q1R1K b - - 2 13', 'Bd6', 'Ne6'],
  ['vjiUCRUd', '8/4pk2/3p3r/BP3r2/P4p2/1R5P/5b1K/3R4 b - - 0 47', 'Re5', 'Be3'],
  ['mC0jhWxd', '2rq2k1/1br2pp1/p3p2p/1p2N3/3P3P/Q1PBnPP1/P1R4K/2R5 w - - 3 33', 'Re2', 'Rf2'],
  ['AvksUwBn', '1r1qnr2/5ppk/3p4/4n2P/1p2P3/1N4Q1/1PP1N3/1K1R3R b - - 0 29', 'Kg8', 'Qc8'],
  ['Jj2g4yAF', '2r1rbk1/1q1n1pp1/p2ppn2/1p4Rp/4PP1P/PNN1B3/1PP1Q3/1K5R w - - 2 20', 'Nd2', 'Bd2'],
  ['kc24fa4q', '2rq1r2/pp2ppkp/5nb1/2p1N2p/3P4/3BQ3/PPP5/2K3RR w - - 0 21', 'Qg3', 'Qg5'],
  ['kc24fa4q', 'r2q1r2/ppp1ppkp/5n2/4Nb1p/3P4/2Q5/PPP5/2K1RB1R w - - 2 18', 'Qe3', 'Bg2'],
  ['xiGGZ2Su', 'r2r4/1q2bbk1/2p1np1p/p2pp1p1/N3P3/PP5Q/2P2PPP/R1BR1BK1 w - - 13 30', 'Bb2', 'Be3'],
  ['SFSIn4J4', '6k1/r4pp1/3Np2p/8/1PP4P/1K1R4/5rP1/8 w - - 2 34', 'c5', 'b5'],
  ['iYqu8UB4', '4k3/4bp2/1pp1b1p1/p1p1Pr2/Pn5p/1PR2N1P/1B3PP1/3R1K2 w - - 0 35', 'Bc1', 'Re3'],
  ['pR01v3OJ', '1r3k2/2p2pp1/3p3p/r1nPn3/pp1RP3/4BPNP/PP4P1/3R1K2 b - - 15 32', 'Rab5', 'f6'],
  ['neW2OCV3', '2kr2rb/pp1q3p/n2pp3/2p2p2/8/2P2NNP/PPQ2PP1/3RR1K1 w - - 0 19', 'c4', 'Qc1'],
  ['neW2OCV3', '2kr1b1r/pp1qpp1p/n2p1p2/2pP4/8/2P2N2/PP1N1PPP/R2QR1K1 w - - 2 13', 'Nf1', 'b4'],
  ['jg9udT1u', '3rr3/4p1kp/1Np2pp1/2P1p3/R7/1R1P1PP1/2Pb1K1P/8 b - - 1 34', 'Bg5', 'h5'],
  ['LuwaRWxE', '8/4qpk1/1p3br1/p4Q1p/P1P1B1p1/6P1/6K1/5R2 w - - 0 51', 'Rb1', 'Rf4'],
  ['Wbry6WuJ', '2r1k2r/1p2nppp/p2q1n2/3pb3/1P6/P1NRPQ1P/1BB2PP1/1R4K1 b k - 12 18', 'g5', 'O-O'],
  ['e4AauTmh', '5r2/2p3pk/1p1p2qp/p1bPpr2/P3N3/2PQ1PP1/1P4KP/1R3R2 b - - 2 21', 'Qf7', 'Kg8'],
  ['K18Hh0jP', '4rrk1/1bpq1ppp/3b1n2/pp6/3P4/2P2P2/PPB1R1PP/R1BQ1NK1 b - - 1 17', 'b4', 'c5'],
  ['K18Hh0jP', '4rrk1/1bpq1ppp/p2b1n2/1p6/3P4/1BP2P2/PP2R1PP/R1BQ1NK1 b - - 0 16', 'a5', 'Nd5'],
  ['plKk1oMh', 'r1b1kb1r/3n1p1p/1q2pp2/1p6/3p4/3B1N2/PP3PPP/R1BQ1RK1 w kq - 2 14', 'Re1', 'Qe2'],
  ['SInAWjqI', '8/5k1p/2p2p1P/1p1p4/pPnP1Nr1/P2K2P1/5P2/2R5 w - - 8 105', 'Ra1', 'Rc3'],
  ['LygHuraB', 'r3r1k1/5qp1/7p/p2p2b1/1QnB4/1N1R1P2/PPP5/K5R1 w - - 0 35', 'Qc3', 'Qa4'],
  ['LygHuraB', 'rq1r2k1/4b1pp/p3b3/3pn1p1/1p1B3P/1N3P2/PPPQB3/2KR3R b - - 0 26', 'Qc7', 'Nc4'],
  ['xw1jPZnE', 'r5k1/1r4b1/3p1nPp/3Pp1p1/N2nP3/4BP2/1P4R1/1K1B3R w - - 1 34', 'Nc3', 'Rf2'],
  ['0TCpBdB3', '6k1/pp4p1/1b3r2/2r4p/3N4/6PP/PP1RRP2/6K1 b - - 0 30', 'Rc4', 'Ra5'],
  ['j2h2NfX2', '5rk1/3R4/7p/6pP/R4b2/8/1P1p2K1/8 b - - 2 42', 'g4', 'Rb8'],
  ['rUQW2M3D', 'r3rbk1/5pp1/p6p/1p1PP3/3q1P2/1P1R1QP1/P5PK/2R5 b - - 0 29', 'Qb2', 'Qa7'],
  ['wuZTx6eL', '3r4/2R2B2/6pk/8/4K3/8/8/8 b - - 0 55', 'g5', 'Rd6'],
  ['cJw4pEHp', 'r2qkb1r/2p2ppp/p1n1b3/1pnpP3/8/1BP2N2/PP1N1PPP/R1BQ1RK1 b kq - 0 10', 'g6', 'Be7'],
  ['bhGRpiai', 'Q7/1rq1bnk1/3p2p1/1b1Pp2p/1Bp1N1PP/2P1N3/R4PK1/8 b - - 0 59', 'Rb8', 'Bd7'],
  ['bhGRpiai', 'Q7/1r1qbnk1/3p2p1/1b1Pp2p/1Bp1N2P/2P1N1P1/R4PK1/8 b - - 8 58', 'Qc7', 'Rc7'],
  ['VGnzoxo4', 'k3r3/3N1R2/2r1P3/q1pp4/3p1Q2/pPPP4/P7/1K6 w - - 2 47', 'Qe5', 'Re7'],
  ['D81lOfrg', '2b1rkr1/5p2/2p2P2/2Np4/1p1P1R2/1P2n3/4B3/2K4R w - - 12 48', 'Kd2', 'Ba6'],
  ['BGjjmHdc', '4rrk1/3qb2n/3p2p1/p1pP1p1p/2P2R2/3B1N1P/PPQ3P1/5RK1 w - - 2 26', 'b3', 'Kh1'],
  ['qrepHwUD', 'r1r3k1/1p1bbppp/1q1ppn2/p5B1/Pn2P1PP/1NN4R/1PP1QP2/1K1R1B2 b - - 4 15', 'Qd8', 'e5'],
  ['4HFhs36n', '6k1/6Pp/7B/8/8/8/1K6/8 w - - 17 68', 'Kb3', 'Kc1'],
  ['W9OqobQ3', '5nk1/5r1p/1q1np1pP/pp1pp1B1/4P2Q/PP4N1/6PK/2R5 w - - 0 37', 'Bd8', 'Qg4'],
  ['71SJpI9Y', '4r1k1/5pp1/3P1n2/2p1NQ1p/qpP5/4P1P1/1P5P/1R4K1 b - - 0 43', 'Rd8', 'Re6'],
  ['fFjh6fa4', '5qk1/ppr2p2/3r2pp/b2pN3/b2P2PP/4PQ2/1R3PB1/5RK1 w - - 0 38', 'h5', 'Qg3'],
  ['T5ZGv7fU', '8/p4p2/7p/3nkB2/8/P1p5/2P2PP1/5K2 w - - 3 37', 'Bd3', 'Bh7'],
  ['M9WRJdZz', '2qrr3/5pkp/6p1/p6P/Pp1N4/1Pp2BP1/2P2BK1/3R2R1 b - - 1 34', 'Kg8', 'h6'],
  ['dN5zZp6F', '2bq2k1/5pb1/3p1n1p/2pPp1p1/BpP1PnP1/4B1NP/1P3P1K/3Q2N1 w - - 4 36', 'Bc6', 'f3'],
  ['Jq3JSauI', 'r3k2r/6pp/p2np3/1b1nN3/8/8/PPP1B1PP/2KR3R w kq - 2 22', 'Bg4', 'c4'],
  ['EHOzVtKO', 'r3k2r/1pqn1pb1/p2p1np1/N2Pp2p/8/4BP2/PPPQB1PP/R3K2R w KQkq - 6 14', 'g3', 'O-O'],
  ['h9rwmGic', '8/8/r1p1k3/3npr1p/P7/1P4P1/2RN2K1/4R3 b - - 7 45', 'Rb6', 'Nb4'],
  ['meCjJnV1', 'r1r3k1/p4pp1/4b2p/3p4/3R4/1P6/P1P1RPPP/5BK1 b - - 0 25', 'Rc6', 'a5'],
  ['lrRhcfPK', '5rk1/1pp2p2/2n3pp/p1q1p3/P5Q1/2PrN2P/1P3PP1/R4RK1 w - - 0 18', 'Qh4', 'Rfd1'],
  ['ACI7KznB', '3r2k1/1pp1np2/7p/pP2p1p1/P1B1P3/2P1PP1P/3r1RK1/R7 w - - 3 22', 'Rf1', 'Ra2'],
  ['NhAdzkDC', 'rn5r/pp4pp/2kbpp2/2p5/P4P2/2P1B1P1/2PN2KP/R4R2 w - - 1 16', 'Nc4', 'a5'],
  ['yOIytlYQ', '5rkq/5p2/4n3/8/p3p1pN/P5P1/1P1Q2PK/5R2 b - - 7 39', 'Nd4', 'Qd4'],
  ['1Vvi1S3Y', '2rr4/p2bkppp/4p3/np6/3N1P2/2P3P1/PP4BP/2KRR3 b - - 1 18', 'b4', 'Kf6'],
  ['xMVfE0Pp', '8/3k4/1p2p1p1/3nPn1p/2rP3P/PR2B1PK/5P2/4N3 w - - 3 39', 'Nf3', 'Rd3'],
  ['xMVfE0Pp', '8/3k4/1p2p1p1/3nPnB1/3P2KP/P2R4/3N1P2/r7 w - - 7 45', 'Nc4', 'Ne4'],
  ['GKmrf657', 'r1b1k2r/pp3p1p/3pn3/4R1BQ/2p5/q7/5PPP/3R2K1 w kq - 0 24', 'Red5', 'Bc1'],
  ['g5aH1qTg', 'r2r2k1/3bnpp1/Nppb1q2/3p3p/p2P4/2RQPN1P/PP2BPP1/2R3K1 w - - 0 24', 'Qd1', 'b4'],
  ['DsRG6EaG', 'r3k2r/ppp2pp1/2p5/4PbPp/1b6/2N1BP2/PPPR3P/R5K1 w - - 3 17', 'h4', 'Rad1'],
  ['CyplYeqq', 'r2qk2r/4bp2/1nb1p1p1/pp1pPnN1/2pP1PBp/P1P4P/1PNQ1BP1/R4RK1 b kq - 3 20', 'Bd7', 'Nd7'],
  ['CyplYeqq', '1r2k2r/3bbp2/1q2p1p1/pp1pPnN1/n1pP1P1p/P1P2N1P/1P1Q1BP1/RR1B2K1 b k - 11 24', 'Qa6', 'Qd8'],
  ['JFzldc1D', 'r1bqr1k1/4bppp/p2p1n2/2p5/1p2PBP1/5P2/PPP1N2P/1K1R1BQR b - - 1 14', 'Be6', 'Nd7'],
  ['SHWn82XK', '3r4/5pk1/1R6/p2P2pp/P1P5/3KP2r/8/4R3 w - - 1 38', 'Rf1', 'Kd4'],
  ['3TWXdRWz', '1r4k1/2n1bb2/4p1p1/2p1Pp1p/N1B2P1P/1P4P1/3N4/2R1K3 b - - 13 38', 'Rc8', 'Be8'],
  ['GbtlMYVr', '3q2r1/6pk/r1p1p2p/1pQpBb2/p2P4/P1R3RP/1P3PP1/6K1 w - - 35 53', 'Rcf3', 'Rgf3'],
  ['4VIZxQnf', '2b1qrk1/1p2r1p1/p3p1n1/2P2pP1/5P2/PB5R/KP1Q2P1/4R3 w - - 12 39', 'Reh1', 'Rd3'],
  ['4VIZxQnf', '2b2rkn/1p2r1p1/p3p3/Q1P2pPq/5P2/PB1R4/KP4P1/4R3 w - - 8 37', 'Rh3', 'Red1'],
  ['AnXT6hCt', '2r2bk1/7p/3p4/3Pp2p/PQ6/3R4/1PPBq1r1/1KR5 b - - 0 33', 'Rg4', 'e4'],
  ['2yKQQ07m', '3r2k1/3n2r1/p2NR3/1p4p1/3P1pn1/P6b/1P1K1B2/1BR5 w - - 0 36', 'Bg1', 'Ba2'],
  ['grCHD9Fs', 'r4rk1/1bq1b1p1/1n2pn1p/pBp5/4P3/2N2N2/1P1BQPPP/R2R2K1 b - - 1 18', 'Nfd7', 'a4'],
  ['J1QTVKuE', '2r1n1k1/p5p1/2P2p1p/p1R5/5P2/8/1B5P/5K2 w - - 2 40', 'h4', 'Ke2'],
  ['aZ89WtQz', '6k1/4bpp1/q1p1p3/4Pb1p/p2P4/PpP4P/1Q3PP1/R2R2K1 w - - 0 34', 'Kh1', 'f4'],
  ['MEmTpNhy', 'rnbq2n1/ppp3kr/3p3p/8/2BPPPpb/2N1B3/PPP1K3/R2Q3R b - - 0 13', 'c6', 'Kh8'],
  ['bFDwiC0r', '5rk1/pp6/2p4p/4Rbp1/2P5/5P2/PP4PP/3N2K1 b - - 0 24', 'Bg6', 'Bd3'],
  ['653CfukA', '1r2r1k1/Q3bp1p/p2p2p1/qp2p1Pn/4B3/4BP2/PPP4P/1K1R3R b - - 5 21', 'Ng7', 'b4'],
];

// ---- the judge ----

const JUDGE = `You grade answers from a chess explainer. You get the fact sheet the explainer was given (JSON) and its answer.
The fact sheet is the ground truth: judge the answer only against it, and do not analyse the position yourself.
- decisive_point: "yes" if the answer gives the reason the fact sheet shows the better move is better: where the evals of the
  two lines part and why (the labels on those moves), a threat one move meets and the other ignores ("opponent_threat",
  "if_opp_plays_the_threat_at_once"), the idea in "prepares", or the term gaps when "sf15_total_gap" is at least half of
  "latest_sf_gap". "partly" if it gives that reason only vaguely, or leads with a minor or wrong reason. "no" otherwise.
- false_claims: every statement in the answer that the fact sheet contradicts or does not support: a piece called defended,
  undefended, lost, won, trapped or pinned; a capture, check, attack or threat; who plays a move; an eval or material count;
  a move given in a line it is not in, in a different order, or a "Why ... fails" side line presented as the main line.
  For each, quote the claim and say in a few words what the facts show. Plain chess descriptions that the labels support
  are fine; do not list style issues.
- invented_term_cause: true if the answer gives a cause for an SF 15 term difference that no structure label, capture
  label or end note up to "explained_at_position_after" supports (the explainer's rule 9).
- note: one sentence on the answer's main weakness, or "" if it has none.

The explainer's own instructions, which define the fact sheet's fields and labels:

${SYSTEM}`;

const VERDICT = {
  type: 'object',
  properties: {
    decisive_point: { type: 'string', enum: ['yes', 'partly', 'no'] },
    false_claims: {
      type: 'array',
      items: {
        type: 'object', properties: { claim: { type: 'string' }, facts: { type: 'string' } },
        required: ['claim', 'facts'], additionalProperties: false,
      },
    },
    invented_term_cause: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['decisive_point', 'false_claims', 'invented_term_cause', 'note'],
  additionalProperties: false,
};

const args = process.argv.slice(2);
const out = args.find((a, i) => !a.startsWith('--') && !['--model', '--facts'].includes(args[i - 1])) ?? 'eval-out';
const facts = args.includes('--facts') ? args[args.indexOf('--facts') + 1] : null;
const mi = args.indexOf('--model');
const flags = [...args.includes('--no-llm') ? ['--no-llm'] : [], ...mi >= 0 ? ['--model', args[mi + 1]] : []];
const cli = fileURLToPath(new URL('extension/explain.js', import.meta.url));
const run = promisify(execFile);
mkdirSync(out, { recursive: true });

// each position runs in its own process (fresh engines), four at a time; --summary only re-checks out-dir
const queue = args.includes('--summary') ? [] : [...POSITIONS];
await Promise.all(Array.from({ length: facts ? 16 : 4 }, async () => {
  for (let p; (p = queue.shift());) {
    const [game, fen, played, better] = p;
    const [, turn, , , , moveNo] = fen.split(' ');
    const name = `${game}-${moveNo}${turn}`; // NRzf6Iy4-13b: Black's 13th move
    let text;
    try {
      if (facts) {
        const sheet = readFileSync(`${facts}/${name}.txt`, 'utf8').split('\n\n')[0];
        text = `${sheet}\n\n${await explain(JSON.parse(sheet), process.env.ANTHROPIC_API_KEY, mi >= 0 ? args[mi + 1] : undefined)}\n`;
      } else text = (await run(process.execPath, [cli, fen, played, '--vs', better, ...flags], { maxBuffer: 1 << 24 })).stdout;
    } catch (e) {
      text = `ERROR: ${e.stderr || e.message}`;
    }
    writeFileSync(`${out}/${name}.txt`, text);
    console.log(name, text.startsWith('ERROR') ? 'failed' : 'ok');
  }
}));
const answers = readdirSync(out).filter(f => f.endsWith('.txt') && f !== 'summary.txt').sort().map(f => f.slice(0, -4));
if (args.includes('--judge')) await judgeAll(answers.filter(n => !existsSync(`${out}/${n}.judge.json`)));
const verdicts = [];
const report = answers.map(n => {
  const text = readFileSync(`${out}/${n}.txt`, 'utf8');
  const found = text.startsWith('ERROR') ? ['failed'] : problems(text);
  if (existsSync(`${out}/${n}.judge.json`)) {
    const v = JSON.parse(readFileSync(`${out}/${n}.judge.json`, 'utf8'));
    verdicts.push(v);
    if (v.decisive_point !== 'yes') found.push(`judge: decisive point ${v.decisive_point}`);
    for (const c of v.false_claims) found.push(`judge: false claim "${c.claim}" (${c.facts})`);
    if (v.invented_term_cause) found.push('judge: invented term cause');
  }
  return `${n} ${found.join(', ') || 'ok'}`;
});
writeFileSync(`${out}/summary.txt`, report.join('\n') + '\n');
console.log(`\n${report.length} positions, ${report.filter(r => !r.endsWith(' ok')).length} flagged (see ${out}/summary.txt)`);
if (verdicts.length) {
  const count = f => verdicts.filter(f).length;
  console.log(`judged ${verdicts.length}: decisive point yes ${count(v => v.decisive_point === 'yes')}, `
    + `partly ${count(v => v.decisive_point === 'partly')}, no ${count(v => v.decisive_point === 'no')}; `
    + `false claims in ${count(v => v.false_claims.length)}; invented term causes in ${count(v => v.invented_term_cause)}`);
}

/** Judges each named answer in out-dir, four at a time, and writes <name>.judge.json next to it. */
async function judgeAll(names) {
  // API-bound, not CPU-bound: more in flight than the engine runs
  await Promise.all(Array.from({ length: 16 }, async () => {
    for (let n; (n = names.shift());) {
      const text = readFileSync(`${out}/${n}.txt`, 'utf8'), cut = text.indexOf('\n\n');
      if (text.startsWith('ERROR') || cut < 0) continue; // nothing to judge
      try {
        writeFileSync(`${out}/${n}.judge.json`, JSON.stringify(await judge(text.slice(0, cut), text.slice(cut + 2)), null, 1) + '\n');
        console.log(n, 'judged');
      } catch (e) {
        console.log(n, `judge failed: ${e.message}`);
      }
    }
  }));
}

async function judge(facts, answer) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      // on a safety decline, the API re-runs the request on a fallback model
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema: VERDICT } },
      system: [{ type: 'text', text: JUDGE, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Fact sheet:\n${facts}\n\nAnswer:\n${answer}` }],
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`Anthropic API error ${r.status}: ${body.error?.message ?? r.statusText}`);
  if (body.stop_reason !== 'end_turn') throw new Error(`stopped: ${body.stop_reason}`);
  return { ...JSON.parse(body.content.find(b => b.type === 'text').text), usage: body.usage };
}

/** Mechanical checks on one CLI output (fact sheet JSON, blank line, answer). They catch format slips, not wrong chess. */
function problems(text) {
  const cut = text.indexOf('\n\n');
  if (cut < 0) return []; // --no-llm: fact sheet only
  const facts = text.slice(0, cut), answer = text.slice(cut + 2);
  const sheet = JSON.parse(facts);
  const found = [];
  const words = answer.split(/\s+/).filter(Boolean).length;
  if (words > 120) found.push(`${words} words`);
  if (/\[(takes|line ends)|\b\d+\.(\.\.)? (you|opp) /.test(answer)) found.push('raw label');
  if (/(?<![\d.+\-−])\b\d+\.(\.\.)? ([KQRBN][a-h1-8]?x?[a-h][1-8]|[a-h]x?[a-h]?[1-8]\b|O-O)/.test(answer)) found.push('space after move number');
  if (!sheet.position_before_move?.you_are_in_check_from && /\bin check\b/i.test(answer)) found.push('check not in facts');
  // piece moves, pawn captures and numbered pawn moves must come from the fact sheet ("attacks your Nf3" names a piece)
  const sans = answer.match(/(?<!(your|the|opp's|Black's|White's|attacks|hits) )\b(\d+\.(\.\.)?)?([KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8])|\b\d+\.(\.\.)?[a-h][1-8]\b/g) ?? [];
  const unknown = [...new Set(sans.map(s => s.replace(/^\d+\.(\.\.)?/, '')))].filter(s => !facts.includes(s));
  if (unknown.length) found.push(`moves not in facts: ${unknown.join(' ')}`);
  return found;
}
