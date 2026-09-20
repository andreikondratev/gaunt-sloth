import { describe, expect, it } from 'vitest';
import { EMPTY_PROMPT } from '../tui-e2e/fixtures/readlinePrompt.mjs';

/**
 * [[QA-49]] — **the discrimination control for the readline prompt locator.**
 *
 * Every PTY cell that types into a readline session now waits for `EMPTY_PROMPT` before it writes,
 * on the mechanism `fixtures/readlinePrompt.mjs` documents: `rl.question()` arms its line handler
 * and then writes the prompt, and a line that arrives while no question is pending is dropped.
 *
 * A readiness signal that were **always true** would satisfy every one of those waits immediately
 * and "fix" the whole suite while changing nothing — which is the failure this file exists to rule
 * out. So the locator is asserted to match at an armed, untyped prompt and to STOP matching once
 * the prompt has been typed into. Its PTY half lives in the CFG-37 cell of
 * `tui-e2e/chat.tui.test.ts`, which asserts the same pair against a real xterm buffer; this half is
 * the one that can vary the input freely and name what actually distinguishes the two rows.
 *
 * **Scanned with `matchAll`, exactly as tui-test does.** `lib/terminal/locator.js` resolves a regex
 * locator through `Array.from(block.matchAll(this._text))`, so that is what is exercised here. Two
 * things ride on it: a non-global pattern makes `String.prototype.matchAll` throw a TypeError
 * rather than report no match (which is why the `g` flag is load-bearing), and `.test()` on a
 * global regex would advance `lastIndex` between calls and give this control an alternating,
 * meaningless answer.
 */

/** The two widths the readline describes in this suite actually open at. */
const COLUMNS = 100;
const WIDE = 120;

/**
 * One terminal row, padded to the full width the way xterm's buffer holds it.
 *
 * tui-test joins the rows into a single string with **no separator**, so the padding is not
 * cosmetic: it is the only thing that keeps the end of one row from running into the start of the
 * next, and it is what makes "a run of spaces after the marker" mean "nothing was typed here".
 */
const row = (text: string, columns: number = COLUMNS): string => text.padEnd(columns, ' ');

/** A block of rows, built the way `locator.js` builds the string it scans. */
const block = (...rows: string[]): string => rows.map((r) => row(r)).join('');

/** The same, at the width five of the six readline describes open. */
const wideBlock = (...rows: string[]): string => rows.map((r) => row(r, WIDE)).join('');

/** What tui-test's locator does with a regex, and therefore what a locator's match really means. */
const matches = (pattern: RegExp, text: string): RegExpExecArray[] =>
  Array.from(text.matchAll(pattern)) as RegExpExecArray[];

/** The screen a readline session shows when it is waiting for the first line. */
const ARMED = block('', 'Gaunt Sloth is ready to chat. Type your prompt.', '', '  > ', '');

/** The same screen a moment later, with `exit` typed at the prompt and not yet submitted. */
const TYPED_INTO = block('', 'Gaunt Sloth is ready to chat. Type your prompt.', '', '  > exit', '');

describe('QA-49 the readline prompt locator discriminates an armed prompt from a typed one', () => {
  it('matches the armed, untyped prompt', () => {
    expect(matches(EMPTY_PROMPT, ARMED)).toHaveLength(1);
  });

  it('does not match once the prompt has been typed into', () => {
    // The whole point. Without this the locator could be a signal that is true from the moment the
    // session starts, every `typeAtPrompt` would return on its first poll, and the suite would read
    // as fixed while typing exactly as early as it did before.
    expect(matches(EMPTY_PROMPT, TYPED_INTO)).toHaveLength(0);
  });

  it('turns on the typed text and nothing else', () => {
    // A control on the control: the two blocks differ only by the four characters typed at the
    // prompt, so the assertions above cannot be passing because of some other difference between
    // two hand-written fixtures.
    expect(ARMED.replace(row('  > '), row('  > exit'))).toBe(TYPED_INTO);
  });

  it('is not satisfied by a single typed character', () => {
    // The boundary the cells actually race: the echo arrives one character at a time, and a
    // locator that needed the row to be *mostly* empty would go on matching part-way through a
    // write. One character is enough to mean the prompt is no longer empty.
    expect(matches(EMPTY_PROMPT, block('  > e'))).toHaveLength(0);
  });

  it('does not match a message that merely mentions a prompt marker', () => {
    // The readline surface replays a resumed conversation as `  > <what was typed>` rows, and
    // prints ordinary prose besides. Neither is a prompt that is waiting for input.
    expect(matches(EMPTY_PROMPT, block('  > what was the code', 'recall: 41'))).toHaveLength(0);
  });

  it('discriminates at 120 columns too, which is the width most of these sessions open', () => {
    // Every assertion above runs at 100 columns, which only the CFG-37 cell uses. The padding
    // grows with the width, so a locator could in principle depend on one and not the other.
    expect(matches(EMPTY_PROMPT, wideBlock('', '  > ', ''))).toHaveLength(1);
    expect(matches(EMPTY_PROMPT, wideBlock('', '  > what was the code', ''))).toHaveLength(0);
  });

  it('needs 23 columns, so a narrower session would wait forever rather than fail', () => {
    // The padding after the marker is what the locator reads, so the terminal has to be wide
    // enough to supply it. Below this the wait cannot be satisfied at all, and a `toBeVisible`
    // that can never pass times out as "the prompt never appeared" — a sentence that would send
    // the next reader looking at production. No session in this suite opens under 100.
    expect(matches(EMPTY_PROMPT, row('  > ', 23))).toHaveLength(1);
    expect(matches(EMPTY_PROMPT, row('  > ', 22))).toHaveLength(0);
  });

  it('would also match a row whose own text ENDS in the prompt marker', () => {
    // **A recorded limitation, not an endorsement.** Rows are joined with no separator, so the
    // padding that follows any row's text is indistinguishable from the padding after a live
    // prompt: a row ending in the marker reads as an armed prompt. Nothing on the readline
    // surface prints such a row today — the one shape that would is a prompt submitted empty,
    // which readline leaves on the screen, and no readline cell in this suite submits an empty
    // line. Asserted rather than left implicit so the next person to write one finds this
    // instead of a wait that is satisfied by a prompt that has already been answered.
    expect(matches(EMPTY_PROMPT, block('a line that ends in  >', '', '  > exit'))).toHaveLength(1);
  });

  it('keeps the g flag, without which tui-test cannot resolve the locator at all', () => {
    expect(EMPTY_PROMPT.flags).toContain('g');
    // Not a style assertion: this is the failure a locator written without the flag produces, and
    // it arrives from inside the matcher's poll where it reads as a broken harness rather than as
    // a prompt that never appeared. No cell in the suite used a regex locator before [[GS2-88]],
    // so there is no precedent to copy from and nothing to remind the next author.
    const nonGlobal = new RegExp(EMPTY_PROMPT.source, EMPTY_PROMPT.flags.replace('g', ''));
    expect(() => matches(nonGlobal, ARMED)).toThrow(TypeError);
  });

  it('gives the same answer on every scan, as a matcher polling it must', () => {
    // A global regex is scanned many times over the life of one `toBeVisible` poll. `matchAll`
    // copies the pattern and never writes back to `lastIndex`, so the shared module-level constant
    // cannot drift — whereas `.test()` would alternate true/false and make every wait a coin toss.
    expect(matches(EMPTY_PROMPT, ARMED)).toHaveLength(1);
    expect(matches(EMPTY_PROMPT, ARMED)).toHaveLength(1);
    expect(EMPTY_PROMPT.lastIndex).toBe(0);
  });
});
