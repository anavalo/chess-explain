// Engine tools for an LLM coach: one command per call, JSON on stdout. Not part of the extension.
//   node tools.js eval FEN [SAN...]   play the moves, then search: eval, pv, line with evals
//   node tools.js best FEN [N]        top N moves with evals
//   node tools.js threat FEN          what the side not to move would play if the mover passed
//   node tools.js square FEN SQ       attackers and defenders of SQ
//   node tools.js labels FEN          imbalances, pieces in danger, pins, trapped pieces, end notes
//   node tools.js line FEN SAN...     the given line with evals and labels
// Evals are always from the view of the side to move in the FEN given. --nodes N overrides the search size.
import { parseArgs } from 'node:util';
import { makeSquare, parseSquare } from './extension/vendor/chessops.js';
import {
  endNotes, fenOf, imbalances, lineWithEvals, nodeEngines, opponentThreat, play, position, positionBefore, pov, san,
  sanToUci, scoreStr, search, trapped,
} from './extension/explain.js';

const { values: o, positionals: [cmd, fen, ...rest] } = parseArgs({
  allowPositionals: true, options: { nodes: { type: 'string', default: '200000' } },
});
const nodes = Number(o.nodes);
const root = position(fen);
const you = root.turn;
const after = sans => sanToUci(fen, sans).reduce(play, root);
const sanLine = (pos, pv) => pv.map(uci => { const s = `${pos.fullmoves}${pos.turn === 'white' ? '.' : '...'}${san(pos, uci)}`; pos = play(pos, uci); return s; });
const sideName = c => (c === you ? 'you' : 'opp');

const engines = await nodeEngines();
const { sf } = engines;
try {
  let out;
  switch (cmd) {
    case 'eval': {
      const pos = after(rest);
      const { score, pv } = (await search(sf, pos, nodes))[0];
      out = {
        after: rest.join(' ') || '(no moves)', side_to_move: sideName(pos.turn), eval: scoreStr(pov(score, pos, you)),
        pv: sanLine(pos, pv.slice(0, 10)).join(' '),
        line_with_evals: await lineWithEvals(sf, pos, pv, nodes, 10, you),
      };
      break;
    }
    case 'best': {
      const n = Number(rest[0] ?? 3);
      const infos = await search(sf, root, nodes, { multipv: n });
      // a line the last iteration did not report keeps its older rank: drop a move already listed above it
      out = infos.filter((x, i) => infos.findIndex(y => y.pv[0] === x.pv[0]) === i)
        .map(({ score, pv }) => ({ move: san(root, pv[0]), eval: scoreStr(score), pv: sanLine(root, pv.slice(0, 6)).join(' ') }));
      break;
    }
    case 'threat': {
      const { score } = (await search(sf, root, nodes))[0];
      const [uci, facts] = await opponentThreat(sf, root, nodes, score, -Infinity);
      out = !uci ? { threat: null, note: 'in check, or no legal null move' } : {
        eval_now: scoreStr(score), threat: facts.move, eval_if_you_pass_and_opp_plays_it: facts.eval_if_you_could_pass_and_opp_played_it,
      };
      break;
    }
    case 'square': {
      const sq = parseSquare(rest[0]);
      const who = c => [...root.kingAttackers(sq, c, root.board.occupied)].map(s => `${root.board.getRole(s)} on ${makeSquare(s)}`);
      const p = root.board.get(sq);
      out = {
        square: rest[0], piece: p ? `${sideName(p.color)} ${p.role}` : 'empty',
        your_pieces_hitting_it: who(you), opp_pieces_hitting_it: who(you === 'white' ? 'black' : 'white'),
      };
      break;
    }
    case 'labels':
      out = {
        ...positionBefore(root), imbalances: imbalances(root), end_notes: endNotes(root, you),
        your_trapped_pieces: trapped(root).map(s => `${root.board.getRole(s)} on ${makeSquare(s)}`),
      };
      break;
    case 'line':
      out = { line: await lineWithEvals(sf, root, sanToUci(fen, rest), nodes, 40, you) };
      break;
    default:
      throw new Error(`unknown command ${cmd}`);
  }
  console.log(JSON.stringify({ evals_from: `${sideName(you)} (${you}, side to move in the given FEN)`, ...Array.isArray(out) ? { moves: out } : out }, null, 1));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
} finally {
  engines.quit();
}
