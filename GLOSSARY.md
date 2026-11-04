# chess-explain

Explains to a club player why one chess move is better than another, from engine facts worded by an LLM.

## Explaining

**Fact sheet**:
The engine facts about one position and two candidate moves that the explainer is given, and the only ground truth it may use.
_Avoid_: facts block, sheet JSON

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
Two moves whose engine gap is too small to explain: the answer is a plain verdict and no explainer runs.
_Avoid_: draw, equal position

**Deeper read**:
An optional step before the explainer writes: the concept proposer suggests positional ideas for the fact sheet, the board checks them, and the verified concepts go on the sheet. It runs when depth is on.
_Avoid_: deep mode, concept mode, second pass

**Concept proposer**:
The strongest-model call in a deeper read that names positional ideas for a fact sheet, each as a claim sentence plus board checks.
_Avoid_: coach, concept LLM

**Verified concept**:
A proposed idea whose board checks all held, shown on the fact sheet in `verified_concepts` with its checks in words.
_Avoid_: concept (when an unchecked proposal is meant)

## Prompt

**Sheet legend**:
The part of the explainer prompt that says what each fact sheet field and label means.
_Avoid_: glossary, field guide

**Rules**:
The numbered instructions on how the explainer must write its answer.
_Avoid_: guidelines, style rules

**Explainer prompt**:
The sheet legend plus the rules one model gets; models differ only in which rules they get.
_Avoid_: SYSTEM, system prompt

**Rule check**:
A mechanical test of one answer against one rule, with no LLM involved.
_Avoid_: problem, lint

## Evaluation

**Judge**:
The LLM that grades answers against their fact sheet, given the sheet legend but never the rules, so a rule change under test cannot bias it.
_Avoid_: grader
