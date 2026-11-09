// Explains the positions in eval-sets/quiet-132.json: 132 quiet positions from lichess games, where the better move wins on
// position, not with a tactic. From the 31st on: rapid games, average rating 2700-2800, 2026-10-12..15, where the played
// move loses 0.5-1.6 pawns to the engine's best (at least 0.3 at the eval's 2M nodes), and the first 3 plies of both
// lines hold no capture or check.
// The engines give the same lines on every run, so run this before and after a change and diff the two folders.
// usage: ANTHROPIC_API_KEY=... node eval.js [out-dir] [--no-llm] [--model ID] [--deep] [--facts DIR] [--set FILE] [--summary] [--judge]   (out-dir defaults to eval-out)
// out-dir/summary.txt flags format slips in each answer; node eval.js out-dir --summary re-checks without a run.
// --facts DIR reuses DIR's fact sheets (no engines), so only the LLM runs, 16 at a time.
// --judge has Claude Opus grade each answer against its fact sheet (a few cents per answer, kept in <name>.judge.json).
// --set FILE runs a JSON list of {id, fen, played, better, reference_reason?} instead of quiet-132; with a reference_reason the
// judge also says whether the answer gives that reference reason.
// --pair DIR has Opus compare each answer in out-dir (A) with the same position's answer in DIR (B) and say which is better;
// a pairwise pick is steadier than two separate grades. Kept in <name>.pair-<DIR name>.json; picks are always in out-dir/DIR terms.
// --sample N --month YYYY-MM draws N fresh positions from that month's lichess database into eval-sets/holdout-YYYY-MM.json
// (gitignored, run it with --set). Never tune on them: a new month per release.
// --print explainer|judge|pair prints that prompt and exits (judge and pair: with the verdict schema, the reference
// variant with --set), for subagent runs that write <name>.txt and <name>.judge.json without the API.
// --compare DIR pairs out-dir's judge verdicts with DIR's by position (A = DIR, B = out-dir) and prints the flips with
// their noise, overall and by the SF 15 gate; run it on two samples of the same arm first to see the noise floor.
// --deep runs the deeper read before each answer (as the panel's positional depth switch does), and gives the judge, the
// pairwise judge and --print the "verified_concepts" legend entry; to compare a deep run with a plain one, judge both with --deep.
// --plan builds Find plan's plan sheets (with --no-llm) for each position's FEN instead, and --print planner|plan prints
// the planner and plan-writer prompts, for subagent runs; the summary checks plans at 200 words. A plan sheet in
// --facts DIR gets its plan (the planner, then the plan writer), not an explanation.
// --masked writes <name>.masked.txt per answer, with the two candidate moves hidden, for a reader (a Haiku subagent) to say
// which move the text argues for in <name>.masked.json ({"better": "<SAN>"}); the summary counts how many it recovers.
import { PgnParser, parseComment, startingPosition } from 'chessops/pgn';
import { makeFen } from 'chessops/fen';
import { parseSan } from 'chessops/san';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { NODES, aboutEqual, answer, linePlies, llmWith, nodeEngines, planAnswer, play, position, san, sanToUci, search } from './extension/explain.js';
import { JUDGE, PAIR, PLANNER, PLAN_SYSTEM, checkAnswer, systemFor, withConceptsEntry } from './extension/prompt.js';

// ---- the judge (its prompts are in extension/prompt.js) ----

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
    cause: { type: 'string', enum: ['labelled', 'line', 'term', 'none'] },
    played_fault_quote: { type: 'string' },
    better_gain_quote: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['decisive_point', 'false_claims', 'invented_term_cause', 'cause', 'played_fault_quote', 'better_gain_quote', 'note'],
  additionalProperties: false,
};
const WITH_REFERENCE = {
  ...VERDICT,
  properties: { ...VERDICT.properties, reference_reason: { type: 'string', enum: ['yes', 'partly', 'no'] } },
  required: [...VERDICT.required, 'reference_reason'],
};

const pick = { type: 'string', enum: ['A', 'B', 'tie'] }, quote = { type: 'string' };
const PAIR_VERDICT = {
  type: 'object',
  properties: { decisive_quote_a: quote, decisive_quote_b: quote, decisive_point: pick, fewer_false_claims: pick, note: quote },
  required: ['decisive_quote_a', 'decisive_quote_b', 'decisive_point', 'fewer_false_claims', 'note'],
  additionalProperties: false,
};
const PAIR_WITH_REFERENCE = {
  ...PAIR_VERDICT,
  properties: { ...PAIR_VERDICT.properties, reference_quote_a: quote, reference_quote_b: quote, reference_reason: pick },
  required: [...PAIR_VERDICT.required, 'reference_quote_a', 'reference_quote_b', 'reference_reason'],
};

const str = { type: 'string' }, bool = { type: 'boolean' };
const { values: o, positionals: [out = 'eval-out'] } = parseArgs({
  allowPositionals: true,
  options: { 'no-llm': bool, model: str, facts: str, set: str, summary: bool, judge: bool, pair: str, sample: str, month: str,
    print: str, masked: bool, compare: str, deep: bool, plan: bool },
});
if (o.deep && o['no-llm']) throw new Error('--deep needs the LLM');
// the judges get the "verified_concepts" legend entry on --deep runs
const legend = prompt => (o.deep ? withConceptsEntry(prompt) : prompt);
if (o.sample) {
  await sample(Number(o.sample), o.month);
  process.exit(0);
}
const set = JSON.parse(readFileSync(o.set ?? fileURLToPath(new URL('eval-sets/quiet-132.json', import.meta.url)), 'utf8'));
const reference = Object.fromEntries(set.map(p => [p.id, p.reference_reason]));
if (o.print) {
  // the exact prompts, for subagent runs on the subscription: the explainer prompt, or a judge prompt with
  // the JSON its verdict must match (the reference variant when --set gives reference reasons)
  const ref = Object.values(reference).some(Boolean);
  const withSchema = (prompt, schema) => `${prompt}\n\nReply with only JSON matching this schema:\n${JSON.stringify(schema, null, 1)}`;
  const prompts = {
    explainer: () => systemFor(o.deep),
    judge: () => withSchema(legend(JUDGE), ref ? WITH_REFERENCE : VERDICT),
    pair: () => withSchema(legend(PAIR), ref ? PAIR_WITH_REFERENCE : PAIR_VERDICT),
    planner: () => PLANNER,
    plan: () => PLAN_SYSTEM,
  };
  if (!prompts[o.print]) throw new Error('--print takes explainer, judge, pair, planner or plan');
  process.stdout.write(prompts[o.print]());
  process.exit(0);
}
if (o.compare) {
  compare(o.compare.replace(/\/$/, ''));
  process.exit(0);
}
const facts = o.facts ?? null;
const pair = o.pair?.replace(/\/$/, '') ?? null;
const flags = [...o['no-llm'] ? ['--no-llm'] : [], ...o.model ? ['--model', o.model] : [], ...o.deep ? ['--deep'] : [], ...o.plan ? ['--plan'] : []];
const cli = fileURLToPath(new URL('extension/explain.js', import.meta.url));
const run = promisify(execFile);
mkdirSync(out, { recursive: true });

// each position runs in its own process (fresh engines), four at a time; --summary only re-checks out-dir
const queue = o.summary || pair ? [] : [...set];
await Promise.all(Array.from({ length: facts ? 16 : 4 }, async () => {
  for (let p; (p = queue.shift());) {
    const { id: name, fen, played, better } = p;
    let text;
    try {
      if (facts) {
        const s = JSON.parse(readRun(facts, name)?.sheet);
        const llm = llmWith(process.env.ANTHROPIC_API_KEY);
        // a plan sheet (it has "best") gets its plan, not an explanation
        const a = await (s.best ? planAnswer(s, llm, { model: o.model }) : answer(s, llm, { model: o.model, depth: o.deep }));
        text = `${JSON.stringify(a.facts, null, 1)}\n\n${a.text}\n`;
      } else text = (await run(process.execPath, [cli, fen, ...o.plan ? [] : [played, '--vs', better], ...flags], { maxBuffer: 1 << 24 })).stdout;
    } catch (e) {
      text = `ERROR: ${e.stderr || e.message}`;
    }
    writeFileSync(`${out}/${name}.txt`, text);
    console.log(name, text.startsWith('ERROR') ? 'failed' : 'ok');
  }
}));
const answers = readdirSync(out).filter(f => f.endsWith('.txt') && f !== 'summary.txt' && !f.endsWith('.masked.txt')).sort().map(f => f.slice(0, -4));
// the panel answers these with a plain verdict and no LLM, so there is nothing to grade; an older run may still hold
// an LLM answer and verdicts for them, which are left out of every count so runs before and after compare
const equal = new Set(answers.filter(n => { const r = readRun(out, n); return r && aboutEqual(JSON.parse(r.sheet)); }));
const explained = answers.filter(n => !equal.has(n));
if (pair) await pairAll(explained.filter(n => existsSync(`${pair}/${n}.txt`)));
if (o.judge) await judgeAll(explained.filter(n => !existsSync(`${out}/${n}.judge.json`)));
if (o.masked) for (const n of explained) mask(n);
const verdicts = [], recovered = [];
let pastCount = 0;
const report = explained.map(n => {
  const r = readRun(out, n);
  const found = r ? problems(r) : ['failed'];
  const past = r?.answer ? pastLeaf(r) : [];
  if (past.length) { pastCount++; found.push(`past leaf: ${past.join(' ')}`); }
  if (existsSync(`${out}/${n}.judge.json`)) {
    const v = JSON.parse(readFileSync(`${out}/${n}.judge.json`, 'utf8'));
    verdicts.push(v);
    if (v.decisive_point !== 'yes') found.push(`judge: decisive point ${v.decisive_point}`);
    for (const c of v.false_claims) found.push(`judge: false claim "${c.claim}" (${c.facts})`);
    if (v.invented_term_cause) found.push('judge: invented term cause');
    if (v.reference_reason && v.reference_reason !== 'yes') found.push(`judge: reference reason ${v.reference_reason}`);
  }
  if (existsSync(`${out}/${n}.masked.json`)) {
    const ok = JSON.parse(readFileSync(`${out}/${n}.masked.json`, 'utf8')).better === JSON.parse(r.sheet).alternative.move;
    recovered.push(ok);
    if (!ok) found.push('masked: better move not recovered');
  }
  return `${n} ${found.join(', ') || 'ok'}`;
});
writeFileSync(`${out}/summary.txt`, [...report, ...[...equal].map(n => `${n} about equal, no LLM`)].sort().join('\n') + '\n');
console.log(`\n${answers.length} positions, ${equal.size} about equal (no LLM), ${report.filter(r => !r.endsWith(' ok')).length} `
  + `of the other ${report.length} flagged (see ${out}/summary.txt)`);
const words = explained.map(n => (readRun(out, n)?.answer ?? '').split(/\s+/).filter(Boolean).length)
  .filter(Boolean).sort((x, y) => x - y);
console.log(`answers quoting moves past the leaf: ${pastCount}`);
if (words.length) console.log(`median ${words[words.length >> 1]} words, ${words.filter(w => w > 120).length} over 120`);
if (verdicts.length) {
  const count = f => verdicts.filter(f).length;
  console.log(`judged ${verdicts.length}: decisive point yes ${count(v => v.decisive_point === 'yes')}, `
    + `partly ${count(v => v.decisive_point === 'partly')}, no ${count(v => v.decisive_point === 'no')}; `
    + `false claims in ${count(v => v.false_claims.length)} (${verdicts.reduce((n, v) => n + v.false_claims.length, 0)} total); `
    + `invented term causes in ${count(v => v.invented_term_cause)}`
    + (verdicts.some(v => v.cause) ? `; cause ${['labelled', 'line', 'term', 'none'].map(c => `${c} ${count(v => v.cause === c)}`).join(', ')}` : '')
    + (verdicts.some(v => v.reference_reason) ? `; reference reason yes ${count(v => v.reference_reason === 'yes')}, `
      + `partly ${count(v => v.reference_reason === 'partly')}, no ${count(v => v.reference_reason === 'no')}` : ''));
}
if (recovered.length) console.log(`masked: better move recovered from the text in ${recovered.filter(Boolean).length} of ${recovered.length}`);

/** Judges each named answer in out-dir, four at a time, and writes <name>.judge.json next to it. */
async function judgeAll(names) {
  // API-bound, not CPU-bound: more in flight than the engine runs
  await Promise.all(Array.from({ length: 16 }, async () => {
    for (let n; (n = names.shift());) {
      const r = readRun(out, n);
      if (!r?.answer) continue; // nothing to judge
      try {
        const v = await judge(r.sheet, r.answer, reference[n]);
        writeFileSync(`${out}/${n}.judge.json`, JSON.stringify(v, null, 1) + '\n');
        console.log(n, 'judged');
      } catch (e) {
        console.log(n, `judge failed: ${e.message}`);
      }
    }
  }));
}

function judge(facts, answer, ref) {
  return claude(legend(JUDGE), `Fact sheet:\n${facts}\n\nAnswer:\n${answer}${ref ? `\n\nReference reason:\n${ref}` : ''}`, ref ? WITH_REFERENCE : VERDICT);
}

/** One Opus call with a cached system prompt and a JSON schema; returns the parsed JSON plus usage. */
async function claude(system, content, schema) {
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
      output_config: { effort: 'high', format: { type: 'json_schema', schema } },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`Anthropic API error ${r.status}: ${body.error?.message ?? r.statusText}`);
  if (body.stop_reason !== 'end_turn') throw new Error(`stopped: ${body.stop_reason}`);
  return { ...JSON.parse(body.content.find(b => b.type === 'text').text), usage: body.usage };
}

/** Compares each named answer in out-dir with the one in the --pair folder, prints the tally and the judge's cost. */
async function pairAll(names) {
  const file = n => `${out}/${n}.pair-${basename(pair)}.json`;
  const todo = names.filter(n => !existsSync(file(n)));
  await Promise.all(Array.from({ length: 16 }, async () => {
    for (let n; (n = todo.shift());) {
      const [a, b] = [out, pair].map(d => readRun(d, n));
      if (!a?.answer || !b?.answer) continue;
      // half the positions show B first, so the judge's lean toward the second answer cancels out in the totals
      const swap = [...n].reduce((h, c) => h + c.charCodeAt(0), 0) % 2 === 1;
      const [{ sheet: sheetA, answer: answerA }, { sheet: sheetB, answer: answerB }] = swap ? [b, a] : [a, b];
      const sheets = sheetA === sheetB ? `Fact sheet (both answers):\n${sheetA}` : `Fact sheet A:\n${sheetA}\n\nFact sheet B:\n${sheetB}`;
      const ref = reference[n] ? `\n\nReference reason:\n${reference[n]}` : '';
      try {
        const v = await claude(legend(PAIR), `${sheets}\n\nAnswer A:\n${answerA}\n\nAnswer B:\n${answerB}${ref}`, ref ? PAIR_WITH_REFERENCE : PAIR_VERDICT);
        if (swap) for (const k of ['decisive_point', 'fewer_false_claims', 'reference_reason']) v[k] = { A: 'B', B: 'A' }[v[k]] ?? v[k];
        writeFileSync(file(n), JSON.stringify({ ...v, swap }, null, 1) + '\n');
        console.log(n, 'compared');
      } catch (e) {
        console.log(n, `compare failed: ${e.message}`);
      }
    }
  }));
  const vs = names.filter(n => existsSync(file(n))).map(n => JSON.parse(readFileSync(file(n), 'utf8')));
  const tally = k => ['A', 'B', 'tie'].map(w => `${w} ${vs.filter(v => v[k] === w).length}`).join(' / ');
  const usd = vs.reduce((s, { usage: u }) => s + (u.input_tokens * 4 + u.output_tokens * 20
    + (u.cache_read_input_tokens ?? 0) * 0.2 + (u.cache_creation_input_tokens ?? 0) * 5) / 1e6, 0);
  console.log(`\n${vs.length} pairs, A = ${out}, B = ${pair}: decisive point ${tally('decisive_point')}`
    + (vs.some(v => v.reference_reason) ? `; reference reason ${tally('reference_reason')}` : '')
    + `; false claims ${tally('fewer_false_claims')} (fewer); about $${usd.toFixed(2)}`);
}

/** Pairs out-dir's judge verdicts (B) with DIR's (A) by position and prints the flips, overall and split by the SF 15
    gate (the terms carry at least half the gap). Noise is 2*sqrt(discordant): a net inside it is a coin toss. */
function compare(dir) {
  const verdict = (d, n) => existsSync(`${d}/${n}.judge.json`) ? JSON.parse(readFileSync(`${d}/${n}.judge.json`, 'utf8')) : null;
  const names = readdirSync(out).filter(f => f.endsWith('.judge.json')).map(f => f.slice(0, -11)).filter(n => verdict(dir, n));
  const gate = n => { const s = JSON.parse(readRun(out, n).sheet); return s.sf15_total_gap != null && s.sf15_total_gap >= s.latest_sf_gap / 2; };
  const flips = (ns, hit) => {
    const pairs = ns.map(n => [hit(verdict(dir, n)), hit(verdict(out, n))]);
    const lost = pairs.filter(([a, b]) => a && !b).length, won = pairs.filter(([a, b]) => !a && b).length;
    return `${pairs.filter(([a]) => a).length} -> ${pairs.filter(([, b]) => b).length}, agree ${pairs.length - lost - won}, `
      + `lost ${lost}, won ${won}, net ${won - lost >= 0 ? '+' : ''}${won - lost}, noise ±${(2 * Math.sqrt(lost + won)).toFixed(1)}`;
  };
  const claims = d => names.reduce((s, n) => s + verdict(d, n).false_claims.length, 0);
  console.log(`${names.length} positions, A = ${dir}, B = ${out}; false claims ${claims(dir)} -> ${claims(out)} total`);
  const causes = d => names.map(n => verdict(d, n).cause).filter(Boolean);
  if (causes(dir).length && causes(out).length) {
    const moved = {};
    for (const n of names) { const k = `${verdict(dir, n).cause}->${verdict(out, n).cause}`; moved[k] = (moved[k] ?? 0) + 1; }
    console.log(`cause A->B: ${Object.entries(moved).sort(([, x], [, y]) => y - x).map(([k, c]) => `${k} ${c}`).join(', ')}`);
  }
  for (const [label, ns] of [['all', names], ['gate pass', names.filter(gate)], ['gate fail', names.filter(n => !gate(n))]]) {
    console.log(`${label} (${ns.length}): decisive yes ${flips(ns, v => v.decisive_point === 'yes')}`);
    console.log(`${' '.repeat(label.length + String(ns.length).length + 3)}  no false claim ${flips(ns, v => !v.false_claims.length)}`);
  }
}

/** Reads <dir>/<name>.txt, the CLI output: the fact sheet JSON, a blank line and the answer (no answer with --no-llm).
    Null for a run that failed. */
function readRun(dir, name) {
  const text = readFileSync(`${dir}/${name}.txt`, 'utf8'), cut = text.indexOf('\n\n');
  if (text.startsWith('ERROR')) return null;
  return cut < 0 ? { sheet: text, answer: null } : { sheet: text.slice(0, cut), answer: text.slice(cut + 2) };
}

/** Moves the answer quotes from past "explained_at_position_after" in either line: SANs that show up nowhere else on the
    sheet (not before the leaf, not in a side line), so a hit means the answer leans on the deep, unlabelled part of a line. */
function pastLeaf({ sheet, answer }) {
  const s = JSON.parse(sheet);
  let rest = sheet;
  const deep = new Set();
  for (const side of [s.played, s.alternative, s.best].filter(Boolean)) {
    const cut = side.explained_at_position_after.split(' ').filter(t => !/^\d+\.+$/.test(t)).length;
    const plies = linePlies(side.line_with_evals).flat(); // all rows: a leaf at the main row's end still cuts the "Why" rows
    if (plies.length <= cut) continue;
    const tail = side.line_with_evals.slice(plies[cut].at); // the main row from the leaf on, and the "Why" rows after it
    rest = rest.replace(JSON.stringify(tail).slice(1, -1), '');
    for (const p of linePlies(tail).flat()) deep.add(p.san.replace(/[+#]$/, ''));
  }
  const esc = m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...deep].filter(m => !new RegExp(`(?<![A-Za-z0-9])${esc(m)}(?![A-Za-z0-9])`).test(rest)
    && new RegExp(`(?<![A-Za-z0-9])${esc(m)}(?![A-Za-z0-9])`).test(answer));
}

/** The rule checks on one run's answer. */
function problems({ sheet, answer }) {
  const s = JSON.parse(sheet);
  return answer ? checkAnswer(answer, s, { maxWords: s.best ? 200 : 120 }).map(c => c.problem) : [];
}

/** Writes <name>.masked.txt: the answer with the better move written "[better move]" and the played one "[played move]",
    so a reader who names the better move from the position got it from what the text says about each (Parfenova 2026). */
function mask(n) {
  const r = readRun(out, n);
  if (!r?.answer) return;
  const sheet = JSON.parse(r.sheet);
  if (!sheet.alternative) return; // a plan sheet has no two moves to hide
  let { answer } = r;
  for (const [move, tag] of [[sheet.alternative.move, '[better move]'], [sheet.played.move, '[played move]']]) {
    const esc = move.replace(/[+#]$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    answer = answer.replace(new RegExp(`(?<![A-Za-z0-9])${esc}[+#]?(?![A-Za-z0-9])`, 'g'), tag);
  }
  writeFileSync(`${out}/${n}.masked.txt`, `Position (FEN): ${sheet.fen}, ${sheet.side_to_move} to move.
Candidate moves: ${[sheet.alternative.move, sheet.played.move].sort().join(', ')}
The explanation below argues that one candidate is better than the other. Both are hidden: the one it calls better is
written "[better move]", the other "[played move]".

${answer}`);
}

/** Draws `n` positions from the lichess database for `month` (https://database.lichess.org, streamed: only the start of the
    file is read). Games: rapid or classical, both players 1600-2200, with lichess's evals; one random position per game,
    from move 10 on (as in the 132 set), where the move played lost 0.5-1.6 pawns by those evals with |eval| <= 2.5 before
    it. Kept when Stockfish 19 at the panel's node count rates its best move 0.3-2 pawns better and the first 3 plies of
    both lines are quiet (no capture, check or promotion). The screen of the 132 set, on games nobody picked. */
async function sample(n, month) {
  if (!(n > 0) || !/^\d{4}-\d\d$/.test(month ?? '')) throw new Error('usage: --sample N --month YYYY-MM');
  const res = await fetch(`https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst`);
  if (!res.ok) throw new Error(`lichess database ${month}: HTTP ${res.status}`);
  const candidates = [], kept = [];
  const parser = new PgnParser(game => {
    const h = game.headers, elo = ['WhiteElo', 'BlackElo'].map(k => Number(h.get(k)));
    if (!/Rated (Rapid|Classical) game/.test(h.get('Event')) || elo.some(e => !(e >= 1600 && e <= 2200))) return;
    const pos = startingPosition(h).unwrap(), id = h.get('Site')?.split('/').pop(), here = [];
    let before = null; // lichess's eval before the move, White's view
    for (const node of game.moves.mainlineNodes()) {
      const mv = parseSan(pos, node.data.san);
      if (!mv) break;
      const ev = (node.data.comments ?? []).map(c => parseComment(c).evaluation).find(Boolean);
      const after = ev && 'pawns' in ev ? ev.pawns : null;
      const drop = (before - after) * (pos.turn === 'white' ? 1 : -1);
      if (pos.fullmoves >= 10 && before !== null && after !== null && Math.abs(before) <= 2.5 && drop >= 0.5 && drop <= 1.6)
        here.push({ id: `${id}-${pos.fullmoves}${pos.turn[0]}`, fen: makeFen(pos.toSetup()), played: node.data.san });
      pos.play(mv);
      before = after;
    }
    if (here.length) candidates.push(here[Math.floor(Math.random() * here.length)]);
  });
  const engines = await nodeEngines();
  let screened = 0;
  try {
    // the zstd CLI: node's zlib rejects the skippable frames pzstd writes before every frame
    const zstd = spawn('zstd', ['-dcq']).on('error', e => { throw new Error(`zstd CLI needed for --sample (${e.message})`); });
    Readable.fromWeb(res.body).pipe(zstd.stdin).on('error', () => {}); // EPIPE once we stop reading
    for await (const chunk of zstd.stdout.setEncoding('utf8')) {
      parser.parse(chunk, { stream: true });
      for (let c; kept.length < n && (c = candidates.shift());) {
        const pos = position(c.fen), uci = sanToUci(c.fen, [c.played])[0];
        const [[best], [mine]] = await Promise.all([search(engines.sf, pos, NODES), search(engines.sf2, pos, NODES, { moves: [uci] })]);
        screened++;
        if (!best.pv.length || best.pv[0] === uci || 'mate' in best.score || 'mate' in mine.score) continue;
        const gap = (best.score.cp - mine.score.cp) / 100;
        const quiet = pv => { let b = pos; return pv.slice(0, 3).every(m => { const ok = !/[x+#=]/.test(san(b, m)); b = play(b, m); return ok; }); };
        if (gap < 0.3 || gap > 2 || !quiet(best.pv) || !quiet(mine.pv)) continue;
        kept.push({ ...c, better: san(pos, best.pv[0]), gap });
        console.log(`${kept.length}/${n} ${c.id} ${c.played} vs ${kept.at(-1).better} (${gap.toFixed(2)}), ${screened} screened`);
      }
      if (kept.length >= n) { zstd.kill(); break; }
    }
  } finally {
    engines.quit();
  }
  mkdirSync('eval-sets', { recursive: true });
  writeFileSync(`eval-sets/holdout-${month}.json`, JSON.stringify(kept, null, 1) + '\n');
  console.log(`eval-sets/holdout-${month}.json: ${kept.length} positions from ${screened} screened`);
}
