import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * OPS-123 — the pre-dispatch check that says a release is about to ship a blank GitHub Release
 * body.
 *
 * This is the BEHAVIOUR half of the pair. The wiring half
 * (releaseNotesWiredIntoRelease.spec.ts) asserts only that `validate-inputs` invokes the script;
 * it deliberately does not grep the workflow for the warning text, because such an assertion
 * passes whenever the string is present in the YAML, whatever the job would actually do — an
 * assertion that cannot fail, added to close exactly that kind of gap. Whether the warning fires
 * is proven here, by running the thing that fires it.
 *
 * Three properties carry the node's acceptance, and the third is the one most easily lost:
 *
 *  - a version with NO notes file produces a warning naming the exact file that was looked for.
 *    The exact name is the point: the convention replaces every dot with an underscore, and a file
 *    named anything else resolves to nothing while the pipeline reports it only by shipping an
 *    empty body;
 *  - a version WITH a notes file produces no warning. This is the control — a warning that fires
 *    on every release is one nobody reads — and it is asserted positively (the confirmation names
 *    the file found) as well as negatively, because an empty output would satisfy "no warning" for
 *    the wrong reason;
 *  - NOTHING here can fail a release. Every CLI path exits 0, including the paths where the check
 *    itself breaks. That is belt-and-braces with `continue-on-error` in the workflow, and the
 *    crash paths are exercised rather than merely swallowed — a swallowed crash is silence, which
 *    is the failure this node exists to fix.
 *
 * Paths are asserted through `join()` or through the separator-free file name, never as a POSIX
 * literal: comparing a `join()`ed value to a hardcoded `a/b` passes everywhere except win32, which
 * is the recurring shape of this repo's Windows-only unit failures.
 */

const HELPER = '../../../scripts/release-notes-preflight.mjs';
const HELPER_PATH = fileURLToPath(new URL(HELPER, import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REAL_CORE_PACKAGE_JSON = join(REPO_ROOT, 'packages', 'core', 'package.json');
const REAL_NOTES_DIR = join(REPO_ROOT, 'release-notes');

/** A version certain to have no notes file, in any notes directory. */
const VERSION_WITHOUT_NOTES = '99.0.0-nonesuch.1';
const FILE_WITHOUT_NOTES = 'v99_0_0-nonesuch_1.md';

const dirs: string[] = [];

/** A throwaway directory holding the given files. */
function tempDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'notes-preflight-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

/** Run the CLI, optionally with a GITHUB_STEP_SUMMARY file, and return everything it produced. */
function runCli(
  args: string[],
  { summaryFile }: { summaryFile?: string } = {}
): { status: number | null; stdout: string; stderr: string; summary: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  if (summaryFile) env.GITHUB_STEP_SUMMARY = summaryFile;
  const result = spawnSync(process.execPath, [HELPER_PATH, ...args], { encoding: 'utf8', env });
  let summary = '';
  if (summaryFile) {
    try {
      summary = readFileSync(summaryFile, 'utf8');
    } catch {
      summary = '';
    }
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, summary };
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('scripts/release-notes-preflight.mjs', () => {
  // Guards the `server.deps.external` entry in vitest.config.ts that keeps this helper OUT of
  // Vitest's inline transform, for the reason releaseNotesFor.spec.ts gives: the helper carries a
  // `#!` shebang, and inlined it is a hard `SyntaxError` on Windows and only on Windows. A real ESM
  // namespace exposes a non-configurable DATA property; Vitest's inlined exports object exposes a
  // configurable GETTER.
  it('imports the helper natively (externalized, not inlined by Vitest)', async () => {
    const mod = await import(HELPER);
    const descriptor = Object.getOwnPropertyDescriptor(mod, 'releaseNotesPreflight');
    expect(typeof descriptor?.value).toBe('function');
    expect(descriptor?.get).toBeUndefined();
    expect(descriptor?.configurable).toBe(false);
  });

  describe('the decision', () => {
    it('warns, naming the exact file it looked for, when there is no notes file', async () => {
      const { releaseNotesPreflight } = await import(HELPER);
      const dir = tempDir();
      const result = releaseNotesPreflight(VERSION_WITHOUT_NOTES, dir);

      expect(result.notesMissing).toBe(true);
      expect(result.notesPath).toBeUndefined();
      expect(result.expectedPath).toBe(join(dir, FILE_WITHOUT_NOTES));
      // The file NAME is what a dispatcher has to act on, and it is separator-free, so this holds
      // on win32 too.
      expect(result.annotation).toContain(FILE_WITHOUT_NOTES);
      expect(result.annotation).toContain(VERSION_WITHOUT_NOTES);
      expect(result.summary).toContain(FILE_WITHOUT_NOTES);
    });

    it('stays silent for a version that HAS a notes file', async () => {
      const { releaseNotesPreflight } = await import(HELPER);
      const dir = tempDir({ 'v9_9_9.md': '# v9.9.9\n\nSomething shipped.\n' });
      const result = releaseNotesPreflight('9.9.9', dir);

      expect(result.notesMissing).toBe(false);
      expect(result.annotation).toBeUndefined();
      expect(result.summary).toBeUndefined();
      // Asserted positively as well: `annotation === undefined` alone would be satisfied by a
      // function that decided nothing at all.
      expect(result.notesPath).toBe(join(dir, 'v9_9_9.md'));
      expect(result.confirmation).toContain('9.9.9');
    });

    it('emits a warning annotation GitHub will render, on ONE line', async () => {
      const { releaseNotesPreflight, WARNING_TITLE } = await import(HELPER);
      const result = releaseNotesPreflight(VERSION_WITHOUT_NOTES, tempDir());

      expect(result.annotation.startsWith(`::warning title=${WARNING_TITLE}::`)).toBe(true);
      // A workflow command is terminated by a newline: one inside the message would truncate the
      // annotation and spill the rest into the log as plain text.
      expect(result.annotation).not.toContain('\n');
      // It must say it is not a blocker, or the dispatcher's reasonable response is to cancel a
      // release that is fine.
      expect(result.annotation).toContain('does NOT block');
    });

    it('escapes what would otherwise terminate the annotation early', async () => {
      const { escapeData } = await import(HELPER);
      expect(escapeData('a\nb')).toBe('a%0Ab');
      expect(escapeData('a\r\nb')).toBe('a%0D%0Ab');
      expect(escapeData('100%')).toBe('100%25');
    });

    it('names the path a human can act on, not the runner path', async () => {
      const { displayPath } = await import(HELPER);
      // Under the repo root: repo-relative, forward slashes on every platform.
      expect(displayPath(join(REPO_ROOT, 'release-notes', 'v1_0_0.md'))).toBe(
        'release-notes/v1_0_0.md'
      );
      // Outside it (a --dir pointing elsewhere): left as given rather than turned into `../../..`.
      const outside = join(tmpdir(), 'elsewhere', 'v1_0_0.md');
      expect(displayPath(outside)).toBe(outside);
    });
  });

  describe('the version it checks', () => {
    it('reads the same package.json the release job ships from', async () => {
      const { versionToShip, DEFAULT_CORE_PACKAGE_JSON } = await import(HELPER);
      // release.yml's "Read CURRENT version to ship" step runs
      // `require('./packages/core/package.json').version`. If these two ever name different files,
      // this check preflights a version other than the one that ships.
      expect(DEFAULT_CORE_PACKAGE_JSON).toBe(REAL_CORE_PACKAGE_JSON);
      // Compared against the file read at test time, never a version literal: a literal goes red
      // on the next post-bump, for a reason unrelated to this check.
      expect(versionToShip()).toBe(
        JSON.parse(readFileSync(REAL_CORE_PACKAGE_JSON, 'utf8')).version
      );
    });
  });

  describe('the CLI — it must never be the reason a release does not ship', () => {
    it('exits 0 and warns when the shipping version has no notes file', () => {
      const dir = tempDir();
      const summaryFile = join(tempDir(), 'summary.md');
      const run = runCli(['--version', VERSION_WITHOUT_NOTES, '--dir', dir], { summaryFile });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain('::warning title=');
      expect(run.stdout).toContain(FILE_WITHOUT_NOTES);
      expect(run.summary).toContain(FILE_WITHOUT_NOTES);
    });

    it('exits 0 and emits NO warning when the shipping version has notes', () => {
      const dir = tempDir({ 'v9_9_9.md': '# v9.9.9\n\nSomething shipped.\n' });
      const summaryFile = join(tempDir(), 'summary.md');
      const run = runCli(['--version', '9.9.9', '--dir', dir], { summaryFile });

      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain('::warning');
      expect(run.summary).not.toContain('::warning');
      expect(run.summary).not.toContain('⚠️');
      // Positive half of the control: the OK path is not silent, it confirms. A run page showing
      // neither this nor a warning is a broken mechanism, and that must be distinguishable from a
      // clean release.
      expect(run.stdout).toContain('v9_9_9.md');
      expect(run.summary).toContain('v9_9_9.md');
    });

    it('checks the real repo against the real release-notes directory', () => {
      // No --version and no --dir: exactly what the workflow runs. Whichever branch today's
      // version falls on, the CLI succeeds and says which.
      const run = runCli([]);
      const version = JSON.parse(readFileSync(REAL_CORE_PACKAGE_JSON, 'utf8')).version;

      expect(run.status).toBe(0);
      expect(run.stdout).toContain(version);
      expect(run.stdout).toContain(`v${version.replaceAll('.', '_')}.md`);
    });

    it('exits 0 when the notes directory does not exist', () => {
      const run = runCli(['--version', '9.9.9', '--dir', join(tempDir(), 'absent')]);
      // A missing directory is the same answer as a missing file — no notes — not a crash.
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('::warning title=');
    });

    it('exits 0 when the package.json cannot be read', () => {
      const run = runCli(['--package-json', join(tempDir(), 'absent', 'package.json')]);
      expect(run.status).toBe(0);
      // A `::notice`, not a `::warning`: the check did not run, which is a different statement
      // from "the notes are absent", and conflating them would teach the reader to discount both.
      expect(run.stdout).toContain('::notice title=');
      expect(run.stdout).not.toContain('::warning');
    });

    it('exits 0 when the package.json parses but carries no version', () => {
      const dir = tempDir({ 'package.json': '{"name":"x"}' });
      const run = runCli(['--package-json', join(dir, 'package.json')]);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('::notice title=');
    });

    it('exits 0 on an unrecognised argument', () => {
      const run = runCli(['--no-such-flag']);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('::notice title=');
      // Single line, or it truncates the annotation. The usage string is quoted into it.
      const notice = run.stdout.split('\n').find((line) => line.startsWith('::notice'));
      expect(notice).toContain('usage:');
      expect(notice).toContain('--no-such-flag');
    });

    it('does not write a job summary when GITHUB_STEP_SUMMARY is unset', () => {
      // The script is also runnable by hand, outside Actions, where appending to an undefined path
      // would throw — and a throw on the OK path would be a release-blocking crash in the making.
      const dir = tempDir();
      const run = runCli(['--version', VERSION_WITHOUT_NOTES, '--dir', dir]);
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
    });
  });

  describe('the notes directory it defaults to', () => {
    it('is the repo release-notes/ directory', async () => {
      const { releaseNotesPreflight } = await import(HELPER);
      // Driven with no notes dir, so the default is what resolves. The real directory holds
      // v1_0_0.md, so this also proves the default points somewhere real rather than at an empty
      // path that would make every version look un-noted.
      const result = releaseNotesPreflight('1.0.0');
      expect(result.notesMissing).toBe(false);
      expect(result.expectedPath).toBe(join(REAL_NOTES_DIR, 'v1_0_0.md'));
    });
  });
});
