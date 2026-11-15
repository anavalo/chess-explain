// The command line: explains a move or finds a plan without the extension. Node only: the engines are child processes.
//   node src/cli.ts FEN MOVE [--vs MOVE] [--nodes N] [--no-llm] [--model ID] [--deep]
// --deep runs the deeper read before the answer, as the panel's positional depth switch does.
//   node src/cli.ts FEN --plan [--no-llm] [--model ID]
// --plan finds a plan for the side to move instead, as the panel's Find plan button does (--no-llm: the plan sheet only).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NODES, factSheet, llmWith, planFacts, startEngines, uciEngine } from './explain.ts';
import { answer, planAnswer } from './request.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Engine, Engines } from './explain.ts';

/** nodeEngines(): the engines as child processes, and `quit` to end them. */
export interface NodeEngines extends Engines<Engine> { quit: () => void }

/** The WASM engines as child processes. Returns {sf, sf2, sf15, quit}. */
export async function nodeEngines(): Promise<NodeEngines> {
  const procs: ChildProcessWithoutNullStreams[] = [];
  const start = (path: string): Engine => {
    // the SF 15 build's old emscripten loader breaks on node's fetch
    const p = spawn(process.execPath, ['--import', 'data:text/javascript,delete globalThis.fetch', fileURLToPath(new URL('../extension/' + path, import.meta.url))]);
    procs.push(p);
    const e = uciEngine(l => p.stdin.write(l + '\n'));
    createInterface({ input: p.stdout }).on('line', e.onLine);
    return e;
  };
  return { ...await startEngines(start), quit: () => procs.forEach(p => p.stdin.end('quit\n')) };
}

// eval.ts and test.ts import nodeEngines from this file: only a direct run starts the command line.
if (import.meta.main) cli(); // node 24.2+
async function cli() {
  const { values: o, positionals: [fen, move] } = parseArgs({
    allowPositionals: true,
    options: { vs: { type: 'string' }, nodes: { type: 'string', default: String(NODES) },
      'no-llm': { type: 'boolean' }, model: { type: 'string' }, deep: { type: 'boolean' }, plan: { type: 'boolean' } },
  });
  if (o.deep && o['no-llm']) throw new Error('--deep needs the LLM');
  const engines = await nodeEngines();
  const llm = llmWith(process.env.ANTHROPIC_API_KEY!); // unset with --no-llm, where llm is never called
  try {
    const nodes = Number(o.nodes);
    if (o['no-llm']) console.log(JSON.stringify(await (o.plan ? planFacts(engines, fen, nodes) : factSheet(engines, fen, move, o.vs, nodes)), null, 1));
    else {
      const { facts, text } = o.plan ? await planAnswer(await planFacts(engines, fen, nodes), llm, { model: o.model })
        : await answer(await factSheet(engines, fen, move, o.vs, nodes), llm, { model: o.model, depth: o.deep });
      console.log(JSON.stringify(facts, null, 1));
      console.log('\n' + text);
    }
  } finally {
    engines.quit();
  }
}
