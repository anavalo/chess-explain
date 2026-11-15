// The lichess board: everything the extension knows about lichess's page. It is read and written through lichess's own
// analysis controller (window.site.analysis), never the page's markup, and only where lichess allows its engine or
// in a study (see readPage); never with a game in progress.
//
// readPage, playLine and showShapes run inside the lichess tab. chrome.scripting sends each one as source text, the
// text esbuild wrote into the bundle, so each must stand alone there: no name from this file and no helper of the
// build may appear in its body (test.ts builds the bundle and runs each one from that text).

/** One of the same side's next turns on the line (see readPage). */
export interface AheadSpot { fen: string; path: string; next: string }
/** What read() returns: the board's position (see readPage). */
export interface BoardPosition {
  fen: string;
  path: string;
  best: string | undefined;
  next: string | undefined;
  user: string | undefined;
  ahead: AheadSpot[];
  game: string | null;
}
/** A chessground shape: an arrow (orig to dest) or a circle (orig only). */
export interface Shape { orig: string; dest?: string; brush: string }
/** Runs `func` in one lichess page with `args` and resolves to its result (see lichessBoard). */
export type Run = <Args extends (string | string[] | Shape[] | null)[], R>(func: (...args: Args) => R, args: Args) => Promise<R>;
/** What lichessBoard() returns. */
export interface LichessBoard {
  read(): Promise<BoardPosition>;
  play(fen: string, path: string, ucis: string[]): Promise<void>;
  draw(fen: string, shapes: Shape[]): Promise<void>;
  clear(): Promise<void>;
}
/** A lichessBoard with its tab's id (see the panel's activeBoard). */
export type TabBoard = LichessBoard & { tab: number };

// lichess's page, as the functions below read it
interface TreeNode { id: string; fen: string; san?: string; children?: TreeNode[]; ceval?: { pvs?: { moves: string | string[] }[] } }
interface Chessground { setAutoShapes: (shapes: Shape[]) => void; chessExplainWrapped?: boolean }
interface AnalysisCtrl {
  node: TreeNode;
  path: string;
  study?: { relay?: object; data?: { chapter?: { id: string } } };
  ongoing?: boolean | null;
  data?: { game?: { id: string } };
  isCevalAllowed?: () => boolean;
  cevalEnabled?: () => boolean;
  userJumpIfCan(path: string): void;
  playUciList(ucis: string[]): void;
  chessground?: Chessground;
  setChessground: (cg: Chessground) => void;
  setAutoShapes(): void;
  chessExplainWrapped?: boolean;
}
declare global {
  interface Window {
    site?: { analysis?: AnalysisCtrl; sound: { move?: (...args: TreeNode[]) => void } };
    chessExplainShapes?: { board: string; shapes: Shape[] } | null;
  }
}

/** In the lichess tab: the board's position, or {error}. `best` is lichess's top engine move, set only while lichess
    shows its engine's lines; `next` is the next game move. `ahead`: the same side's next two turns on the line
    (two and four plies on), each {fen, path, next} as above, those with no next move left out. `game`: the study chapter's id, or the game's (null
    on a board that is no game, which lichess calls 'synthetic').
    The rule: where lichess allows its engine, and also in a study where it does not (computer analysis turned off,
    or an interactive lesson). Never with a game in progress or in a broadcast. Fails closed when any of that cannot
    be read. */
function readPage(): BoardPosition | { error: string } {
  const ctrl = window.site?.analysis;
  if (!ctrl?.node) return { error: 'Open a lichess analysis board or study.' };
  const study = ctrl.study && ctrl.ongoing === false && !ctrl.study.relay;
  if (!ctrl.isCevalAllowed?.() && !study)
    return { error: 'Lichess does not allow its engine here (a game in progress, or a broadcast).' };
  const moves = ctrl.cevalEnabled?.() ? ctrl.node.ceval?.pvs?.[0]?.moves : undefined;
  const ahead: AheadSpot[] = [];
  for (let n: TreeNode | undefined = ctrl.node, path = ctrl.path, i = 1; i <= 4 && (n = n.children?.[0]); i++) {
    path += n.id;
    if (i % 2 === 0 && n.children?.[0]) ahead.push({ fen: n.fen, path, next: n.children[0].san! });
  }
  const game = ctrl.study ? ctrl.study.data?.chapter?.id : ctrl.data?.game?.id;
  return {
    fen: ctrl.node.fen,
    path: ctrl.path,
    best: typeof moves === 'string' ? moves.split(' ')[0] : moves?.[0],
    next: ctrl.node.children?.[0]?.san,
    user: document.querySelector('#user_tag')?.textContent.trim(),
    ahead,
    game: game && game !== 'synthetic' ? game : null,
  };
}

/** In the lichess tab: puts the board back on the position a read returned (tree path `path`, FEN `fen`) and plays
    `ucis` from there, as a click on a move of lichess's engine line does. Lichess adds the moves all at once and sounds
    each one, so the sounds are held back and only the last one plays. With no `ucis` it only goes to the position.
    Returns an error message, or nothing. */
function playLine(fen: string, path: string, ucis: string[]): string | undefined {
  const ctrl = window.site?.analysis;
  if (!ctrl?.node) return 'Open a lichess analysis board or study to play the line on the board.';
  if (ctrl.node.fen !== fen) ctrl.userJumpIfCan(path);
  if (ctrl.node.fen !== fen) return 'Could not go back to the explained position. Go there and click the move again.';
  if (!ucis.length) return;
  const sound = window.site!.sound, move = sound?.move;
  let last: TreeNode[] | undefined;
  if (move) sound.move = (...args) => (last = args);
  try {
    ctrl.playUciList([...ucis]);
  } finally {
    if (move) {
      sound.move = move;
      if (last) move.apply(sound, last);
    }
  }
}

/** In the lichess tab: draws `shapes` (chessground arrows and circles) on lichess's auto-shape layer, which studies
    never save, while the board shows `fen`'s position; no `fen` clears them. Lichess redraws that layer on every move
    and engine update, so its chessground's setAutoShapes is wrapped to add ours each time, and so is the chessground
    lichess swaps in when it rebuilds the board. */
function showShapes(fen: string | null, shapes: Shape[] | null) {
  const ctrl = window.site?.analysis;
  window.chessExplainShapes = fen ? { board: fen.split(' ')[0], shapes: shapes! } : null;
  if (!ctrl?.chessground) return;
  const wrap = (cg: Chessground | undefined) => {
    if (!cg || cg.chessExplainWrapped) return;
    const own = cg.setAutoShapes.bind(cg);
    cg.setAutoShapes = auto => {
      const ours = window.chessExplainShapes;
      own(ours && ctrl.node.fen.split(' ')[0] === ours.board ? [...auto, ...ours.shapes] : auto);
    };
    cg.chessExplainWrapped = true;
  };
  if (!ctrl.chessExplainWrapped) {
    const set = ctrl.setChessground;
    ctrl.setChessground = cg => { wrap(cg); set(cg); };
    ctrl.chessExplainWrapped = true;
  }
  wrap(ctrl.chessground);
  ctrl.setAutoShapes();
}

/** The lichess board behind `run(func, args)`, which runs a function in one lichess page and resolves to its result:
    inTab() in the extension, a direct call on a fake page in the tests.
    - read(): {fen, path, best, next, user, ahead, game}; throws, with the reason worded for the user, where there is no analysis
      board or the rule (see readPage) says no. The one place that rule is decided.
    - play(fen, path, ucis): plays a line from a position a read returned, or with no moves only goes there; throws
      when the board cannot get back there.
    - draw(fen, shapes) / clear(): the plan's shapes, shown while the board is on `fen`. */
export function lichessBoard(run: Run): LichessBoard {
  return {
    async read() {
      const b = await run(readPage, []);
      if (!b || 'error' in b) throw new Error(b?.error ?? 'Could not read the lichess board.');
      return b;
    },
    async play(fen, path, ucis) {
      const error = await run(playLine, [fen, path, ucis]);
      if (error) throw new Error(error);
    },
    draw: (fen, shapes) => run(showShapes, [fen, shapes]),
    clear: () => run(showShapes, [null, null]),
  };
}

/** run() for the lichess tab `tabId`: in the page's main world, where lichess's controller lives. */
export const inTab = (tabId: number): Run => async (func, args) =>
  (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args }))[0].result!;
