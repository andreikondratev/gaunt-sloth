import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@microsoft/tui-test';
import { removeTmpHome, settleSessionsAfterEach } from './fixtures/tmpHome.mjs';
import { LOOKUP_PROMPT, RECALL_MARKER } from './fixtures/resume-recall.gsloth.config.mjs';

/**
 * GS2-88 — `/history` and `/reasoning` on the PLAIN READLINE surface, through the real binary.
 *
 * The unit cells prove the wiring; this proves the shipped `dist` actually does it, on the surface
 * a user lands on whenever the Ink TUI cannot run. The two describes are a pair: both seed the
 * same real store under a throwaway HOME with a real `gth code` run, and the only difference
 * between them is `history.enabled` in the config the session is opened with. On the unfixed code
 * both sessions printed the identical "no local session history, check your config" body, so the
 * pair could not have passed — a cell that only looked at the switched-off side could, which is
 * why it is written as a pair.
 */

// [[GS2-20]] — see chat.tui.test.ts: settle each session before the throwaway directories go.
settleSessionsAfterEach(test);

// tui-test keeps process.cwd() at the invocation dir (this folder); the cli lives one level up.
const e2eDir = process.cwd();
const cli = path.resolve(e2eDir, '..', 'cli.js');
const fixture = (name: string): string => path.resolve(e2eDir, 'fixtures', name);
const recordingConfig = fixture('resume-recall.gsloth.config.mjs');
const historyOffConfig = fixture('history-off-readline.gsloth.config.mjs');

/**
 * A REAL session (no fixture agent) with HOME and USERPROFILE pointed at a throwaway dir, so the
 * history store this session opens is its own and the developer's real `~/.gsloth/history.db` is
 * never read or written.
 */
const realSessionEnv = (tmpHome: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CI;
  delete env.GTH_NO_TUI;
  delete env.GTH_TUI_E2E_FIXTURE;
  env.TERM = 'xterm-256color';
  env.HOME = tmpHome;
  env.USERPROFILE = tmpHome;
  return env;
};

/**
 * One real recorded conversation in a store that did not exist a moment ago, written by a real
 * process rather than by this file — seeded with `spawnSync` because the PTY harness gives a
 * describe one program. Asserted to have worked, so a broken seed fails as itself.
 */
const seedOneConversation = (tmpHome: string): void => {
  const seed = spawnSync('node', [cli, 'code', '--nopipe', '-c', recordingConfig], {
    input: `${LOOKUP_PROMPT}\n`,
    encoding: 'utf8',
    cwd: e2eDir,
    env: { ...realSessionEnv(tmpHome) } as NodeJS.ProcessEnv,
  });
  const output = `${seed.stdout ?? ''}${seed.stderr ?? ''}`;
  if (!output.includes(RECALL_MARKER)) {
    throw new Error(`the seeding session did not run a turn:\n${output}`);
  }
  if (!fs.existsSync(path.join(tmpHome, '.gsloth', 'history.db'))) {
    throw new Error('the seeding session wrote no history store');
  }
};

test.describe('gth code readline — /history reads the store, and /reasoning names the surface (GS2-88)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-hist-on-home-'));

  test.use({
    // No `--tui`: the fixture config turns it off, so this is the readline session.
    program: { file: 'node', args: [cli, 'code', '-c', recordingConfig] },
    env: realSessionEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.beforeAll(() => {
    seedOneConversation(tmpHome);
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  test('lists the seeded conversation, and blames nothing', async ({ terminal }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('/history');
    await expect(terminal.getByText('> /history')).toBeVisible();
    terminal.submit();

    await expect(terminal.getByText('Recent sessions')).toBeVisible();
    // The row the seeding process left: its command, and the prompt it recorded.
    await expect(terminal.getByText('[code]', { strict: false })).toBeVisible();
    await expect(terminal.getByText(LOOKUP_PROMPT, { strict: false })).toBeVisible();
    // Nothing here is a config problem, so nothing here names the config.
    await expect(terminal.getByText('history.enabled', { strict: false })).not.toBeVisible();
  });

  test('/reasoning after a committed turn says the surface keeps no record, not that there are none', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    // A real committed turn first, so the claim being refused is one the session could make.
    terminal.write('say something');
    await expect(terminal.getByText('> say something')).toBeVisible();
    terminal.submit();
    await expect(terminal.getByText('recall:', { strict: false })).toBeVisible();

    terminal.write('/reasoning');
    await expect(terminal.getByText('> /reasoning')).toBeVisible();
    terminal.submit();

    await expect(
      terminal.getByText('keeps no per-turn thinking record', { strict: false })
    ).toBeVisible();
    await expect(terminal.getByText('no committed turns', { strict: false })).not.toBeVisible();
  });
});

test.describe('gth code readline — /history names the config when the config is the reason (GS2-88)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-hist-off-home-'));

  test.use({
    // The SAME seeded store as the describe above; only `history.enabled` differs.
    program: { file: 'node', args: [cli, 'code', '-c', historyOffConfig] },
    env: realSessionEnv(tmpHome),
    columns: 120,
    rows: 40,
  });

  test.beforeAll(() => {
    seedOneConversation(tmpHome);
  });

  test.afterAll(() => {
    removeTmpHome(tmpHome);
  });

  test('says the config switched it off, and shows none of the rows the store holds', async ({
    terminal,
  }) => {
    await expect(terminal.getByText('ready to code')).toBeVisible();

    terminal.write('/history');
    await expect(terminal.getByText('> /history')).toBeVisible();
    terminal.submit();

    await expect(terminal.getByText('history.enabled', { strict: false })).toBeVisible();
    // The other half of the pair: the store is right there, and this session shows none of it.
    await expect(terminal.getByText(LOOKUP_PROMPT, { strict: false })).not.toBeVisible();
  });
});
