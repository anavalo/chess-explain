import { explain as askClaude, handle, startEngines, uciEngine } from './explain.js';
import { md } from './md.js';
import { Chess, parseFen, parseSan } from './vendor/chessops.js';

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

// The key lives in chrome.storage.local (this profile only, never synced) and goes only to api.anthropic.com.
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

const GLYPH = { king: '♚', queen: '♛', rook: '♜', bishop: '♝', knight: '♞', pawn: '♟' };

/** Draws `pos` from the side to move's view (`flip` for Black) and highlights the last move. */
function drawBoard(board, pos, flip, move) {
  board.replaceChildren();
  for (let i = 0; i < 64; i++) {
    const row = i >> 3, col = i & 7;
    const rank = flip ? row : 7 - row, file = flip ? 7 - col : col, sq = rank * 8 + file;
    const p = pos.board.get(sq);
    const last = move && (sq === move.from || sq === move.to) ? ' last' : '';
    // U+FE0E keeps the pawn from turning into an emoji
    el('div', `sq ${(rank + file) % 2 ? 'light' : 'dark'}${last}${p ? ' ' + p.color : ''}`, { text: p ? GLYPH[p.role] + '︎' : '' }, board);
  }
}

/** An engine line ('12. you Bc3 [labels] (eval) 12... opp ...') as one button per move; each shows the board after it. */
function lineRow(parent, label, line, start, board, flip) {
  const row = el('div', 'line', { text: `${label}: ` }, parent);
  let pos = start;
  for (const [text, san] of line.matchAll(/\d+\.(?:\.\.)? (?:you|opp) (\S+).*?(?=\s\d+\.(?:\.\.)? (?:you|opp) |$)/g)) {
    const mv = parseSan(pos, san);
    if (!mv) break;
    pos = pos.clone();
    pos.play(mv);
    const after = pos;
    el('button', 'ply', { text }, row).onclick = e => {
      parent.querySelector('.ply.on')?.classList.remove('on');
      e.currentTarget.classList.add('on');
      board.ariaLabel = `Position after ${san}`;
      drawBoard(board, after, flip, mv);
    };
    row.append(' ');
  }
}

function render(data, fen) {
  const moves = el('div', 'card moves');
  moveRow(moves, 'best', 'engine move', data.best);
  moveRow(moves, 'compared', 'compared', data.compared);
  el('div', 'card answer', { html: md(data.text) });
  const details = el('details', 'card');
  el('summary', '', { text: 'Engine lines (click a move to see the position)' }, details);
  const start = Chess.fromSetup(parseFen(fen).unwrap()).unwrap(), flip = start.turn === 'black';
  const board = el('div', 'board', {}, details);
  board.role = 'img';
  board.ariaLabel = 'Position before any move';
  drawBoard(board, start, flip);
  lineRow(details, data.best.move, data.best.line, start, board, flip);
  lineRow(details, data.compared.move, data.compared.line, start, board, flip);
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
    const llm = (...args) => ((stage = 'Asking Claude'), askClaude(...args));
    const data = await Promise.race([handle(ready, { fen: b.fen, move, best: b.best, user: b.user }, apiKey, llm), crashed]);
    out.replaceChildren();
    render(data, b.fen);
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
