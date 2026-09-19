import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';
import { settleSessionsAfterEach } from './fixtures/tmpHome.mjs';

// [[GS2-20]] — settle each session before its throwaway directory is removed (see tmpHome.mjs).
settleSessionsAfterEach(test);

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const fixture = (name: string): string => path.resolve(e2eDir, 'fixtures', name);

/**
 * Build the child env. Program mode does NOT merge process.env, so we spread it in full, and `CI`
 * is DELETED rather than blanked: Ink keys its non-interactive renderer off the presence of that
 * key, so `CI=""` would mean the frame never paints. Same helper, and the same reasons, as
 * `chat.tui.test.ts`.
 */
const envFor = (fixtureName: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CI;
  delete env.GTH_NO_TUI;
  env.TERM = 'xterm-256color';
  env.GTH_TUI_E2E_FIXTURE = fixture(fixtureName);
  return env;
};

/**
 * TUI-C107 — Esc on a MAXIMISED, focused debug pane.
 *
 * The defect these cells pin: Esc dropped focus and left the pane maximised, which is a trap rather
 * than an awkward state. The prompt is unmounted while the pane holds focus and has no rows left to
 * draw in while the pane is maximised, and `m` — the key that would undo the maximisation — is
 * handled inside the focused-only branch, so once Esc had dropped focus nothing on the keyboard
 * reached the session. Measured before the fix: after the sequence below, typing `hello` echoed
 * nowhere on screen (it went into the mounted-but-clipped prompt buffer, invisibly).
 *
 * Both cells run at 100x30, matching the search suite in `chat.tui.test.ts`. That is deliberately
 * NOT the 24-row terminal of [[TUI-C103]]: that node is about the maximised pane's chrome constant
 * overflowing a short terminal, a different defect in the same view, and a 24-row cell here would
 * measure it instead of this.
 *
 * The viewport footer is the discriminator for the maximise state and is read directly:
 * `debugViewportHeight()` gives 8 rows docked and `rows - DEBUG_MAX_CHROME_ROWS` = 21 maximised, so
 * the footer reads `1-8/42` restored and `1-21/42` maximised over the 42-line fixture capture.
 */
test.describe('gth chat TUI — Esc leaves a maximised debug pane in one press (TUI-C107)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('search.json'),
    columns: 100,
    rows: 30,
  });

  test('restores the view and hands the prompt back, with no second Tab', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('go');
    await expect(terminal.getByText('> go')).toBeVisible();
    terminal.submit();
    // Turn completes, so the panel has the subagent capture to show.
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();

    // The reported sequence: /debug · Tab · m · Esc.
    terminal.write('/debug');
    await expect(terminal.getByText('> /debug')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('Subagents')).toBeVisible();
    // Docked: the viewport is 8 rows, and the legend is the unfocused one.
    await expect(terminal.getByText('1-8/42')).toBeVisible();

    terminal.write('\t'); // Tab → focus the pane
    await expect(terminal.getByText('Tab: section')).toBeVisible();

    terminal.write('m'); // maximise
    // GATE, not decoration: without proving the pane actually maximised, a dropped or early `m`
    // would leave Esc doing nothing but unfocus — the prompt would come back for the wrong reason
    // and the cell would pass against the unfixed code. Both halves of the maximised state are
    // asserted: the grown viewport and the legend that offers `restore`.
    await expect(terminal.getByText('1-21/42')).toBeVisible();
    await expect(terminal.getByText('m: restore')).toBeVisible();

    terminal.write('\x1b'); // Esc — ONE press

    // The maximised view is gone: the viewport is back to its docked 8 rows.
    await expect(terminal.getByText('1-8/42')).toBeVisible();
    // Focus is gone with it: the pane offers the unfocused legend and the status bar the way back.
    await expect(terminal.getByText('[/debug to hide]')).toBeVisible();
    await expect(terminal.getByText('Tab: focus debug panel')).toBeVisible();

    // And the session has the keyboard back: the prompt is drawn and takes input, with no second
    // Tab and no `m` in between. This is the assertion Andrew's report asks for — "exit max view
    // and the user gets control back" — and it is about what is ON SCREEN, because before the fix
    // the prompt was mounted the whole time and simply had no rows to be seen in.
    terminal.write('hello');
    await expect(terminal.getByText('> hello')).toBeVisible();
  });

  test('clears an active search first, then leaves on the next press', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    terminal.write('go');
    await expect(terminal.getByText('> go')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();

    terminal.write('/debug');
    await expect(terminal.getByText('> /debug')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('Subagents')).toBeVisible();
    terminal.write('\t'); // Tab → focus the pane
    await expect(terminal.getByText('Tab: section')).toBeVisible();
    terminal.write('m'); // maximise
    await expect(terminal.getByText('1-21/42')).toBeVisible();

    // Search inside the maximised pane: `/` opens the query, "30" matches the single line-30, and
    // Enter confirms it — so the query is live while the pane is NOT in input mode, which is the
    // state whose Esc goes through the layering branch below rather than the search-input branch.
    terminal.write('/');
    await expect(terminal.getByText('type to search')).toBeVisible();
    terminal.write('3');
    terminal.write('0');
    await expect(terminal.getByText('1/1')).toBeVisible();
    // The caret the pane draws only while the query is being TYPED. Asserted present here and
    // absent after Enter, as a pair: the positive is what proves the glyph renders on this
    // platform, so the negative below is a statement about input mode rather than about a
    // character that never appeared.
    await expect(terminal.getByText('30▏')).toBeVisible();
    terminal.submit(); // Enter → confirm the query, keep the highlights
    // Enter landed: the query is still live, but the pane has left input mode. Without this the
    // Esc below could be answered by the SEARCH-INPUT branch instead of the layering branch this
    // cell is about, and the cell would pass having exercised something else.
    await expect(terminal.getByText('30▏')).not.toBeVisible();
    await expect(terminal.getByText('Esc: clear search')).toBeVisible();

    // Esc #1 clears the search and NOTHING ELSE. The pane is still maximised and still focused —
    // both read off one legend substring, which is what pins the ORDER of the two undos rather
    // than just their eventual arrival.
    terminal.write('\x1b');
    await expect(terminal.getByText('m: restore · Esc: unfocus')).toBeVisible();
    // The same claim again, off the viewport rather than off the legend: the search jumped the
    // pane to its last page and clearing the query deliberately leaves the scroll where it is
    // (TUI-C21), so the maximised height shows here as a 21-row span, not as `1-21/42`.
    await expect(terminal.getByText('22-42/42')).toBeVisible();
    await expect(terminal.getByText('1/1')).not.toBeVisible();

    // Esc #2 is then the exit: restored, unfocused, keyboard back — the single press of the first
    // cell, one layer down. Each press left the keyboard usable: the first inside the pane (the
    // legend above is the focused one), the second in the session.
    terminal.write('\x1b');
    // Back to a docked 8-row span, from the same scroll position — 22-29 rather than 22-42.
    await expect(terminal.getByText('22-29/42')).toBeVisible();
    await expect(terminal.getByText('[/debug to hide]')).toBeVisible();
    terminal.write('hi');
    await expect(terminal.getByText('> hi')).toBeVisible();
  });
});
