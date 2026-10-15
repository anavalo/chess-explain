# Chrome Web Store listing

Text to paste into the developer dashboard. Upload `chess-explain.zip`, built with `npm run zip`.
The icon source is `icon.svg`; the PNGs in `extension/icons/` are rendered from it.

## Store listing

**Name:** chess-explain

**Summary** (from the manifest, max 132 characters):
Explains why lichess's engine move is better. Stockfish runs in the browser.

**Category:** Education

**Language:** English

**Description:**

Lichess shows you the engine's best move. chess-explain tells you why that move, and not the one you
played.

Open a game on lichess's analysis board, step to a position and click Explain. The side panel
compares lichess's top move with the move played in the game (or any move you type), and explains the
difference in plain language: the tactic that refutes the played move, the threat it ignored, or the
positional reason one move is better.

How it works:
- Stockfish 19 runs in your browser and analyses both moves: the evaluation after every move of each
  line, captures, checks, attacks, trapped pieces and the opponent's threats.
- Stockfish 15's classical evaluation terms (mobility, king safety, pawn structure, ...) explain the
  positional part.
- Claude turns those engine facts into a short explanation, without inventing moves.

You need your own Anthropic API key. It stays in your browser and is sent only to Anthropic.

Fair play: chess-explain only works where lichess itself shows its engine, and before every
explanation it asks lichess whether you are playing a game. If you are, it refuses.

Free and open source (GPL-3.0): https://github.com/anavalo/chess-explain

If it helps you, you can support it on Ko-fi: https://ko-fi.com/anavalo

**Screenshots:** at least one, 1280×800 or 640×400: the side panel next to a lichess analysis board,
showing an explanation.

**Small promo tile** (optional): 440×280.

## Privacy practices

**Single purpose:**
Explain, in plain language, why the chess engine prefers one move over another in the position open on
lichess.org.

**Permission justifications:**
- `sidePanel`: the extension's whole interface is a side panel next to the lichess board.
- `scripting`: when the user clicks Explain, reads the position, lichess's engine move, the next game
  move and the username from the open lichess tab.
- `storage`: stores the user's Anthropic API key locally (`chrome.storage.local`, not synced).
- Host permission `https://lichess.org/*`: needed to read the board from lichess tabs and to call
  lichess's public API for the fair-play check (is the user playing a game right now).

**Remote code:** No. All code, including the Stockfish WebAssembly builds, is in the package.

**Data usage:**
- Authentication information: the user's Anthropic API key, stored locally and sent only to
  api.anthropic.com.
- Website content: the chess position and moves on the lichess page, sent to Anthropic to write the
  explanation; the lichess username, sent to lichess for the fair-play check.

Certify all three: data is not sold to third parties, not used or transferred for purposes unrelated to
the single purpose, and not used to determine creditworthiness or for lending.

**Privacy policy URL:** https://github.com/anavalo/chess-explain/blob/main/PRIVACY.md
