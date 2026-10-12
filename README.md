# chess-explain

A Chrome side panel that explains **why** Stockfish prefers a move on lichess.org.

Lichess already shows you the engine's best move. chess-explain answers the next question: why that
move, and not the one you played (or the one you were considering)? Everything runs in your browser,
apart from one call to Claude to put the engine facts into words.

## How it works

1. The side panel reads the position, lichess's top engine move, and the next game move from the
   lichess analysis board you have open.
2. Stockfish 19 (the WebAssembly "lite" build, running in the panel) analyses both moves: evaluation
   after every move of each line, captures, checks, new attacks, trapped pieces, and what the opponent
   threatens (a null-move search).
3. Stockfish 15's classical evaluation terms (mobility, king safety, pawn structure, ...) are compared
   at the end of each line, for the positional part of the answer. They are rescaled to match
   Stockfish 15.1's values.
4. Claude Haiku turns that fact sheet into a short explanation. The prompt forbids it from inventing
   moves or squares that are not in the facts.

When both moves are within 0.3 pawns, it says so and skips the LLM call.

## Fair play

Using engine help during a game you are playing is cheating. chess-explain only works where lichess
itself shows its engine (analysis boards, studies, finished games), and before every explanation the
panel asks lichess's public API whether your account is playing a game. If you are, or if it cannot
tell (logged out, network error), it refuses.

## Setup

Requirements: Chrome (or another Chromium-based browser) and an
[Anthropic API key](https://console.anthropic.com/).

1. Install chess-explain from the
   [Chrome Web Store](https://chromewebstore.google.com/detail/bjdphipaglklkipdgnafphplndgplipc).
2. Click the extension's toolbar icon to open the side panel.
3. Set your API key in the panel's settings. It is stored in `chrome.storage.local` (this browser
   profile only, not synced) and sent only to the Anthropic API.

To run it from source instead, open `chrome://extensions`, turn on Developer mode, click
**Load unpacked** and pick the `extension/` folder of a clone.

## Use

Open a game or position on lichess's analysis board, turn on lichess's engine, step to the position
where you want an explanation, and click **Explain**. By default it compares lichess's top move with the
move played next in the game; type a move in the box to compare with that instead.

Each explanation takes about 15–25 seconds and one Claude Haiku call. The position, the engine lines
and their evaluations are sent to Anthropic; your lichess username is sent only to lichess, for the
fair-play check. See [PRIVACY.md](PRIVACY.md).

## Command line

The same code runs in [Node.js](https://nodejs.org/) (tested with Node 24), without the extension:

```sh
ANTHROPIC_API_KEY=... node extension/explain.js "<FEN>" <move> [--vs <move>] [--effort low|medium|high] [--no-llm]
```

`--no-llm` prints the fact sheet the model would see, and needs no API key.

## Tests

```sh
node test.js
```

This runs the real engines (single-threaded, so results are repeatable) on the regression positions,
with the LLM stubbed out. It calls lichess for the fair-play check and takes about three minutes.

## Updating the bundled libraries

`extension/vendor/` is committed, so the extension works straight from a clone. To rebuild it after
changing the versions in `package.json`:

```sh
npm install
npm run vendor
```

## Limitations

- Engine lines are not deterministic, so the same position can get a slightly different explanation.
- The lite Stockfish build uses a small network: far stronger than any human, but weaker than full
  Stockfish.
- Attack labels cover direct attacks; batteries and discovered attacks show up only through the
  "threatens" labels.
- Standard chess only.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

The extension bundles [Stockfish](https://stockfishchess.org/) (GPL-3.0), as WebAssembly builds from
[stockfish.js](https://github.com/nmrugg/stockfish.js), and lichess's
[chessops](https://github.com/niklasf/chessops) (GPL-3.0-or-later).
