# chess-explain

A Chrome side panel that explains **why** Stockfish prefers a move on lichess.org.

Lichess already shows you the engine's best move. chess-explain answers the next question: why that
move, and not the one you played (or the one you were considering)? It runs entirely on your machine,
apart from one call to Claude to put the engine facts into words.

## How it works

1. The side panel reads the position, lichess's top engine move, and the next game move from the
   lichess analysis board you have open.
2. A local Python server analyses both moves with the latest Stockfish: evaluation after every move of
   each line, captures, checks, new attacks, trapped pieces, and what the opponent threatens (a
   null-move search).
3. Stockfish 15.1's classical evaluation terms (mobility, king safety, pawn structure, ...) are compared
   at the end of each line, for the positional part of the answer.
4. Claude Haiku turns that fact sheet into a short explanation. The prompt forbids it from inventing
   moves or squares that are not in the facts.

When both moves are within 0.3 pawns, it says so and skips the LLM call.

## Fair play

Using engine help during a game you are playing is cheating. chess-explain only works where lichess
itself shows its engine (analysis boards, studies, finished games), and before every explanation the
server asks lichess's public API whether your account is playing a game. If you are, or if it cannot
tell (logged out, network error), it refuses.

## Setup

Requirements: macOS or Linux, [uv](https://docs.astral.sh/uv/), Chrome, a C++ compiler and `make`, and
an [Anthropic API key](https://console.anthropic.com/).

**1. Build the two Stockfish versions** into `bin/`:

```sh
git clone https://github.com/official-stockfish/Stockfish.git /tmp/stockfish
cd /tmp/stockfish/src
make -j build ARCH=native && cp stockfish /path/to/chess-explain/bin/sf-latest
git checkout sf_15.1 && make clean && make -j build ARCH=native && cp stockfish /path/to/chess-explain/bin/sf15
```

(`make help` lists the other `ARCH` values if `native` does not work for you.)

**2. Start the server** and leave it running:

```sh
uv run server.py
```

**3. Load the extension:** open `chrome://extensions`, turn on Developer mode, click **Load unpacked**
and pick the `extension/` folder. Click the extension's toolbar icon to open the side panel.

**4. Set your API key** in the panel's settings. It is stored in `chrome.storage.local` (this browser
profile only, not synced) and sent only to the local server, which passes it to the Anthropic API. If
you prefer, leave it unset in the panel and start the server with `ANTHROPIC_API_KEY=... uv run server.py`
instead.

## Use

Open a game or position on lichess's analysis board, turn on lichess's engine, step to the position
where you want an explanation, and click **Explain**. By default it compares lichess's top move with the
move played next in the game; type a move in the box to compare with that instead.

Each explanation takes about 10–20 seconds and one Claude Haiku call.

## Command line

`explain.py` works without the extension:

```sh
uv run explain.py "<FEN>" <move> [--vs <move>] [--effort low|medium|high] [--no-llm]
```

`--no-llm` prints the fact sheet the model would see.

## Tests

```sh
uv run test_server.py      # server request handling, with the LLM stubbed out
node extension/md.test.js  # the panel's markdown renderer
```

## Limitations

- Engine lines are not deterministic, so the same position can get a slightly different explanation.
- Attack labels cover direct attacks; batteries and discovered attacks show up only through the
  "threatens" labels.
- Standard chess only.

## License

MIT. Stockfish is GPL-3.0 and is not included; you build it yourself (see Setup).
