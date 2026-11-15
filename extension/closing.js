// The closing line of an answer or a plan: the rule line, a book rule of thumb tied to the board, when the rule picker
// finds one whose board checks hold. Without one an answer keeps the advice line the explainer wrote itself ("Next
// time:", rule 15 in prompt.js), and a plan has no closing line.
// closed() is a written text with its closing line; closingOf() reads a closed text back for the rule checks.
import { DECLINED } from './explain.js';
import { claimsIn, verify } from './concepts.js';
import { PICKER, PLAN_PICKER } from './prompt.js';
import { RULE_POOL } from './rules.js';

const RULES = new Map(RULE_POOL.map(r => [r.id, r.rule]));
const TIE = 12, ADVICE = 15; // the most words a "Here:" tie and an advice line may run to
const count = s => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;

/** The advice line's start, "Next time:" (bold or not), at a line start; and what a streamed line may yet grow into. */
const NEXT = /^\**Next time:\**/m;
const STARTS = ['**Next time:', 'Next time:'];
/** The line that ends a plan with a second move, "**Also good:**" (bold or not), at a line start. */
const ALSO = /^\**Also good:/;

/** The text `write(onText)` writes (the writer's call, streaming to the `onText` it is handed), with its closing
    line. `sheet` is the writer's fact sheet or plan sheet (a plan sheet has "best"). Beside the writer, `model` picks
    the rule line for it: one `llm(PICKER, sheet, model)` call, PLAN_PICKER for a plan sheet, and no call for a
    tactical plan (stage 0: no rule on 16 of 16). In an answer the rule line takes the place of the advice line, or goes
    after the last line when there is none. In a plan it is a block of its own, before the "Also good:" line when the
    plan has one, else last. No rule line, a decline or no text: the text as written. `onText` hears the stream only up
    to the advice line (a last line that may yet become one is held back too), then the closed text, so the closing
    line shows once, never swapped. */
export async function closed(write, sheet, llm, model, onText) {
  const plan = !!sheet.best;
  const [text, rule] = await Promise.all([write(onText && (t => onText(beforeAdvice(t)))),
    plan && sheet.plan_kind === 'tactical' ? null : ruleLine(sheet, llm, model, plan ? PLAN_PICKER : PICKER)]);
  const out = placed(text, rule, plan);
  onText?.(out);
  return out;
}

/** The rule line for `sheet`: the picker (`prompt`) picks at most one rule of thumb of RULE_POOL. A pick counts only
    with a pool id, kind "follows" or "bent", a "here" tie of 1 to TIE words and board checks that all hold (verify());
    a followed rule comes before a bent one. Returns "Rule: <the pool's sentence>\nHere: <tie>" ("Rule bent: ..." for a
    bent one), or null when no pick holds or anything fails: the picker never fails an answer or a plan. closingOf()
    reads this format. */
async function ruleLine(sheet, llm, model, prompt) {
  try {
    const picks = (claimsIn(await llm(prompt, sheet, model)) ?? [])
      .filter(c => RULES.has(c.rule) && count(c.here) >= 1 && count(c.here) <= TIE);
    const held = verify(sheet, picks).filter(c => c.verified);
    const pick = held.find(c => c.kind === 'follows') ?? held.find(c => c.kind === 'bent');
    if (!pick) return null;
    const rule = RULES.get(pick.rule);
    return `${pick.kind === 'follows' ? 'Rule' : 'Rule bent'}: ${rule[0].toLowerCase()}${rule.slice(1)}\nHere: ${String(pick.here).trim()}`;
  } catch {
    return null;
  }
}

/** Streamed text up to its advice line; a last line that may yet become one is held back too. */
function beforeAdvice(text) {
  const m = NEXT.exec(text);
  if (m) return text.slice(0, m.index);
  const last = text.slice(text.lastIndexOf('\n') + 1);
  return last && STARTS.some(s => s.startsWith(last)) ? text.slice(0, -last.length) : text;
}

/** `text` with the `rule` line in its place (see closed); `plan`: the text is a plan. */
function placed(text, rule, plan) {
  if (!rule || !text || text === DECLINED) return text;
  const lines = text.trimEnd().split('\n');
  if (plan) {
    const also = lines.findIndex(l => ALSO.test(l)), at = also < 0 ? lines.length : also;
    return [lines.slice(0, at).join('\n').trimEnd(), rule, lines.slice(at).join('\n')].filter(Boolean).join('\n\n');
  }
  const i = lines.findIndex(l => NEXT.test(l));
  return (i < 0 ? [...lines, rule] : [...lines.slice(0, i), rule, ...lines.slice(i + 1)]).join('\n');
}

/** A closed text, read back for the rule checks. Returns {read, found}. `read` is what checkAnswer() (prompt.js)
    reads and counts: the text without a rule line's sentence, which is the pool's and not the writer's; the "Here:" tie
    stays. `found` is rule 15's problems, as checkAnswer()'s [{rule, problem}]: a tie over TIE words, an advice line
    that is not last or runs over ADVICE words. */
export function closingOf(answer) {
  const found = [];
  const flag = problem => found.push({ rule: 15, problem });
  const tie = count(answer.match(/^Here:(.*)$/m)?.[1]);
  if (tie > TIE) flag(`here ${tie} words`);
  const lines = answer.trim().split('\n'), advice = lines.findIndex(l => NEXT.test(l));
  if (advice >= 0 && advice < lines.length - 1) flag('advice not last');
  const words = advice >= 0 ? count(lines[advice].replace(NEXT, '')) : 0;
  if (words > ADVICE) flag(`advice ${words} words`);
  return { read: answer.replace(/^Rule( bent)?: .*\n(?=Here:)/m, ''), found };
}
