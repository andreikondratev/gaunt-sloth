// [[QA-15]] — **this module deliberately does NOT import `./expectTimeout.mjs`**, unlike most of
// the suite. That module's top-level await THROWS unless it is loaded under tui-test's own working
// directory and cache layout, which would make this file unimportable from the vitest spec that
// controls its locator. Nothing is lost: the matcher below runs in the test file's process, every
// `*.tui.test.ts` reaches `expectTimeout.mjs` directly or through `tmpHome.mjs`, and
// `spec/tuiE2eExpectTimeoutWired.spec.ts` is the gate that keeps that true.
import { expect } from '@microsoft/tui-test';

/**
 * [[QA-49]] — **typing on the plain readline surface only once it is ARMED for input.**
 *
 * Every PTY cell that drives a readline session (`gth code` / `gth chat` with the TUI off) waits
 * through this module before it writes, and the reason is a mechanism rather than a timing guess.
 *
 * ## Why the prompt, and not the message above it
 *
 * `Interface.question(prompt)` installs its line callback and THEN writes the prompt — the same
 * call does both, in that order. A line that arrives while no question is pending is **dropped**,
 * not buffered. Measured directly against `node:readline/promises`: a line written a tick before
 * `question()` is called never resolves it, while one written from the prompt's own output event
 * always does.
 *
 * So the prompt appearing is the only signal that input is being accepted, and it is a reliable
 * one, because the call that arms the handler is the call that writes it. **Anything printed
 * earlier is not a readiness signal at all** — `Gaunt Sloth is ready to code` included. On this
 * surface a turn is not over when answer text appears either: after the answer stream come the
 * termination notice, the run-end report and the history write, with the Esc watcher owning stdin
 * until the agent's stream `finally` releases it. A line typed in that window is swallowed. A fast
 * machine hides this because the prompt is redrawn before the answer marker is even polled for; a
 * loaded Windows runner does not, which is where it was found.
 *
 * **No timeout is the answer here.** A longer wait makes the window smaller without closing it,
 * and there is no number that can be sized against a runner this hardware cannot reproduce. If a
 * cell seems to want one, its readiness predicate is wrong.
 *
 * ## The three prompt shapes, and which one this covers
 *
 * `interactiveSessionModule.ts` reaches readline at three kinds of site, and only the first is
 * this helper's:
 *
 * 1. **The main input loop** — `rl.question(formatInputPrompt('  > '))`. The prompt is the `  > `
 *    row, so {@link EMPTY_PROMPT} is what says it is armed. **Use `typeAtPrompt` here.**
 * 2. **A question with its own visible prompt** — the retry question,
 *    `askLine('Do you want to try again with the same prompt? (y/n): ')`. That text is written by
 *    `question()` itself, so waiting for the text already is waiting for an armed prompt. Cells
 *    that wait for it are correct as they stand.
 * 3. **A question with an EMPTY prompt** — the approval menu and the attack banner, which hand
 *    readline `''` and write their own question line ([[EXT-105]], so the line cannot go out on
 *    readline's stream below the answer). Readline writes nothing, so there is no prompt row to
 *    wait for and {@link EMPTY_PROMPT} must not be used: it can only hang, or match a stale row on
 *    a surface that scrolls. **Those sites are nonetheless safe, and measured so** — production
 *    writes the question line and calls `askLine('')` with no `await` between the two statements,
 *    and `question()` registers its callback synchronously, so the handler is armed before the
 *    process can return to the event loop and read anything typed in response. Waiting for the
 *    question line there IS waiting for an armed prompt. Leave those cells on it.
 */

/**
 * **The readline input prompt, empty and accepting input.**
 *
 * A regex because tui-test resolves a locator against the buffer's rows — each padded out to the
 * full terminal width — joined into one string: `  >` followed by a run of spaces is an empty
 * prompt row, and cannot be the `  > something` row of a prompt that has already been typed into.
 * Twenty spaces is comfortably inside the narrowest terminal any cell in this suite opens.
 *
 * **The `g` flag is load-bearing, not stylistic.** tui-test resolves a regex locator through
 * `block.matchAll(pattern)`, and `String.prototype.matchAll` **throws a TypeError on a non-global
 * pattern** — so dropping it fails from inside the matcher's poll as a type error rather than as a
 * missing element, which reads like a broken harness rather than a broken locator.
 *
 * **What it does not distinguish**: rows are joined with no separator, so the padding after any
 * row's text looks exactly like the padding after a live prompt, and a row whose own text ENDS in
 * the marker would match. The one shape that would produce such a row is a prompt submitted empty,
 * which readline leaves on the screen — no readline cell in this suite does that, and one that
 * starts to must not rely on this locator afterwards.
 *
 * Shared as one module-level constant deliberately: `matchAll` copies the pattern before scanning
 * and never writes back to `lastIndex`, so repeated polls cannot make it drift. (A `.test()` call
 * on a global regex would, which is why the control in
 * `packages/app/spec/tuiE2eReadlinePromptLocator.spec.ts` scans with `matchAll` exactly as
 * tui-test does.)
 */
export const EMPTY_PROMPT = / {2}> {20}/gu;

/**
 * The minimum a terminal has to offer for {@link typeAtPrompt} to drive it.
 *
 * @typedef {object} WritableTerminal
 * @property {(text: RegExp | string, options?: { strict?: boolean }) => unknown} getByText
 * @property {(text: string) => void} write
 */

/**
 * Wait for the readline prompt to be back and armed, then type.
 *
 * `strict: false` because this asserts such a row EXISTS, not that it is unique — a session that
 * has scrolled may hold more than one.
 *
 * @param {WritableTerminal} terminal
 * @param {string} line
 * @returns {Promise<void>}
 */
export const typeAtPrompt = async (terminal, line) => {
  await expect(terminal.getByText(EMPTY_PROMPT, { strict: false })).toBeVisible();
  terminal.write(line);
};

/**
 * The other half of {@link typeAtPrompt}, for a cell that demonstrates the locator DISCRIMINATES:
 * once the prompt has been typed into, the row no longer reads as an armed empty prompt.
 *
 * A readiness signal that were always true would "fix" every cell in this suite while changing
 * nothing, so at least one cell asserts this in a real terminal rather than taking it on trust.
 *
 * @param {WritableTerminal} terminal
 * @returns {Promise<void>}
 */
export const expectPromptTypedInto = async (terminal) => {
  await expect(terminal.getByText(EMPTY_PROMPT, { strict: false })).not.toBeVisible();
};
