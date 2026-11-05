import { ask, checkNotPlaying, findPlan, handle, sanToUci, startEngines, uciEngine } from './explain.js';
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
// A crashed worker never answers again, so `crashed` rejects every request from then on.
let crash;
const crashed = new Promise((_, fail) => (crash = fail));
crashed.catch(() => {});
const engines = crossOriginIsolated && startEngines(path => {
  const w = new Worker(path);
  const e = uciEngine(line => w.postMessage(line));
  w.onmessage = m => e.onLine(m.data);
  w.onerror = m => crash(new Error(`Stockfish crashed (${m.message}). Close and reopen the panel.`));
  return e;
});
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

// the model is a setting too; Haiku unless the user picked another
const model = () => document.querySelector('input[name="model"]:checked').value;
chrome.storage.local.get('model').then(({ model: m }) => {
  const radio = m && document.querySelector(`input[name="model"][value="${CSS.escape(m)}"]`);
  if (radio) radio.checked = true;
});
settings.onchange = e => e.target.name === 'model' && chrome.storage.local.set({ model: e.target.value });
// positional depth: before the answer, the strongest model proposes positional ideas, the board checks them, and the
// answer is written with the ideas that held. One more call; remembered like the model.
const deep = document.getElementById('deep');
chrome.storage.local.get('deep').then(({ deep: on }) => (deep.checked = !!on));
deep.onchange = () => chrome.storage.local.set({ deep: deep.checked });
const buttons = [document.getElementById('go'), document.getElementById('plan')];

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

function moveRow(parent, cls, label, m) {
  const row = el('div', `move ${cls}`, {}, parent);
  el('span', '', { text: m.move }, row);
  el('small', '', { text: label }, row);
  el('span', 'eval', { text: m.eval }, row);
}

// a spinner card whose label counts the seconds; returns {set(stage), done(), gone()}; gone: a new Explain cleared it
function spinner(stage) {
  const status = el('div', 'card status');
  el('div', 'spinner', {}, status);
  const label = el('span', '', { text: `${stage}…` }, status);
  const started = Date.now();
  const tick = () => (label.textContent = `${stage}… ${Math.round((Date.now() - started) / 1000)} s`);
  const timer = setInterval(tick, 1000);
  return { set: s => ((stage = s), tick()), done: () => { clearInterval(timer); status.remove(); }, gone: () => !status.isConnected };
}

/** The answer card; a move link in it plays its line (one of `lines`, from b's position) on the lichess board. */
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
}

function render(data, b) {
  const moves = el('div', 'card moves');
  moveRow(moves, 'best', 'engine move', data.best);
  moveRow(moves, 'compared', 'compared', data.compared);
  // every line that starts at the explained position (prepares.follow_up_fails starts mid-line, so it is left out)
  answerCard(data.text, [data.best, data.compared].flatMap(m => [m.line, m.threat_line]).concat(data.facts.prepares?.line_if_played_at_once), b);
}

function renderPlan(data, b) {
  const card = el('div', 'card moves');
  const head = el('div', 'plan-head', {}, card);
  el('span', 'label', { text: `Plan for ${data.facts.side_to_move}` }, head);
  el('span', 'pill', { text: data.facts.plan_kind === 'tactical' ? 'Tactical' : 'Positional' }, head);
  moveRow(card, 'best', 'first move', data.best);
  answerCard(data.text, [data.best.line], b);
}

/** The lichess board of the active tab; null when that tab is not lichess. */
const activeBoard = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.startsWith('https://lichess.org/') ? lichessBoard(inTab(tab.id)) : null;
};

// The views: Explain and Plan. The plan's board shapes ([fen, shapes]) are drawn only while the Plan view shows.
const view = () => document.querySelector('input[name="view"]:checked').value;
let shapes = null;
async function syncShapes() {
  const board = await activeBoard();
  if (board) await (view() === 'plan' && shapes ? board.draw(...shapes) : board.clear()).catch(() => {});
}
document.getElementById('view').onchange = () => {
  for (const s of document.querySelectorAll('[data-view]')) s.hidden = s.dataset.view !== view();
  syncShapes();
};

/** The engines once they have started; throws when they cannot. */
async function ready() {
  if (!engines) throw new Error('Stockfish cannot start: the panel is not cross-origin isolated. Reload the extension at chrome://extensions.');
  return Promise.race([engines, crashed, new Promise((_, fail) =>
    setTimeout(() => fail(new Error('Stockfish did not start within 30 s.')), 30_000))]);
}

async function explain(apiKey, board) {
  const b = await board.read();
  const move = document.getElementById('move').value.trim() || b.next;
  if (!move) return error('No next game move here. Type a move to compare with.');

  const s = spinner('Checking you are not in a game');
  try {
    await checkNotPlaying(b.user);
    s.set('Starting Stockfish');
    const e = await ready();
    s.set(`Analysing ${move}`);
    const llm = (system, facts, m) => ask(system, facts, apiKey, m);
    const data = await Promise.race([handle(e, { fen: b.fen, move, best: b.best }, llm,
      { model: model(), depth: deep.checked, onStep: s.set }), crashed]);
    out.replaceChildren();
    render(data, b);
    if (data.read !== undefined && !data.concepts)
      el('div', 'card note', { text: data.read ? 'No positional idea passed the board checks.' : 'Could not read the positional ideas in the reply.' });
  } finally {
    s.done();
  }
}

async function plan(apiKey, board) {
  const b = await board.read();
  const s = spinner('Checking you are not in a game');
  try {
    await checkNotPlaying(b.user);
    s.set('Starting Stockfish');
    const e = await ready();
    s.set("Finding the engine's plan");
    const llm = (system, facts, m) => ask(system, facts, apiKey, m);
    const data = await Promise.race([findPlan(e, b.fen, llm, { model: model(), onStep: s.set }), crashed]);
    out.replaceChildren();
    renderPlan(data, b);
    shapes = [b.fen, data.shapes];
    await syncShapes();
  } finally {
    s.done();
  }
}

/** One request at a time: Explain or Find plan, each in its own view (`name`). Clears that view's last answer first,
    and for a new plan the board's shapes; the view's tab shows a spinner, for when the other view is open. */
async function run(task, name) {
  const label = document.querySelector(`input[name="view"][value="${name}"]`).parentNode;
  buttons.forEach(b => (b.disabled = true));
  label.classList.add('busy');
  out = outs[name];
  out.replaceChildren();
  if (name === 'plan') shapes = null;
  try {
    const apiKey = await showKeyStatus();
    if (!apiKey) return error('Set your Anthropic API key first (above).');
    const board = await activeBoard();
    if (!board) return error('Open a lichess analysis board.');
    await syncShapes();
    await task(apiKey, board);
  } catch (e) {
    console.error(e);
    out.replaceChildren();
    error(e.message);
  } finally {
    buttons.forEach(b => (b.disabled = false));
    label.classList.remove('busy');
  }
}

document.getElementById('form').onsubmit = e => {
  e.preventDefault();
  run(explain, 'explain');
};
document.getElementById('plan').onclick = () => run(plan, 'plan');
