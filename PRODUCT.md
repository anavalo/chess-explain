# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A club-level chess improver who studies positions on lichess: their own finished games, studies, and
book positions. They are not tied to post-game review. They sit at a desktop browser with a lichess
analysis board open and lichess's engine on. The engine has shown them a better move and they cannot see
why it is better than the move they had in mind. They know chess vocabulary (pin, outpost, open file) and
do not need it taught.

## Product Purpose

chess-explain explains why one chess move is better than another. It reads the position and the two
moves from the lichess board, runs Stockfish in the browser to collect hard facts about both lines, and
has Claude word those facts as a short explanation a human can use. Success is an answer that names the
decisive point and contains no claim the engine facts do not support.

## Positioning

Every sentence in an answer is backed by engine facts computed on the user's machine. The explainer is
forbidden from inventing moves or squares that are not on the fact sheet, and positional ideas are run
as checks on the board and thrown away when a check does not hold. When the two moves are about as
good, the product says so instead of manufacturing a reason. There is no server of ours.

## Operating Context

- A Chrome side panel next to a lichess analysis board, study, or finished game.
- The user steps to a position, clicks **Explain**, and waits about half a minute while the engines run.
- By default the panel compares lichess's top engine move with the next game move. The user can type
  another move to compare with instead.
- Moves in the answer are links that play their line on the lichess board.
- **Positional depth** is an optional switch that adds board-checked positional ideas at the cost of one
  more model call.
- **Find plan** asks for a plan for the side to move, in its own Plan tab next to Explain. It is on the
  branch `feat/find-plan`.
- Setup needs an Anthropic API key, entered once in the panel's settings.

## Capabilities and Constraints

Durable constraints, confirmed by the owner:

- **No server of ours.** Engines run in the browser. Calls leave only for Anthropic (the explanation)
  and lichess (the fair-play check). Free and open source, GPL-3.0.
- **The user's own API key.** Bring-your-own Anthropic key stays the model. A no-key path is not planned.
- **Lichess only.** It works where lichess itself allows its engine, switched on or not, and in a study where
  lichess does not (computer analysis turned off, or an interactive lesson). Never with a game in progress or in a
  broadcast. No chess.com or other sites.
- **Chrome side panel only.** No standalone web app and no mobile surface.

Other product facts:

- **Fair play.** Before every explanation the panel asks lichess whether the account is playing a game.
  If it is, or if the panel cannot tell, it refuses.
- **About equal.** When the two moves are within 0.3 pawns the panel says so and skips the rest of the
  analysis and the model call. Under the verdict it offers Find plan for the position; nothing runs
  until the user clicks.
- **No evaluation numbers in answers.** Answers use words, not centipawns.
- **Two models, named only in the picker.** The settings offer a split (the default): Claude Fable 5.2
  for the ideas call, Claude Opus 5.5 for the writing. They also offer each model alone, which then makes
  every call of a request. Other panel text says "the model".
- Plain JavaScript, no framework, no build step. Everything the extension needs is committed.
- An explanation takes about half a minute. The wait is a product fact, not a defect to hide.
- Terminology is fixed in `GLOSSARY.md` (fact sheet, label, feature, imbalance, explainer).

- **No whole-game review** (decided 2026-11-10). A row of chips for a game's mistakes was built and
  removed by the owner; lichess already marks them.

## Brand Commitments

- Name: **chess-explain**, lower case, hyphenated.
- Icon: `store/icon.svg`, rendered to `extension/icons/`.
- Voice in the README and store listing: dry humour at the user's and the engine's expense ("so next
  time you can blunder in a new and more interesting way").
- Voice in the panel: plain and short. Labels, errors, refusals, and answers carry no jokes.

## Evidence on Hand

- `store/screenshot.png`: the panel next to a lichess analysis board.
- `eval-sets/quiet-132.json`: 132 quiet positions from lichess games. In the October 2026 eval on it,
  Claude Opus 5.5 made about half as many false or unsupported claims as Claude Haiku and found the
  decisive point more often.
- Positional depth on 39 positions from Silman's *How to Reassess Your Chess*: the book's reason given
  in 34 of 78 answers, up from 14, with no clear rise in false claims (README, How it works).
- Cost with Opus 5.5: about 5 to 10 cents an explanation with positional depth (on by default), about 3
  to 6 without. Fable 5.2 costs twice as much per token; the default split pays that on the ideas call only.
  Neither was measured (README, Cost).
- `PRIVACY.md`: what leaves the browser and where it goes.
- There are no testimonials, user counts, or press. Future work must not invent them.

## Product Principles

1. **Facts before words.** Nothing appears in an answer that the engines did not establish.
2. **Honest about limits.** "Either move is fine" and a refusal are valid answers.
3. **Nothing of ours in the middle.** The user's browser, their key, their lichess board.
4. **The board is the workspace.** The panel sits beside lichess and drives it. It does not replace it.
5. **Short enough to use.** An answer is a few sentences a player can act on next game.
