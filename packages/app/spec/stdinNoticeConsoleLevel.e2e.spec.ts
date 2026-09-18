import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * REL-25 — `consoleLevel` decides the `reading STDIN` notice a PIPED run draws, and the decision is
 * made before the command line is parsed.
 *
 * **Why every cell here spawns the built CLI.** The thing under test is a startup ORDERING: the
 * notice is written by `readStdin` before `program.parseAsync()`, while the level a run ends up on
 * is applied from the merged config inside the command's action, after it. An in-process test
 * imports the writer and the level setter in whatever order it likes, so it can arrange the
 * ordering away and go green over a live bug — which is precisely the bug this node exists to
 * remove. Only a real process, fed a real pipe, answers the question.
 *
 * Hermetic and key-free: the `fake` provider replays a canned answer, so nothing reaches the
 * network and no API key is involved. `HOME`/`USERPROFILE` point at an empty temp dir so an
 * ambient `~/.gsloth` cannot decide an outcome, and `INIT_CWD` is dropped because the CLI prefers
 * it as its working directory (pnpm sets it to wherever `pnpm test` ran — the repository).
 *
 * Note what is deliberately NOT passed: `--nopipe`. Its whole job is to skip the piped-stdin wait,
 * which is the branch these cells are about. Requires the app build; `pnpm test` builds first.
 */
const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, '../cli.js'); // packages/app/cli.js (sets install dir, loads dist)

const FAKE_ANSWER = 'FAKE-REVIEW-REL25';
const PIPED_DIFF = 'diff --git a/a b/a\n';

/** The run header `gth review` opens with, which has to start at column 0 on every path. */
const RUN_HEADER = 'Gaunt Sloth · review';

/** The notice, its dots and the newline that closes them, with the header hard against it. */
const NOTICE_THEN_HEADER = new RegExp(`^reading STDIN\\.+\\n${RUN_HEADER}\\n`);

describe('reading STDIN notice vs consoleLevel (piped, process level)', () => {
  let dir: string;
  let home: string;

  /** Run the built CLI with a real pipe on stdin, in `dir`, with a throwaway home. */
  const runPiped = (args: string[] = ['review']): { stdout: string; stderr: string } => {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.INIT_CWD;
    const result = spawnSync('node', [cliEntry, ...args], {
      encoding: 'utf8',
      cwd: dir,
      env,
      input: PIPED_DIFF,
    });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  const writeProjectConfig = (config: Record<string, unknown>): void => {
    writeFileSync(resolve(dir, '.gsloth.config.json'), JSON.stringify(config));
  };

  const fakeLlm = { llm: { type: 'fake', responses: [FAKE_ANSWER] } };

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-stdin-notice-'));
    home = mkdtempSync(resolve(tmpdir(), 'gsloth-stdin-notice-home-'));
    mkdirSync(resolve(home, '.gsloth'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * The node's first acceptance. `display` is the rung issue #445 was reported from, and the one
   * the progress line's INFO tag is chosen against.
   */
  it('draws nothing at consoleLevel display — no label, no dots, header at column 0', () => {
    writeProjectConfig({ ...fakeLlm, consoleLevel: 'display' });

    const { stdout } = runPiped();

    expect(stdout).not.toContain('reading STDIN');
    expect(stdout.startsWith(RUN_HEADER)).toBe(true);
  });

  /**
   * `error` quietens the run header too, so the model's answer is the FIRST thing on stdout — which
   * says in one assertion that no label, no dot and no newline were written ahead of it.
   */
  it('draws nothing at consoleLevel error either — every rung above display is quiet', () => {
    writeProjectConfig({ ...fakeLlm, consoleLevel: 'error' });

    const { stdout } = runPiped();

    expect(stdout).not.toContain('reading STDIN');
    expect(stdout.startsWith(FAKE_ANSWER)).toBe(true);
  });

  /**
   * The second and third acceptances together, as one byte assertion: at the default level the
   * notice is unchanged — the label, a dot per chunk, and the newline `stop()` writes — and the run
   * header follows it at column 0 rather than being appended to the dots. The dot COUNT is pinned
   * exactly, per chunk, by `packages/core/spec/progressGatingStdinSite.spec.ts`; how many chunks a
   * pipe delivers is the operating system's business, so it is the one thing left open here.
   */
  it('is byte-for-byte unchanged at the default level, newline included', () => {
    writeProjectConfig(fakeLlm);

    const { stdout } = runPiped();

    expect(stdout).toMatch(NOTICE_THEN_HEADER);
  });

  /**
   * CONTROL — the quiet cells above are quiet because of the value in the config, not because of
   * anything else about a spawned piped run. Without a level set, the same run in the same shape
   * still draws the line.
   */
  it('still draws the line when no config sets a level', () => {
    writeProjectConfig(fakeLlm);

    const { stdout } = runPiped();

    expect(stdout).toContain('reading STDIN');
  });

  /**
   * The early read has to answer for the config the RUN will use, which `-c` chooses. A reader that
   * ignored it would quieten (or fail to quieten) against a file this run never loads.
   */
  it('honours -c when deciding, and reads the level out of the named file', () => {
    writeProjectConfig(fakeLlm);
    const namedConfig = resolve(dir, 'quiet.json');
    writeFileSync(resolve(namedConfig), JSON.stringify({ ...fakeLlm, consoleLevel: 'display' }));

    const { stdout } = runPiped(['-c', namedConfig, 'review']);

    expect(stdout).not.toContain('reading STDIN');
  });

  /**
   * The global layer answers when no project config does — the same layering the run itself
   * resolves `consoleLevel` on, so the level in force before the parse is the level in force after
   * it.
   */
  it('reads the level from the global config when the project sets none', () => {
    writeFileSync(
      resolve(home, '.gsloth', '.gsloth.config.json'),
      JSON.stringify({ ...fakeLlm, consoleLevel: 'display' })
    );

    const { stdout } = runPiped();

    expect(stdout).not.toContain('reading STDIN');
  });

  /**
   * An unusable value is "nobody set a level" here, exactly as it is for the merge — so the run
   * stays at the default and the line is drawn. The warning that names the bad value is written
   * ONCE, by the merge; a pre-parse reader that reported it too would say it twice for one config.
   */
  it('leaves the default in force for an unusable level, and does not warn twice', () => {
    writeProjectConfig({ ...fakeLlm, consoleLevel: 'quiet-please' });

    const { stdout, stderr } = runPiped();

    expect(stdout).toMatch(NOTICE_THEN_HEADER);
    const both = `${stdout}${stderr}`;
    expect(both.split('Invalid consoleLevel').length - 1).toBe(1);
  });
});
