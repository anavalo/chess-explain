import { explain as askClaude, handle, sanToUci, startEngines, uciEngine } from './explain.js';
import { linkMoves, md } from './md.js';

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
    path,
    best: box?.querySelector('.pv[data-uci]')?.dataset.uci,
    next: next?.querySelector('san')?.textContent,
    user: document.querySelector('#user_tag')?.textContent.trim(),
  };
}

/** Runs inside the lichess tab: puts the board back on the explained position (tree path `path`, FEN `fen`) and plays
    `ucis` from there, as a click on a move of lichess's own engine line does. That click is handled on .pv_box, which
    plays the moves of the clicked div.pv (span.pv-san[data-board="fen|uci"]) up to the last one hovered.
    Lichess adds them all at once and sounds each one, so the sounds are held back and only the last one plays.
    Runs in the page's main world, for `site.sound`. Returns an error message, or nothing. */
async function playLine(fen, path, ucis) {
  const sound = window.site?.sound, move = sound?.move;
  let last;
  if (move) sound.move = (...args) => (last = args);
  try {
    const box = () => document.querySelector('.pv_box[data-fen]');
    if (!box()) return "Turn lichess's engine back on to play the line on the board.";
    if (box().dataset.fen !== fen) {
      if (path) document.querySelector(`move[p="${CSS.escape(path)}"]`)?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); // the start position
      for (let i = 0; i < 20 && box()?.dataset.fen !== fen; i++) await new Promise(r => setTimeout(r, 50));
      if (box()?.dataset.fen !== fen) return 'Could not go back to the explained position. Go there and click the move again.';
    }
    const pv = document.createElement('div');
    pv.className = 'pv';
    pv.dataset.uci = ucis[0];
    pv.hidden = true;
    for (const [i, uci] of ucis.entries()) {
      const span = document.createElement('span');
      span.className = 'pv-san';
      span.dataset.board = `${fen}|${uci}`;
      span.dataset.moveIndex = i;
      pv.append(span);
    }
    box().append(pv);
    pv.lastChild.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    pv.lastChild.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    pv.lastChild.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    pv.remove();
  } finally {
    if (move) {
      sound.move = move;
      if (last) move.apply(sound, last);
    }
  }
}

const out = document.getElementById('out');

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

function render(data, b) {
  const moves = el('div', 'card moves');
  moveRow(moves, 'best', 'engine move', data.best);
  moveRow(moves, 'compared', 'compared', data.compared);
  const lines = [data.best, data.compared].flatMap(m => [m.line, m.threat_line]);
  const answer = el('div', 'card answer', { html: linkMoves(md(data.text), lines) });
  // a move link plays its line on the lichess board, up to that move
  answer.onclick = async e => {
    const a = e.target.closest('a[data-line]');
    if (!a) return;
    e.preventDefault();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith('https://lichess.org/')) return error('Switch to the lichess tab to play the line.');
    const ucis = sanToUci(b.fen, a.dataset.line.split(' '));
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN', func: playLine, args: [b.fen, b.path, ucis],
    });
    if (result) error(result);
  };
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
  let stage = 'Starting Stockfish';
  const label = el('span', '', { text: `${stage}…` }, status);
  const started = Date.now();
  const timer = setInterval(() => (label.textContent = `${stage}… ${Math.round((Date.now() - started) / 1000)} s`), 1000);
  try {
    if (!engines) throw new Error('Stockfish cannot start: the panel is not cross-origin isolated. Reload the extension at chrome://extensions.');
    const ready = await Promise.race([engines, crashed, new Promise((_, fail) =>
      setTimeout(() => fail(new Error('Stockfish did not start within 30 s.')), 30_000))]);
    stage = `Analysing ${move}`;
    const llm = (facts, key) => ((stage = 'Asking Claude'), askClaude(facts, key, model()));
    const data = await Promise.race([handle(ready, { fen: b.fen, move, best: b.best, user: b.user }, apiKey, llm), crashed]);
    out.replaceChildren();
    render(data, b);
  } catch (e) {
    console.error(e);
    out.replaceChildren();
    error(e.message);
  } finally {
    clearInterval(timer);
  }
}

document.getElementById('form').onsubmit = async e => {
  e.preventDefault();
  button.disabled = true;
  try { await explain(); } finally { button.disabled = false; }
};
