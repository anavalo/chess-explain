# chess-explain

Explains to a club player why one chess move is better than another, from engine facts worded by an LLM.

## Explaining

**Fact sheet**:
The engine facts about one position and two candidate moves that the explainer is given, and the only ground truth it may use. The two moves are the better move and the move it is set against: the compared move, or the engine's best other move when the compared move is itself the better one.
_Avoid_: facts block, sheet JSON

**Compared move**:
The move an Explain request asks about: the next move of the game, or one the user types.
_Avoid_: played move (it may never have been played), asked move

**Better move**:
The stronger of a fact sheet's two moves: the best move the request names, else the higher-scored of the compared move and the engine's best other move. A named best stays the better move even where the engine scores it lower.
_Avoid_: engine move, best move

**Label**:
A short worded fact attached to a move or position on the fact sheet (a pin, an outpost, a pawn island change).
_Avoid_: tag, annotation

**Feature**:
A structural fact about one side's pawns or pieces (a doubled pawn, a passed pawn, an outpost square, a shield hole), before it is worded as a label. Data: a `kind` naming its label kind, plus the fields that identify it (a square, a file). Two features are the same fact when every field is equal.
_Avoid_: imbalance, weakness

**Label kind**:
One row of the kinds table in `features.js`: how a feature of that kind is worded on the fact sheet, and a sample feature whose wording must appear in the sheet legend. Every feature has exactly one label kind; a tactical label on a move (a capture, a check, an attack, a pin) has none.
_Avoid_: label type, tag type

**Imbalance**:
Silman's sense: a feature that already differs between the two sides in the position before any move.
_Avoid_: feature (when only the root position is meant)

**Explainer**:
The LLM that writes the answer from a fact sheet.
_Avoid_: coach, model (when the role is meant)

**Answer**:
What the user gets for one fact sheet: a plain verdict when the two moves are about equal, else the explainer's text, written after a deeper read when depth is on.
_Avoid_: reply, response

**About equal**:
Two moves whose engine gap is too small to explain: the fact sheet stops at the two moves' scores, the answer is a plain verdict and no explainer runs.
_Avoid_: draw, equal position

**Deeper read**:
An optional step before the explainer writes: the concept proposer suggests positional ideas for the fact sheet, the board checks them, and the verified concepts go on the sheet. It runs when depth is on. Find plan always runs one, with the planner in the concept proposer's place.
_Avoid_: deep mode, concept mode, second pass

**Concept proposer**:
The call in a deeper read, to the picked model, that names positional ideas for a fact sheet, each as a claim sentence plus board checks.
_Avoid_: coach, concept LLM

**Board check**:
One question a program asks the board at a named position (is e5 an outpost, how many pieces attack f7), with the value expected. One row of the checks table in `concepts.js`: how the board answers and how the sheet words the answer.
_Avoid_: op, primitive, tool

**Verified concept**:
A proposed idea whose board checks all held, shown on the fact sheet in `verified_concepts` with its checks in words.
_Avoid_: concept (when an unchecked proposal is meant)

## Planning

**Plan sheet**:
The engine facts about one position and the engine's best line from it, which the plan is written from.
_Avoid_: plan facts, fact sheet (that one compares two moves)

**Planner**:
The call, to the picked model, that proposes plan ideas for a plan sheet, each as a claim sentence plus board checks.
_Avoid_: coach, plan LLM

**Plan idea**:
A proposed idea whose board checks all held, shown on the plan sheet with its checks in words and the squares it aims at.
_Avoid_: concept, verified concept (those belong to a fact sheet)

**Plan**:
What the user gets for one plan sheet: a goal, two or three steps and a reason, written from the plan ideas.
_Avoid_: answer (that one explains two moves)

## Panel

**Request**:
One Explain or Find plan run from the panel: the fair-play check, then the engines, then the task. An Explain request also reads the reasons given earlier in the game, serves a saved answer when it has one, and keeps a fresh answer's reason.
_Avoid_: handler, flow

**Result**:
What one request shows in the panel: the move rows, the answer's or plan's text, the lines its move links play, a note and the board shapes.
_Avoid_: card (that is one box in the panel), view

## Lichess

**Lichess board**:
The analysis board in the lichess tab: where the position comes from, where an answer's lines are played and where a plan's shapes are drawn. It can be used where lichess allows its engine, whether or not the engine is switched on, and in a study where lichess does not (computer analysis turned off, or an interactive lesson); never with a game in progress or in a broadcast.
_Avoid_: page, tab, DOM

## Prompt

**Sheet legend**:
The part of the explainer prompt that says what each fact sheet field and label means.
_Avoid_: glossary, field guide

**Rules**:
The numbered instructions on how the explainer must write its answer.
_Avoid_: guidelines, style rules

**Explainer prompt**:
The sheet legend plus the rules the model gets.
_Avoid_: SYSTEM, system prompt

**Rule check**:
A mechanical test of one answer against one rule, with no LLM involved.
_Avoid_: problem, lint

## Evaluation

**Judge**:
The LLM that grades answers against their fact sheet, given the sheet legend but never the rules, so a rule change under test cannot bias it.
_Avoid_: grader
