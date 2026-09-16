import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@microsoft/tui-test';
import { settleSessionsAfterEach } from './fixtures/tmpHome.mjs';

/**
 * TUI-C55 — a shipped `gth chat --tui` run renders on React's PRODUCTION build.
 *
 * This is the whole point of the node, and it lives here rather than in the unit suite for two
 * reasons. A vitest process sets its own `NODE_ENV`, so React's build selection inside one says
 * nothing about a shipped run. And React only ever loads when the TUI actually renders, which
 * needs a real pty — asserting in a process where React was never loaded would be an assertion
 * that cannot fail.
 *
 * WHAT IS ASSERTED is the branch `react/index.js` took, captured by `fixtures/reactBuildProbe.mjs`.
 * Asserting `process.env.NODE_ENV === 'production'` instead would prove only that an assignment
 * ran — not that it ran before React was evaluated, which is the entire risk this node exists to
 * close. An assignment made one import too late looks identical from the env var and leaves the
 * development reconciler in place.
 *
 * The probe arrives through `NODE_OPTIONS=--import`, which keeps `packages/app/cli.js` as the
 * process's real main module with its real bootstrap; the probe adds an observer and imports
 * nothing that could influence the outcome.
 */

settleSessionsAfterEach(test);

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const probe = path.resolve(e2eDir, 'fixtures', 'reactBuildProbe.mjs');
const fixture = (name: string): string => path.resolve(e2eDir, 'fixtures', name);

const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-reactbuild-'));

/**
 * Build the child env, as the other suites here do (program mode does not merge `process.env`,
 * so it is spread in full; `CI` is deleted rather than blanked because Ink keys off the presence
 * of the key, not its value).
 *
 * `NODE_ENV` is deleted so the case starts from the state a user's shell is actually in — nothing
 * sets it — which is the state the entry point's guard reacts to. `nodeEnv` overrides it, for the
 * control case.
 *
 * A `file:` URL is handed to `--import` rather than a path: `NODE_OPTIONS` is parsed as a command
 * line, and a Windows path's backslashes do not survive that intact.
 *
 * `NODE_OPTIONS` is SET, not appended to. An inherited value would be concatenated into the same
 * shell-parsed string, where a quoted entry does not survive — and these cases need nothing the
 * caller might already have there. `--import` is on Node's NODE_OPTIONS allow-list (verified
 * against a control: `--eval=` in NODE_OPTIONS is refused, so the list is genuinely enforced here
 * rather than ignored).
 */
const envFor = (reportName: string, nodeEnv?: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CI;
  delete env.GTH_NO_TUI;
  delete env.NODE_ENV;
  env.TERM = 'xterm-256color';
  env.GTH_TUI_E2E_FIXTURE = fixture('greeting.json');
  env.GTH_E2E_REACT_BUILD_REPORT = path.join(reportDir, reportName);
  env.NODE_OPTIONS = `--import=${pathToFileURL(probe).href}`;
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  return env;
};

/**
 * Read back what the probe recorded. Returns '' when the file was never created, which is
 * treated as a failure by every caller rather than as an empty pass — a probe that never fired
 * is the one outcome that would make these assertions vacuous.
 */
const probeReport = (reportName: string): string => {
  const file = path.join(reportDir, reportName);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
};

test.describe('gth chat TUI — React build selection (default: nothing sets NODE_ENV)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('default.tsv'),
    columns: 100,
    rows: 30,
  });

  test('loads react.production, not react.development', async ({ terminal }) => {
    // Wait for a real Ink frame: React is loaded lazily, so the report is only meaningful once
    // something has actually rendered. Without this the case could read an empty file and pass.
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    const report = probeReport('default.tsv');

    // Non-vacuity first: the probe fired at all. If this ever fails, the assertions below are
    // meaningless rather than reassuring. (tui-test bundles jest's `expect`, which takes no
    // message argument — hence the bare matcher.)
    expect(report).toContain('react=');

    expect(report).toContain('react=production');
    expect(report).not.toContain('react=development');

    // The reconciler is where the render cost actually lands, and it makes its own independent
    // NODE_ENV decision — so it is asserted separately rather than assumed to follow React.
    expect(report).toContain('react-reconciler=production');
    expect(report).not.toContain('react-reconciler=development');
  });
});

test.describe('gth chat TUI — React build selection (operator sets NODE_ENV)', () => {
  test.use({
    program: { file: 'node', args: [cli, 'chat', '--tui'] },
    env: envFor('override.tsv', 'development'),
    columns: 100,
    rows: 30,
  });

  /**
   * The live control for the case above, and the guarantee that the entry point's assignment is
   * a default rather than a clobber. It is what keeps `NODE_ENV=test` meaningful for anyone
   * running from source, and it is also why the assertion above cannot be passing for a trivial
   * reason: the same harness, the same fixture and the same probe produce the opposite result
   * when the only thing that changes is the operator's value.
   */
  test('an explicit NODE_ENV still wins, and React follows it', async ({ terminal }) => {
    await expect(terminal.getByText('ready to chat')).toBeVisible();

    const report = probeReport('override.tsv');
    expect(report).toContain('react=');
    expect(report).toContain('react=development');
    expect(report).not.toContain('react=production');
  });
});
