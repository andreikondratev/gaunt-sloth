import path from 'node:path';
import { readFileSync } from 'node:fs';
import { test, expect, EXPECT_TIMEOUT_MS } from './fixtures/harness.mjs';
import { settleSessionsAfterEach } from './fixtures/tmpHome.mjs';

settleSessionsAfterEach(test);

// The runner runs the suite with this folder as process.cwd(); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const fixture = (name: string): string => path.resolve(e2eDir, 'fixtures', name);

/** See `chat.tui.test.ts` for why `CI` is deleted rather than blanked. */
const envFor = (fixtureName: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CI;
  delete env.GTH_NO_TUI;
  env.TERM = 'xterm-256color';
  env.GTH_TUI_E2E_FIXTURE = fixture(fixtureName);
  return env;
};

/** The text `fixtures/expect-timeout.json` streams, after its `delayMs`. */
const LATE_MARKER = 'QA15-LATE-MARKER';

/**
 * The delay the fixture holds the marker back by. It has to sit strictly between the library's
 * 5000 ms fallback and the configured bound, with room on both sides: too small and the case passes
 * under either bound and proves nothing; too large and it eats into the per-test timeout.
 *
 * Read out of the fixture rather than restated here. A copy of the number would go green while the
 * fixture drifted underneath it, which is the one way the guard on it below could stop meaning
 * anything.
 */
const FIXTURE_DELAY_MS: number = JSON.parse(readFileSync(fixture('expect-timeout.json'), 'utf8'))
  .turns[0].delayMs;

/** The bound the harness declares, read from it rather than restated, so retuning it is one edit. */
const DECLARED_EXPECT_TIMEOUT = EXPECT_TIMEOUT_MS;

/**
 * [[QA-15]] — the suite's own expect timeout, pinned by an assertion that needs it.
 *
 * 5000 ms is the bound a matcher falls back to when the suite's own value does not reach it: it was
 * 0.0.4's fallback, and it is the default of the terminal engine's own `getByText().expect()`. Every
 * case here asserts through `fixtures/harness.mjs`, whose `toBeVisible` reads `EXPECT_TIMEOUT_MS`;
 * this file is what proves that bound actually binds, and the proof has to be an assertion that
 * genuinely needs longer than 5 s.
 *
 * **A green suite is not evidence for this.** A matcher that resolves in 200 ms resolves
 * identically under 5 s and under 15 s, so every other case in this suite would pass unchanged if
 * the bound stopped reaching the matcher. Only a wait that exceeds 5000 ms can tell the two apart,
 * which is why this case deliberately costs about twelve seconds. Nothing else here is allowed to be
 * that slow.
 *
 * The assertions cover different things and none of them is redundant:
 *
 * - the marker becomes visible at all — proves the matcher really waited past 5 s, which is the
 *   one thing a reading of the sources cannot establish;
 * - the wait really exceeded 5000 ms, and the fixture's own delay does too — without those,
 *   shortening the fixture's `delayMs` (or a fixture agent that stopped honouring it) would leave a
 *   case that passes under both bounds and quietly stops testing anything.
 */
test.describe('gth chat TUI — the configured expect timeout binds in the worker', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('expect-timeout.json'),
    columns: 100,
    rows: 30,
  });

  test('a matcher waits the configured bound, not the 5 s library fallback', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();
    // Type, confirm the echo, then send Enter separately — Ink coalesces a "text\r" single write
    // into one input event, so the return must be its own keystroke.
    terminal.write('go');
    await expect(terminal.getByText('> go')).toBeVisible();

    // The fixture's clock starts here, on submit, so the wait below is measured from inside the
    // test body and does not depend on how long the harness took to get here.
    const submittedAt = Date.now();
    terminal.submit();
    await expect(terminal.getByText(LATE_MARKER)).toBeVisible();
    const waitedMs = Date.now() - submittedAt;

    expect(FIXTURE_DELAY_MS).toBeGreaterThan(5_000);
    // Bounded from above as well, so the fixture stays inside the window this case needs rather
    // than only outside the old bound. Asserted from one side, retuning the configured timeout
    // downwards would leave the delay above it, and the case would fail as though the timeout had
    // stopped binding — a true assertion pointing at the wrong defect, which is worse than a
    // missing one. The guard names the real constraint instead: the delay sits between the two.
    expect(FIXTURE_DELAY_MS).toBeLessThan(DECLARED_EXPECT_TIMEOUT as number);
    expect(waitedMs).toBeGreaterThan(5_000);
  });
});
