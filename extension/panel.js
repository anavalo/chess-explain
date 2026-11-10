import { llmWith, sanToUci, startEngines, uciEngine } from './explain.js';
import { panelRequests } from './request.js';
import { inTab, lichessBoard } from './lichess.js';
import { linkMoves, md } from './md.js';

// Each view (Explain, Plan) keeps its own answer; `out` is the one the running request writes to.
const outs = { explain: document.getElementById('out-explain'), plan: document.getElementById('out-plan') };
let out = outs.explain;
// the background clears the board's plan shapes when this port closes, i.e. when the panel closes
chrome.runtime.connect({ name: 'panel' });

// Both Stockfish builds run as Web Workers for as long as the panel is open. Their threads need
// SharedArrayBuffer, so the panel must be cross-origin isolated (the manifest's COOP/COEP keys).
// Without it the engines hang without any error, so they are not started at all.
// A crashed worker never answers again: its engine is told, and rejects every request from then on.
const engines = crossOriginIsolated && startEngines(path => {
  const w = new Worker(path);
  const e = uciEngine(line => w.postMessage(line));
  w.onmessage = m => e.onLine(m.data);
  w.onerror = m => e.fail(new Error(`Stockfish crashed (${m.message}). Close and reopen the panel.`));
  return e;
});
if (engines) engines.catch(() => {}); // a crash while starting is reported by the request that needs the engines
const keyInput = document.getElementById('key');
const settings = document.getElementById('settings'), gear = document.getElementById('gear');
const showSettings = open => {
  settings.hidden = !open;
  gear.setAttribute('aria-expanded', open);
};
gear.onclick = () => showSettings(settings.hidden);

// The key lives in chrome.storage.local (this profile only, never synced) and goes only to api.anthropic.com.
async function showKeyStatus() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  const status = document.getElementById('key-status');
  status.textContent = apiKey ? `saved …${apiKey.slice(-4)}` : 'not set';
  status.classList.toggle('ok', !!apiKey);
  showSettings(!apiKey);
  return apiKey;
}

document.getElementById('key-form').onsubmit = async e => {
  e.preventDefault();
  const apiKey = keyInput.value.trim();
  await (apiKey ? chrome.storage.local.set({ apiKey }) : chrome.storage.local.remove('apiKey'));
  keyInput.value = '';
  showKeyStatus();
};
showKeyStatus();

// the model is a setting too: every call of a request uses the picked one. A saved model the picker does not offer
// becomes the default.
const model = () => document.querySelector('input[name="model"]:checked').value;
chrome.storage.local.get('model').then(({ model: m }) => {
  const radio = m && document.querySelector(`input[name="model"][value="${CSS.escape(m)}"]`);
  if (radio) radio.checked = true;
  else if (m) chrome.storage.local.set({ model: model() });
});
settings.onchange = e => e.target.name === 'model' && chrome.storage.local.set({ model: e.target.value });
// positional depth: before the answer, the picked model proposes positional ideas, the board checks them, and the
// answer is written with the ideas that held. One more call; on unless turned off, remembered like the model.
const deep = document.getElementById('deep');
chrome.storage.local.get('deep').then(({ deep: on }) => (deep.checked = on !== false));
deep.onchange = () => chrome.storage.local.set({ deep: deep.checked });
// One request at a time: while one runs, every button that starts one is disabled, a saved answer's Ask again too.
let busy = false;
const setBusy = on => {
  busy = on;
  for (const b of document.querySelectorAll('#go, #plan, .again')) b.disabled = on;
};

// Builds an element; `html` is only ever our own markup or md() output, which escapes the model's text.
function el(tag, cls, { text, html } = {}, parent = out) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (html !== undefined) e.innerHTML = html;
  parent.append(e);
  return e;
}

const error = (text, parent = out) => el('div', 'card error', { text }, parent);

// a spinner card whose label counts the seconds; returns {set(stage), done()}
function spinner(stage = '') {
  const status = el('div', 'card status');
  el('div', 'spinner', {}, status);
  const label = el('span', '', { text: `${stage}…` }, status);
  const started = Date.now();
  const tick = () => (label.textContent = `${stage}… ${Math.round((Date.now() - started) / 1000)} s`);
  const timer = setInterval(tick, 1000);
  return { set: s => ((stage = s), tick()), done: () => { clearInterval(timer); status.remove(); } };
}

/** The answer card, returned; a move link in it plays its line (one of `lines`, from b's position) on the lichess board. */
function answerCard(text, lines, b) {
  const area = out, answer = el('div', 'card answer', { html: linkMoves(md(text), lines) });
  answer.onclick = async e => {
    const a = e.target.closest('a[data-line]');
    if (!a) return;
    e.preventDefault();
    try {
      const board = await activeBoard();
      if (!board) return error('Switch to the lichess tab to play the line.', area);
      await board.play(b.fen, b.path, sanToUci(b.fen, a.dataset.line.split(' ')));
    } catch (e) {
      console.error(e);
      error(e.message, area);
    }
  };
  return answer;
}

/** The moves card: a task result's head and rows (see explainMove). */
function movesCard(result) {
  const moves = el('div', 'card moves');
  if (result.head) {
    const head = el('div', 'plan-head', {}, moves);
    el('span', 'label', { text: result.head.label }, head);
    el('span', 'pill', { text: result.head.pill }, head);
  }
  for (const m of result.rows) {
    const row = el('div', `move ${m.kind}`, {}, moves);
    el('span', '', { text: m.move }, row);
    el('small', '', { text: m.label }, row);
    el('span', 'eval', { text: m.eval }, row);
  }
}

/** Shows a task's result (see explainMove) for the position `b`: every word in it comes from the task. */
function render(result, b) {
  movesCard(result);
  answerCard(result.text, result.lines, b);
  if (result.note) el('div', 'card note', { text: result.note });
}

/** The lichess board of the active tab, with its `tab` id; null when that tab is not lichess. */
const activeBoard = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.startsWith('https://lichess.org/') ? { ...lichessBoard(inTab(tab.id)), tab: tab.id } : null;
};

// The views: Explain and Plan. The plan's board shapes ([fen, shapes]) are drawn only while the Plan view shows, on
// the board the plan was asked for (`planBoard`): another tab may be the active one by the time the plan arrives.
const view = () => document.querySelector('input[name="view"]:checked').value;
let shapes = null, planBoard = null;
async function syncShapes() {
  const board = planBoard ?? await activeBoard();
  if (board) await (view() === 'plan' && shapes ? board.draw(...shapes) : board.clear()).catch(console.error);
}
document.getElementById('view').onchange = () => {
  for (const s of document.querySelectorAll('[data-view]')) s.hidden = s.dataset.view !== view();
  syncShapes();
};

/** The engines once they have started; throws when they cannot. */
async function ready() {
  if (!engines) throw new Error('Stockfish cannot start: the panel is not cross-origin isolated. Reload the extension at chrome://extensions.');
  return Promise.race([engines, new Promise((_, fail) =>
    setTimeout(() => fail(new Error('Stockfish did not start within 30 s.')), 30_000))]);
}

/** A spinner whose stages are also logged in the console, with the seconds since it started. */
function staged() {
  const s = spinner(), started = Date.now();
  const log = stage => console.log(`${((Date.now() - started) / 1000).toFixed(1)} s: ${stage}`);
  return { step: stage => (log(stage), s.set(stage)), done: () => (log('done'), s.done()) };
}

// This panel's requests (see panelRequests): Explain and Find plan, the fact sheets they build and those of the next
// moves, built while the user reads. Another tab stops a build under way. Closing the panel ends them all.
const requests = panelRequests({ storage: chrome.storage.local, version: chrome.runtime.getManifest().version, engines: ready, activeBoard });
chrome.tabs.onActivated.addListener(() => requests.stopAhead());

/** Explain for the board's position, or `again`: a saved answer's request (see panelRequests), asked afresh. */
async function explain(llm, board, again) {
  // a saved answer waits on the fair-play check alone; a new run gets a staged() spinner instead
  const check = spinner('Checking you are not in a game');
  let s = null;
  const step = stage => s.step(stage);
  // a new one shows its moves once the sheet is built, then the answer as it is written (redrawn once a frame at most)
  let card, lines, text = null, frame = 0;
  const onSheet = (rows, l, b) => { movesCard({ rows }); lines = l; card = answerCard('', lines, b); };
  const onText = t => {
    if (text === null) step('Writing');
    text = t;
    frame ||= requestAnimationFrame(() => { frame = 0; card.innerHTML = linkMoves(md(text), lines); });
  };
  let got;
  try {
    got = await requests.explain(board, llm, { move: document.getElementById('move').value.trim(), depth: deep.checked, model: model(), again },
      { onRun: () => (check.done(), (s = staged())), onStep: step, onSheet, onText });
  } finally {
    check.done();
    s?.done();
  }
  if (!got) return;
  const { result, b } = got;
  out.replaceChildren();
  render(result, b);
  if (got.again) el('button', 'again', { text: 'Ask again' }).onclick = () => run((l, bd) => explain(l, bd, got.again), 'explain');
  // about equal: no reason to give, but a plan for the position may say what to aim at. Asked only on this click.
  if (result.equal) {
    el('button', 'again', { text: 'Find a plan for this position' }).onclick = () => {
      document.querySelector('input[name="view"][value="plan"]').click();
      run((l, bd) => plan(l, bd, b), 'plan');
    };
  }
}

/** Find plan for the board's position, or for `at`, an about-equal verdict's position: the board goes there first. */
async function plan(llm, board, at) {
  const s = staged();
  let got;
  try {
    got = await requests.plan(board, llm, { model: model(), at }, { onStep: s.step });
  } finally {
    s.done();
  }
  if (!got) return;
  out.replaceChildren();
  render(got.result, got.b);
  shapes = [got.b.fen, got.result.shapes];
  planBoard = board;
  await syncShapes();
}

/** One request at a time: Explain or Find plan, each in its own view (`name`). Clears that view's last answer first,
    and for a new plan the board's shapes. */
async function run(task, name) {
  if (busy) return;
  setBusy(true);
  out = outs[name];
  out.replaceChildren();
  if (name === 'plan') shapes = null;
  try {
    const apiKey = await showKeyStatus();
    if (!apiKey) return error('Set your Anthropic API key first (above).');
    const board = await activeBoard();
    if (!board) return error('Open a lichess analysis board.');
    await syncShapes();
    await task(llmWith(apiKey), board);
  } catch (e) {
    console.error(e);
    out.replaceChildren();
    error(e.message);
  } finally {
    setBusy(false);
  }
}

document.getElementById('form').onsubmit = e => {
  e.preventDefault();
  run(explain, 'explain');
};
document.getElementById('plan').onclick = () => run(plan, 'plan');
