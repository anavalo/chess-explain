# chess-explain

Explains to a club player why one chess move is better than another, from engine facts worded by an LLM.

## Explaining

**Fact sheet**:
The engine facts about one position and two candidate moves that the explainer is given, and the only ground truth it may use.
_Avoid_: facts block, sheet JSON

**Label**:
A short worded fact attached to a move or position on the fact sheet (a pin, an outpost, a pawn island change).
_Avoid_: tag, annotation

**Explainer**:
The LLM that writes the answer from a fact sheet.
_Avoid_: coach, model (when the role is meant)

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
