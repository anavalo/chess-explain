const SERVER = 'http://127.0.0.1:8765/explain';

// Runs inside the lichess tab. The engine panel (.pv_box) only exists when lichess allows analysis,
// which it never does during a live game.
function readBoard() {
  const box = document.querySelector('.pv_box[data-fen]');
  const path = document.querySelector('move.active[p]')?.getAttribute('p') ?? '';
  // Tree paths are 2 characters per node; the first child of the current node is the game continuation.
  const next = [...document.querySelectorAll('move[p]')].find(m => {
    const p = m.getAttribute('p');
    return p.length === path.length + 2 && p.startsWith(path);
  });
  return {
    fen: box?.dataset.fen,
    best: box?.querySelector('.pv[data-uci]')?.dataset.uci,
    next: next?.querySelector('san')?.textContent,
    user: document.querySelector('#user_tag')?.textContent.trim(),
  };
}

const out = document.getElementById('out');
const keyInput = document.getElementById('key');

// The key lives in chrome.storage.local (this profile only, never synced) and goes only to the local server.
async function showKeyStatus() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  document.getElementById('key-status').textContent = apiKey ? `set (…${apiKey.slice(-4)})` : 'not set';
  document.getElementById('settings').open = !apiKey;
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
const button = document.getElementById('go');

// Builds an element; `html` is only ever our own markup or md() output, which escapes the model's text.
function el(tag, cls, { text, html } = {}, parent = out) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (html !== undefined) e.innerHTML = html;
  parent.append(e);
  return e;
}

const error = text => el('div', 'card error', { text });

function moveRow(parent, cls, label, m) {
  const row = el('div', `move ${cls}`, {}, parent);
  el('span', '', { text: m.move }, row);
  el('small', '', { text: label }, row);
  el('span', 'eval', { text: m.eval }, row);
}

function render(data) {
  const moves = el('div', 'card moves');
  moveRow(moves, 'best', 'engine move', data.best);
  moveRow(moves, 'compared', 'compared', data.compared);
  el('div', 'card answer', { html: md(data.text) });
  const details = el('details', 'card');
  el('summary', '', { text: 'Engine lines' }, details);
  el('div', 'line', { text: `${data.best.move}: ${data.best.line}` }, details);
  el('div', 'line', { text: `${data.compared.move}: ${data.compared.line}` }, details);
}

async function explain() {
  out.replaceChildren();
  const apiKey = await showKeyStatus();
  if (!apiKey) return error('Set your Anthropic API key first (above).');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://lichess.org/')) return error('Open a lichess analysis board.');
  const [{ result: b }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readBoard });
  if (!b.fen) return error("No engine panel found. Open the analysis board and turn on lichess's engine.");
  const move = document.getElementById('move').value.trim() || b.next;
  if (!move) return error('No next game move here. Type a move to compare with.');

  const status = el('div', 'card status');
  el('div', 'spinner', {}, status);
  const label = el('span', '', { text: `Analysing ${move}…` }, status);
  const started = Date.now();
  const timer = setInterval(() => (label.textContent = `Analysing ${move}… ${Math.round((Date.now() - started) / 1000)} s`), 1000);
  try {
    const r = await fetch(SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Anthropic-Key': apiKey },
      body: JSON.stringify({ fen: b.fen, move, best: b.best, user: b.user }),
    });
    const data = await r.json();
    out.replaceChildren();
    r.ok ? render(data) : error(data.error);
  } catch (e) {
    out.replaceChildren();
    error(`Server not running? Start it with: uv run server.py (${e.message})`);
  } finally {
    clearInterval(timer);
  }
}

document.getElementById('form').onsubmit = async e => {
  e.preventDefault();
  button.disabled = true;
  try { await explain(); } finally { button.disabled = false; }
};
