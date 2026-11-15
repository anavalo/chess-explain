// From a sheet to what the user gets, and the panel's requests around it.
//
// answer() and planAnswer() turn a fact sheet or a plan sheet into the answer or the plan (the eval and the CLI start
// there). explainMove() and findPlan() are the two tasks: the engines and a position in, the answer or the plan and the
// result the panel shows out. panelRequests() is the one door for the panel's requests: fair play first, then the saved
// answers, the engines, the task and the reasons kept for later moves.

import { DECLINED, NODES, aboutEqual, factSheet, moveNo, planFacts, position, san, sanToUci } from './explain.js';
import { closed } from './closing.js';
import { planShapes, withConcepts, withPlan } from './concepts.js';
import { MODEL, PLAN_SYSTEM, stepModels, systemFor } from './prompt.js';

const ANSWERS = 200; // saved answers kept (see savedAnswers), oldest dropped first
const SHEETS = 20; // fact sheets a panel keeps (see sheetCache), oldest dropped first
const GAMES = 50, REASONS = 4; // games whose reasons are kept (see gameReasons), oldest dropped first, and moves per game

/** The fair-play check: fail closed unless lichess confirms `user` is not in a game. Every request passes it before
    anything else (see panelRequests), and so does each sheet built ahead (see sheetCache). */
async function checkNotPlaying(user) {
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(user ?? '')) throw new Error('Log in to lichess so I can check you are not playing a game.');
  let status;
  try {
    const r = await fetch(`https://lichess.org/api/users/status?ids=${encodeURIComponent(user)}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    status = await r.json();
  } catch (e) {
    throw new Error(`Could not verify you are not in a game (${e.message}).`);
  }
  if (!status.length) throw new Error(`Unknown lichess user ${user}.`);
  if (status.some(s => s.playing)) throw new Error('You are playing a game on lichess. No engine help during games.');
}

/** The fact sheets one panel has built, by `fen | move`, as promises, at most SHEETS: the requests' and the next
    moves' built ahead. One engine job at a time.
    - get(engines, fen, move, best): factSheet()'s sheet. A kept one serves when `best` is unset or is its alternative
      (a sheet built ahead has best = null: the engine's best other move); one still being built is waited for. Else
      the builds ahead stop and, once the engines are idle, the sheet is built and kept in the old one's place. A
      failed or stopped build never serves.
    - prepare(engines, user, ahead): builds the sheets for `ahead` ([{fen, next}]) one at a time, each once lichess
      confirms `user` is not in a game (fail closed: a refusal or an error ends it). Sheets only, never an LLM call.
    - plan(engines, fen): planFacts()'s plan sheet. The builds ahead stop and, once the engines are idle, it is built:
      its searches wait their turn like a fact sheet's. Never kept.
    - stop(): stops the builds ahead; resolves once the engines are idle. */
export function sheetCache() {
  const sheets = new Map();
  let ctl = new AbortController(), idle = Promise.resolve();
  const keep = (key, p) => {
    sheets.delete(key);
    sheets.set(key, p);
    if (sheets.size > SHEETS) sheets.delete(sheets.keys().next().value);
    p.catch(() => sheets.get(key) === p && sheets.delete(key));
    return p;
  };
  const after = job => { const p = idle.then(job); idle = p.then(() => {}, () => {}); return p; };
  const stop = () => (ctl.abort(), idle);
  return {
    async get(engines, fen, move, best = null) {
      const key = `${fen} | ${move}`, sheet = await sheets.get(key)?.catch(() => null);
      if (sheet && (!best || sanToUci(fen, [best])[0] === sanToUci(fen, [sheet.alternative.move])[0])) return sheet;
      ctl.abort();
      return keep(key, after(() => factSheet(engines, fen, move, best)));
    },
    async prepare(engines, user, ahead) {
      ctl.abort();
      const { signal } = ctl = new AbortController();
      await idle; // the builds just stopped leave the Map first, so a key this list still wants is built again
      try {
        for (const { fen, next } of ahead) {
          const key = `${fen} | ${next}`;
          if (sheets.has(key)) continue;
          await checkNotPlaying(user);
          if (signal.aborted) return;
          await keep(key, after(() => factSheet(engines, fen, next, null, NODES, { signal })));
        }
      } catch {} // a refusal, an error or a stop: nothing more is built ahead
    },
    plan(engines, fen) {
      ctl.abort();
      return after(() => planFacts(engines, fen));
    },
    stop,
  };
}

/** The answer for a fact sheet: a plain verdict when the moves are about equal (no LLM call), else the explainer's text,
    after a deeper read when `depth` is on. `llm(system, facts, model, onText)` is one LLM call: ask() with the key, or a
    test stub. `model` is a pick (see stepModels): its ideas model makes the deeper read, its writer the text. `onStep(words)` hears which call comes next; `onText` streams the explainer's text (see ask). `recent`:
    reasons given for earlier moves of the line (see gameReasons); when there are any, the explainer's facts (never the
    proposer's) end with them as "recent_reasons". The text comes with its closing line (closed() in closing.js): the
    ideas model picks a rule line beside the writer. Returns {text, facts, concepts, read}: facts as the explainer saw them;
    concepts, the verified concepts (null when none held); read, whether the proposer's reply held a claim list
    (undefined when no deeper read ran). */
export async function answer(facts, llm, { model = MODEL, depth = false, recent = null, onStep = () => {}, onText } = {}) {
  if (aboutEqual(facts)) {
    return { facts, concepts: null, text: `**${facts.played.move}** is about as good as **${facts.alternative.move}**: `
      + 'the engine sees no real difference between them. Either move is fine.' };
  }
  const { ideas, writer } = stepModels(model);
  let concepts = null, read;
  if (depth) {
    onStep('Looking for positional ideas');
    ({ facts, concepts, read } = await withConcepts(facts, llm, ideas));
  }
  const sheet = facts; // the picker's, like the proposer's: no recent reasons
  if (recent?.length) facts = { ...facts, recent_reasons: recent };
  onStep('Asking Claude');
  const system = systemFor(!!facts.verified_concepts, !!facts.recent_reasons);
  const text = await closed(hear => llm(system, facts, writer, hear), sheet, llm, ideas, onText);
  return { text, facts, concepts, read };
}

/** A task's result is what the panel shows for it, in the words the user reads: {head, rows, text, lines, note, shapes,
    equal}.
    head: {label, pill} over the rows, or null. rows: [{kind: best|compared, label, move, eval}]. text: the answer or
    the plan (markdown). lines: the sheet lines a move link in the text may play, each from the request's position.
    note: a sentence under the text, or null. shapes: for the lichess board, or null. equal: true on Explain's
    about-equal verdict, where the panel offers Find plan for the position. */
const row = (kind, label, line) => ({ kind, label, move: line.move, eval: line.latest_sf_eval });
const explainRows = ({ played, alternative }) => [row('best', 'engine move', alternative), row('compared', 'compared', played)];
// every line that starts at the explained position (prepares.follow_up_fails starts mid-line, so it is left out)
const explainLines = ({ played, alternative, prepares }) => [alternative, played]
  .flatMap(l => [l.line_with_evals, l.if_opp_plays_the_threat_at_once]).concat(prepares?.line_if_played_at_once).filter(Boolean);

/** The Explain task. {fen, move, best} -> answer()'s {text, facts, concepts, read} plus its result. move: the move to
    compare against (SAN or UCI), best: lichess's top move (UCI, optional). The sheet comes from `sheet(engines, fen,
    move, best)`: factSheet(), or a sheetCache's get. `onSheet(rows, lines)` hears the result's rows and lines once the
    sheet is built, before any LLM call; `llm` and the other `opts` go to answer(). */
export async function explainMove(engines, req, llm, { onSheet = () => {}, sheet: build = factSheet, ...opts } = {}) {
  const sheet = await build(engines, req.fen, req.move, req.best);
  onSheet(explainRows(sheet), explainLines(sheet));
  const a = await answer(sheet, llm, opts);
  return { ...a, result: {
    head: null,
    rows: explainRows(a.facts),
    text: a.text,
    lines: explainLines(a.facts),
    // a deeper read that added nothing says why
    note: a.read === undefined || a.concepts ? null
      : a.read ? 'No positional idea passed the board checks.' : 'Could not read the positional ideas in the reply.',
    shapes: null,
    equal: aboutEqual(a.facts),
  } };
}

/** The plan for a plan sheet, as answer() is for a fact sheet: the plan ideas of `model`'s ideas model (a pick, see
    stepModels) checked on the board (withPlan), then its writer writes the plan from the ideas that held. No idea held, or no idea list in the planner's
    reply: throws, saying which, and the writer is never called. Returns {text, facts, ideas}. The eval starts here
    from a saved sheet. */
export async function planAnswer(sheet, llm, { model = MODEL, onStep = () => {} } = {}) {
  onStep('Looking for plan ideas');
  // the planner plans the best line only; the writer gets the about-as-good move for one sentence
  const { also_good = null, ...rest } = sheet;
  const by = stepModels(model);
  const { facts: planned, ideas, read } = await withPlan(rest, llm, by.ideas);
  if (!ideas) throw new Error(read ? 'No clear plan found here.' : 'Could not read the plan ideas in the reply.');
  const facts = { ...planned, also_good };
  onStep('Asking Claude');
  return { text: await llm(PLAN_SYSTEM, facts, by.writer), facts, ideas };
}

/** The Find plan task: the plan sheet and its planAnswer(), plus its result (see explainMove), whose shapes are
    planShapes(). The sheet comes from `sheet(engines, fen)`: planFacts(), or a sheetCache's plan. The other `opts` go
    to planAnswer(). */
export async function findPlan(engines, fen, llm, { sheet: build = planFacts, ...opts } = {}) {
  const a = await planAnswer(await build(engines, fen), llm, opts);
  const { best, also_good, side_to_move, plan_kind } = a.facts;
  return { ...a, result: {
    head: { label: `Plan for ${side_to_move}`, pill: plan_kind === 'tactical' ? 'Tactical' : 'Positional' },
    rows: [row('best', 'first move', best), ...also_good ? [row('also', 'about as good', also_good)] : []],
    text: a.text,
    lines: [best.line_with_evals, also_good?.line_with_evals].filter(Boolean),
    note: null,
    shapes: planShapes(a.facts, a.ideas, a.text),
  } };
}

/** The saved answers: the results of Explain requests, in `storage` under `answers`: [[key, result]], oldest first, at
    most ANSWERS. The key is the position's request: fen, move, best, depth, model and the extension's `version`, so
    each model keeps its own answer and a new release asks afresh. It does not hold the reasons sent: those change
    after every answer, and a position seen again must find its answer.
    - find(req): the result saved for `req` ({fen, move, best, depth, model}), or undefined. A request finds the answer
      that compares its two moves, as a sheetCache serves a sheet: with a `best`, the one saved for that best, or the
      one saved without a best whose engine move it is, whichever is the later; without one, the latest saved for any
      best.
    - save(req, a): keeps the result of explainMove()'s `a` over any old one, unless it has no text, the model declined
      or the moves are about equal (no LLM wrote that verdict: the sheet says it again). A failed save (get or set) is
      logged: it must not lose the answer just paid for. */
function savedAnswers(storage, version) {
  const all = async () => (await storage.get('answers')).answers ?? [];
  const keys = ({ fen, move, best, depth, model }) => {
    const head = `${fen} | ${move} | `, tail = ` | ${depth ? 'depth' : ''} | ${model} | ${version}`;
    return { head, tail, key: head + (best ?? '') + tail };
  };
  return {
    async find(req) {
      const { head, tail, key } = keys(req), uci = m => sanToUci(req.fen, [m])[0];
      // a result's first row is its sheet's alternative (see explainRows)
      return (req.best
        ? (await all()).findLast(([k, r]) => k === key || k === head + tail && r.rows?.[0] && uci(r.rows[0].move) === uci(req.best))
        : (await all()).findLast(([k]) => k.startsWith(head) && k.endsWith(tail)))?.[1];
    },
    async save(req, { result, facts }) {
      if (!result.text || result.text === DECLINED || aboutEqual(facts)) return;
      const { key } = keys(req);
      try {
        await storage.set({ answers: [...(await all()).filter(([k]) => k !== key), [key, result]].slice(-ANSWERS) });
      } catch (e) {
        console.error(e);
      }
    },
  };
}

/** The first sentence of an answer: its first non-empty line, up to the first '.', '!' or '?' before a space or the end. */
const firstSentence = text => {
  const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  return line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line;
};

/** `san`, played in `fen`, with its move number: '12. Nf3' for White, '12... Nf6' for Black. */
const moveLabel = (fen, san) => `${moveNo(position(fen))} ${san}`;

/** The reasons given in each game (a lichess game or study chapter id), in `storage` under `reasons`: [[game, entries]],
    oldest first, at most GAMES, each game's entries [{path, move, said, ideas}] its last REASONS explained moves.
    - recent(game, path): the reasons for earlier moves of `path`'s line in `game`: the entries whose path is a strict
      prefix of it, oldest first, as {move, said, ideas}. Empty when the game is unknown or has none.
    - keep(game, path, move, a): keeps the reason of a fresh answer `a` (explainMove's {text, facts, concepts}) for the
      position at `path`, under the compared move `move` (SAN or UCI; the sheet's `played` is another move when `move`
      is the better one): its first sentence and its verified concepts' names. Nothing for an unknown game, a decline
      or an about-equal verdict. */
function gameReasons(storage) {
  const all = async () => (await storage.get('reasons')).reasons ?? [];
  return {
    async recent(game, path) {
      if (!game) return [];
      const entries = (await all()).find(([g]) => g === game)?.[1] ?? [];
      return entries.filter(e => e.path !== path && path.startsWith(e.path)).map(({ move, said, ideas }) => ({ move, said, ideas }));
    },
    async keep(game, path, move, { text, facts, concepts }) {
      if (!game || !text || text === DECLINED || aboutEqual(facts)) return;
      const compared = san(position(facts.fen), sanToUci(facts.fen, [move])[0]);
      const entry = { path, move: moveLabel(facts.fen, compared), said: firstSentence(text), ideas: (concepts ?? []).map(c => c.concept) };
      const games = await all(), entries = games.find(([g]) => g === game)?.[1] ?? [];
      const kept = [...entries.filter(e => e.path !== path), entry].slice(-REASONS);
      await storage.set({ reasons: [...games.filter(([g]) => g !== game), [game, kept]].slice(-GAMES) });
    },
  };
}

/** One side panel's requests: Explain and Find plan, each on the lichess `board` it is handed ({read, play, tab}: a
    lichessBoard with its tab's id). `storage` keeps the saved answers and the reasons (chrome.storage.local),
    `version` is the extension's, `engines()` resolves to the started engines or throws, and `activeBoard()` to the
    board of the tab in front, or null.
    Fair play first: a request reads the board and then asks lichess, and unless lichess confirms the board's user is
    not in a game it reaches no storage, no engine and no LLM. One request at a time: one asked for while another runs
    resolves to null and does nothing. `onStep` hears each stage's name.
    - explain(board, llm, {move, depth, model, again}, {onStep, onSheet, onText}): explains `move`, or the board's next
      game move when `move` is empty (neither: throws). A saved answer is served when there is one (see savedAnswers):
      no engine, no LLM. Else explainMove() runs on the sheets' get(), with the reasons given for earlier moves of the
      board's line in its game (see gameReasons); `onSheet(rows, lines, b)` hears the rows and lines once the sheet is
      built, `onText` the answer as it is written; the fresh answer is saved and its reason kept (a failed save is
      logged and never loses the answer). `again` is an earlier call's `again`: that request asked afresh, on the
      position it was first asked for, by the user the board shows now.
      Resolves to {result, saved, b, again, ahead}: a saved result's note says so, and `again` (null unless saved)
      asks it afresh; b is the position explained; `ahead` resolves once the build ahead is over.
      Then, with the request over, the sheets of the next game moves on b's line (b.ahead) are built, so a step forward
      answers without waiting for the engines: only while the board is still on b's line in the tab in front (it is
      read again: its page rule), and never once another request has started. Fail closed: an error builds nothing.
    - plan(board, llm, {model, at}, {onStep}): findPlan() for the board's position; with `at` ({fen, path}, an
      about-equal verdict's position) the board goes there first. Its plan sheet is the sheets' plan(): the builds
      ahead are stopped before its searches start, and none starts while it runs. Resolves to {result, b}.
    - stopAhead(): stops the builds ahead (another tab came to the front). */
export function panelRequests({ storage, version, engines, activeBoard }) {
  const sheets = sheetCache(), answers = savedAnswers(storage, version), reasons = gameReasons(storage);
  let busy = false;
  const one = async job => {
    if (busy) return null;
    busy = true;
    try { return await job(); } finally { busy = false; }
  };
  const fairPlay = (user, onStep) => (onStep('Checking you are not in a game'), checkNotPlaying(user));
  const started = onStep => (onStep('Starting Stockfish'), engines());
  const buildAhead = async (board, b) => {
    const now = await activeBoard();
    if (now?.tab !== board.tab) return;
    const { user, path, fen } = await now.read();
    // the board must still be on b's line (b, or one of b.ahead): another game or chapter, or an old saved b, builds nothing
    if (![b, ...b.ahead].some(a => a.path === path && a.fen === fen)) return;
    const e = await engines();
    if (busy) return; // a request started meanwhile: the builds ahead belong to the pause after a request, not to one under way
    await sheets.prepare(e, user, b.ahead.filter(a => a.path.startsWith(path)));
  };
  return {
    stopAhead: () => sheets.stop(),
    async explain(board, llm, { move, depth, model = MODEL, again = null }, { onStep = () => {}, onSheet, onText } = {}) {
      const got = await one(async () => {
        // the board is read either way, so its page rule and the logged-in user are the current ones
        const now = await board.read();
        const asked = again ? { ...again, b: { ...again.b, user: now.user } } : { b: now, move: move || now.next, depth, model };
        if (!asked.move) throw new Error('No next game move here. Type a move to compare with.');
        const { b } = asked, req = { fen: b.fen, move: asked.move, best: b.best, depth: asked.depth, model: asked.model };
        await fairPlay(b.user, onStep);
        const saved = !again && await answers.find(req);
        if (saved) return { result: { ...saved, note: [saved.note, 'Saved answer.'].filter(Boolean).join(' ') }, saved: true, b, again: asked };
        const recent = await reasons.recent(b.game, b.path);
        const e = await started(onStep);
        onStep(`Analysing ${asked.move}`);
        const a = await explainMove(e, { fen: b.fen, move: asked.move, best: b.best }, llm, { depth: asked.depth, model: asked.model,
          recent, sheet: sheets.get, onStep, onText, onSheet: onSheet && ((rows, lines) => onSheet(rows, lines, b)) });
        await answers.save(req, a);
        await reasons.keep(b.game, b.path, asked.move, a).catch(console.error);
        return { result: a.result, saved: false, b, again: null };
      });
      // only now, with the request over: a build ahead never starts while one runs
      return got && { ...got, ahead: buildAhead(board, got.b).catch(() => {}) };
    },
    plan: (board, llm, { model, at = null }, { onStep = () => {} } = {}) => one(async () => {
      if (at) await board.play(at.fen, at.path, []);
      const b = await board.read();
      await fairPlay(b.user, onStep);
      const e = await started(onStep);
      onStep("Finding the engine's plan");
      const { result } = await findPlan(e, b.fen, llm, { model, onStep, sheet: sheets.plan }); // its searches never run beside a build ahead
      return { result, b };
    }),
  };
}
