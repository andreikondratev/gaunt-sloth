import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';
import type { Terminal } from '@microsoft/tui-test';
import { settleSessionsAfterEach } from './fixtures/tmpHome.mjs';

settleSessionsAfterEach(test);

/**
 * [[REL-23]] PTY e2e: **the pinned checklist dock**, in a real terminal.
 *
 * Two nodes landed safety treatments on this panel — [[REL-18]] neutralising control characters
 * and [[REL-19]] redacting secrets — and both ran this suite green while it contained no checklist
 * case at all. That is the gap these cells close: `it-tui` was green about everything except the
 * thing those branches changed.
 *
 * **Why the panel needs a PTY cell and not only a unit spec.** The unit specs assert on an
 * `ink-testing-library` frame with `strip-ansi` applied, which removes escape sequences from the
 * string whether the code neutralised them or not — so they pin the treatment through the frame's
 * *text*. A real terminal is the only place the distinction is physical: an ESC that reached it
 * untreated is **consumed as an instruction** and never appears as text at all, and `ESC [ 2 A`
 * moves the cursor over content already painted. Here the neutralised row is asserted to be on
 * screen *as printable characters*, which is a claim only a terminal can settle.
 *
 * **Scope, stated so nobody reads more into these cells than they hold.** They cover the dock
 * mounting, its glyphs and position, and that both treatments survive into a real terminal. They do
 * **not** cover the redact-then-neutralise ORDERING, which `parseChecklistArgs` documents as
 * load-bearing: only a *configured literal* secret carrying a control character can tell the two
 * orderings apart, because the provider key patterns anchor on printable ASCII and are
 * order-insensitive. Reaching a configured literal here would mean a `.gsloth.config.mjs` fixture;
 * `spec/tui/checklistDockRedaction.spec.tsx` already pins the ordering and is the right home for it.
 */

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const fixture = (name: string): string => path.resolve(e2eDir, 'fixtures', name);

/** Build the child env — see `chat.tui.test.ts` for why `CI` is deleted rather than blanked. */
const envFor = (fixtureName: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CI;
  delete env.GTH_NO_TUI;
  env.TERM = 'xterm-256color';
  env.GTH_TUI_E2E_FIXTURE = fixture(fixtureName);
  return env;
};

const screenRows = (terminal: Terminal): string[] =>
  terminal
    .serialize()
    .view.split('\n')
    .slice(1, -1)
    .map((line) => line.replace(/^│/, '').replace(/│$/, ''));

/** The index of the row containing `needle`, or a failure carrying the frame that lacked it. */
const rowOf = (rows: string[], needle: string): number => {
  const at = rows.findIndex((row) => row.includes(needle));
  if (at === -1) {
    throw new Error(`"${needle}" is not on screen; frame was:\n${rows.join('\n')}`);
  }
  return at;
};

/**
 * The header is asserted by its WORDS, never by the `📋` that precedes them: the glyph is
 * double-width and how a terminal accounts for that column is exactly the kind of detail that
 * would make this fail for a reason unrelated to the panel.
 */

test.describe('gth chat TUI — the pinned checklist dock (REL-23)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('rel23-checklist-dock.json'),
    columns: 100,
    rows: 40,
  });

  test('pins the checklist between the turn and the input dock, with a row per status', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('go');
    await expect(terminal.getByText('> go')).toBeVisible();
    terminal.submit();

    // The whole turn, committed: the fixture's closing text run is the last thing it streams.
    await expect(terminal.getByText('rel23-answer-line')).toBeVisible();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();

    // The dock mounted, and the count is the panel's own arithmetic over the three rows.
    //
    // This header exists NOWHERE else on screen, and that is structural rather than lucky:
    // `drawsNothing` in `viewModel.ts` returns true for the checklist tool call and
    // `displaySegments` drops the segment, so the call paints nothing inside the turn. If the
    // panel did not mount, nothing would carry these words.
    await expect(terminal.getByText('Checklist (1/3)')).toBeVisible();

    const rows = screenRows(terminal);

    // One row per status, each with the glyph its status maps to. Asserted as "the row carrying
    // this item's text also carries this glyph" rather than as a whole-line equality, which would
    // pin the panel's indentation rather than its content.
    expect(rows[rowOf(rows, 'rel23-row-done')]).toContain('[x]');
    expect(rows[rowOf(rows, 'rel23-row-active')]).toContain('[~]');
    expect(rows[rowOf(rows, 'rel23-row-todo')]).toContain('[ ]');

    // PINNED is a claim about position, and this is it: the panel sits BELOW the answer the turn
    // produced and ABOVE the input dock's status bar. A panel rendered inline with the turn would
    // sit above `rel23-answer-line`; one that had drifted out of the dock would sit below the
    // status bar. Neither ordering survives here.
    const answer = rowOf(rows, 'rel23-answer-line');
    const panel = rowOf(rows, 'Checklist (1/3)');
    const statusBar = rowOf(rows, 'chat  ·  turns: 1  ·  ready');
    expect(answer).toBeLessThan(panel);
    expect(panel).toBeLessThan(statusBar);
  });
});

test.describe('gth chat TUI — a checklist row carrying hostile bytes and a key (REL-23)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('rel23-checklist-treated.json'),
    columns: 100,
    rows: 40,
  });

  /**
   * The fixture's single row carries, as REAL bytes in the streamed tool args:
   *
   * - `ESC [ 31 m` — SGR, the colour a forgery beside the prompt would be painted in;
   * - `ESC [ 2 A` — cursor movement, which is what turns colour into *placement*;
   * - `BEL` — a bare control character that is not part of an escape sequence;
   * - `sk-EXAMPLEONLY…` — a provider-key-SHAPED literal. **It is synthetic**: it matches
   *   `\bsk-[A-Za-z0-9_-]{16,}` and nothing else about it is a key. No value here is read from the
   *   environment, and nothing is asserted by comparison against a real key.
   *
   * Treated, the row reads `rel23-treated \x1b[31m \x1b[2A \x07 <redacted> end` — 56 columns with
   * the glyph prefix, comfortably inside the 100 this suite runs at, so no assertion below can be
   * split across a wrap.
   */
  test('paints the escapes as printable text and the key as the withheld marker', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    terminal.write('go');
    await expect(terminal.getByText('> go')).toBeVisible();
    terminal.submit();

    await expect(terminal.getByText('rel23-treated-answer')).toBeVisible();
    await expect(terminal.getByText('chat  ·  turns: 1  ·  ready')).toBeVisible();

    // Anchors. Without them every assertion below would pass just as well against a dock that
    // never mounted the checklist at all — an absent escape sequence and an absent panel look
    // identical to a `not.toContain`.
    await expect(terminal.getByText('Checklist (0/1)')).toBeVisible();

    const rows = screenRows(terminal);
    const row = rows[rowOf(rows, 'rel23-treated ')];

    // Neutralised: every escape is ON SCREEN AS TEXT. This is the assertion the PTY exists for.
    // Untreated, the terminal would have EXECUTED these bytes — the SGR setting a colour, the
    // `[2A` moving the cursor back over two painted lines — and none of them would appear here.
    expect(row).toContain('\\x1b[31m');
    expect(row).toContain('\\x1b[2A');
    expect(row).toContain('\\x07');

    // Redacted: the marker replaced the key-shaped literal in place, and the row still reads.
    expect(row).toContain('<redacted>');
    expect(row).toContain('end');

    // And the literal is gone from the WHOLE frame, not merely from the row — a cursor-movement
    // escape that executed could have repainted it anywhere on screen.
    expect(rows.join('\n')).not.toContain('EXAMPLEONLY');
  });
});
