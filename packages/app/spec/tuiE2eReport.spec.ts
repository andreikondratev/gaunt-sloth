import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  KNOWN_RESULTS_SCHEMA,
  SIGNATURE_CHARS,
  analyseRun,
  attemptErrors,
  decideVerdict,
  describeLeakReport,
  errorSignature,
  githubAnnotations,
  leakedDirs,
  repoPath,
  stepSummaryMarkdown,
} from '../tui-e2e-report.mjs';
import { RESULTS_SCHEMA } from '../tui-e2e-results-reporter.mjs';

/**
 * QA-13 — the PTY e2e flake reporter.
 *
 * `tui-e2e-report.mjs` reads the run's STRUCTURED result — the JSON `tui-e2e-results-reporter.mjs`
 * writes from vitest's reporter API, carrying each case's final state, retry count and errors — so a
 * *flaky* outcome escapes a green job. Nothing here parses terminal output.
 *
 * Every fixture is a REAL capture: the results file of a run of a deliberately-flaky /
 * deliberately-failing probe case through `run-tui-e2e.js` (kept with `GTH_E2E_RESULTS_COPY`), not
 * JSON written to match the reader. `no-tests-discovered.json` is the capture of a run whose filter
 * matched no file. Variations the runner cannot be made to produce on demand — a schema from the
 * future, an interrupted run, a file that failed to load — are derived from a capture by changing
 * one field, so each asserts on exactly that field.
 *
 * Fixtures are resolved as URLs throughout — a `D:\…` string is not a valid URL, and re-wrapping a
 * native path is what broke [[OPS-39]]'s guard on the Windows cells.
 */
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/tui-e2e-output/${name}`, import.meta.url), 'utf8');

const FAILED_AND_FLAKY = fixture('failed-and-flaky.json');
const FLAKY_ONLY = fixture('flaky-only.json');
const ALL_PASS = fixture('all-pass.json');
const NO_TESTS = fixture('no-tests-discovered.json');

/** A capture with one change applied, for the shapes a real run cannot be made to produce. */
const derive = (raw: string, change: (record: any) => void): string => {
  const record = JSON.parse(raw);
  change(record);
  return JSON.stringify(record);
};

describe('QA-13 tui-e2e flake reporter', () => {
  describe('the fixtures are real results', () => {
    // Anti-vacuity. A truncated or empty fixture would otherwise make the assertions below pass by
    // reading nothing into "no flakes" — the exact silence this whole module exists to prevent.
    it.each([
      ['failed-and-flaky', FAILED_AND_FLAKY, 2],
      ['flaky-only', FLAKY_ONLY, 1],
      ['all-pass', ALL_PASS, 1],
    ])('%s carries the schema and its cases', (_name, text, count) => {
      const record = JSON.parse(text);
      expect(record.schema).toBe(KNOWN_RESULTS_SCHEMA);
      expect(record.cases).toHaveLength(count);
      expect(record.modules.length).toBeGreaterThan(0);
    });

    it('no-tests-discovered is a well-formed result with no cases at all', () => {
      const record = JSON.parse(NO_TESTS);
      expect(record.schema).toBe(KNOWN_RESULTS_SCHEMA);
      expect(record.cases).toEqual([]);
    });

    it('the reader and the writer agree on the schema', () => {
      // Two constants in two files. A bump to one alone must red here, not turn every CI run into
      // "the flake check could not read the run report".
      expect(KNOWN_RESULTS_SCHEMA).toBe(RESULTS_SCHEMA);
    });
  });

  describe('analyseRun', () => {
    it('separates a genuine failure from a flake in the same run', () => {
      const result = analyseRun(FAILED_AND_FLAKY);

      expect(result.problem).toBeNull();
      expect(result.summary).toEqual({
        failed: 1,
        flaky: 1,
        didNotRun: 0,
        skipped: 0,
        passed: 1,
        total: 2,
      });
      expect(result.flaky).toEqual([
        {
          file: 'zzprobe.tui.test.ts',
          row: 21,
          column: 5,
          title: 'zzprobe › passes on the retry',
          errors: [
            'locator timeout: getByText(OPS153-NEVER-ON-SCREEN) resolved to 0 elements after 300 ms',
          ],
        },
      ]);
      expect(result.failed).toEqual([
        {
          file: 'zzprobe.tui.test.ts',
          row: 30,
          column: 5,
          title: 'zzprobe › is genuinely failing',
          errors: Array(3).fill(
            "expected 'this never holds' to be 'on any attempt' // Object.is equality"
          ),
        },
      ]);
    });

    it('reports a flake in an otherwise-green run', () => {
      const result = analyseRun(FLAKY_ONLY);

      expect(result.problem).toBeNull();
      expect(result.summary?.flaky).toBe(1);
      expect(result.summary?.failed).toBe(0);
      expect(result.flaky.map((entry) => entry.title)).toEqual(['zzprobe › passes on the retry']);
      expect(result.failed).toEqual([]);
    });

    it('finds nothing to report in a clean run', () => {
      const result = analyseRun(ALL_PASS);

      expect(result.problem).toBeNull();
      expect(result.summary?.passed).toBe(1);
      expect(result.flaky).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    it('takes a flake from the retry count, not only from the flaky flag', () => {
      // Either field alone is enough. vitest sets both today; reading only one would let a change
      // in how it fills the other turn a flake into a quiet pass.
      const countOnly = derive(FLAKY_ONLY, (r) => {
        r.cases[0].flaky = false;
      });
      expect(analyseRun(countOnly).flaky).toHaveLength(1);
      const flagOnly = derive(FLAKY_ONLY, (r) => {
        r.cases[0].retryCount = 0;
      });
      expect(analyseRun(flagOnly).flaky).toHaveLength(1);
      // The control: a pass with neither is no flake.
      const neither = derive(FLAKY_ONLY, (r) => {
        r.cases[0].flaky = false;
        r.cases[0].retryCount = 0;
      });
      expect(analyseRun(neither).flaky).toEqual([]);
    });

    it('never reports a case that failed every attempt as a flake, however many retries it took', () => {
      const result = analyseRun(FAILED_AND_FLAKY);
      expect(result.flaky.map((entry) => entry.title)).not.toContain(
        'zzprobe › is genuinely failing'
      );
    });

    it('counts a file that failed to load as a failure, since it contributes no cases', () => {
      const broken = derive(ALL_PASS, (r) => {
        r.modules.push({
          file: 'broken.tui.test.ts',
          state: 'failed',
          errors: ['SyntaxError: Unexpected token'],
        });
      });
      const result = analyseRun(broken);
      expect(result.problem).toBeNull();
      expect(result.summary?.failed).toBe(1);
      expect(result.failed).toEqual([
        {
          file: 'broken.tui.test.ts',
          row: null,
          column: null,
          title: '(file failed: SyntaxError: Unexpected token)',
          errors: ['SyntaxError: Unexpected token'],
        },
      ]);
    });
  });

  describe('it goes loud rather than quiet when it cannot tell what ran', () => {
    it('refuses to call a run clean when no tests were discovered', () => {
      const result = analyseRun(NO_TESTS);
      expect(result.problem).toMatch(/ran none of them/);
      expect(result.flaky).toEqual([]);
    });

    it('refuses a run in which every case was skipped', () => {
      const allSkipped = derive(ALL_PASS, (r) => {
        r.cases[0].state = 'skipped';
      });
      expect(analyseRun(allSkipped).problem).toMatch(/ran none of them/);
    });

    it('refuses a result that is not JSON', () => {
      expect(analyseRun('')).toMatchObject({ problem: expect.stringMatching(/not JSON/) });
      expect(analyseRun('{"schema": 1, "cases": [')).toMatchObject({
        problem: expect.stringMatching(/not JSON/),
      });
    });

    it('refuses a schema it does not know', () => {
      const future = derive(ALL_PASS, (r) => {
        r.schema = KNOWN_RESULTS_SCHEMA + 1;
      });
      expect(analyseRun(future).problem).toMatch(/drifted apart/);
      expect(analyseRun('null').problem).toMatch(/drifted apart/);
    });

    it('refuses a result with no case list', () => {
      const noCases = derive(ALL_PASS, (r) => {
        delete r.cases;
      });
      expect(analyseRun(noCases).problem).toMatch(/no case list/);
    });

    it('refuses an interrupted run, whose result is incomplete', () => {
      const interrupted = derive(ALL_PASS, (r) => {
        r.reason = 'interrupted';
      });
      expect(analyseRun(interrupted).problem).toMatch(/interrupted/);
    });
  });

  describe('what CI is told', () => {
    const flaky = analyseRun(FLAKY_ONLY).flaky;

    it('maps a suite-relative path to a repo-relative one', () => {
      // The results file is relative to the tui-e2e dir the runner ran in; an annotation only
      // attaches to a file if the path is relative to the repo root.
      expect(repoPath(flaky[0])).toBe('packages/app/tui-e2e/zzprobe.tui.test.ts');
    });

    it('emits a GitHub warning naming the test and where to record it', () => {
      const [annotation] = githubAnnotations(flaky);

      expect(annotation).toContain('::warning file=packages/app/tui-e2e/zzprobe.tui.test.ts');
      expect(annotation).toContain('line=21');
      expect(annotation).toContain('col=5');
      expect(annotation).toContain('passes on the retry');
      expect(annotation).toContain('docs/known-flakes.md');
    });

    it('writes a job summary naming the test and where to record it', () => {
      const markdown = stepSummaryMarkdown(flaky, { os: 'darwin' });

      expect(markdown).toContain('1 flaky TUI e2e test on darwin');
      expect(markdown).toContain('packages/app/tui-e2e/zzprobe.tui.test.ts:21');
      expect(markdown).toContain('passes on the retry');
      expect(markdown).toContain('docs/known-flakes.md');
    });

    it('pluralises the job summary heading', () => {
      const two = [...flaky, ...flaky];
      expect(stepSummaryMarkdown(two, { os: 'linux' })).toContain('2 flaky TUI e2e tests on linux');
    });
  });

  /**
   * QA-13, I1 — a flake is matched on its message in docs/known-flakes.md, so the error each failed
   * attempt recorded has to reach the place a reader looks: the FLAKY block, the annotation and
   * the step summary. Taken from the capture, where the flaky case's first attempt failed on a real
   * harness locator timeout.
   */
  describe('the failed attempts errors reach the reader', () => {
    const flaky = analyseRun(FLAKY_ONLY).flaky;
    const LOCATOR_TIMEOUT =
      'locator timeout: getByText(OPS153-NEVER-ON-SCREEN) resolved to 0 elements after 300 ms';

    it('analyseRun carries the recorded errors on each flaky entry', () => {
      expect(flaky[0].errors).toEqual([LOCATOR_TIMEOUT]);
    });

    it('puts the error in the annotation, escaped so it stays one workflow command', () => {
      const [annotation] = githubAnnotations(flaky);
      expect(annotation).toContain(LOCATOR_TIMEOUT);
      // A raw newline would end the command; GitHub decodes %0A back into one.
      expect(annotation).not.toContain('\n');
      expect(annotation).toContain('%0AFailed attempt(s):%0A');
      const percent = githubAnnotations([{ ...flaky[0], errors: ['100% wrong'] }])[0];
      expect(percent).toContain('100%25 wrong');
    });

    it('puts the error in the step summary, in its own column', () => {
      const markdown = stepSummaryMarkdown(flaky, { os: 'win32' });
      expect(markdown).toContain('Error on the failed attempt(s)');
      expect(markdown).toContain(LOCATOR_TIMEOUT);
      const piped = stepSummaryMarkdown([{ ...flaky[0], errors: ['a | b'] }], { os: 'win32' });
      expect(piped).toContain('a \\| b');
    });

    it('keeps the first line of a message whole, however long, and cuts only what follows', () => {
      const long = `expected ${'x'.repeat(SIGNATURE_CHARS * 2)} to be y`;
      expect(errorSignature(long)).toBe(long);
      const withTail = `${long}\n${'second line '.repeat(10)}`;
      expect(errorSignature(withTail)).toBe(`${long} ⏎ …`);
    });

    it('joins a multi-line message onto one line, which is what a strict violation needs', () => {
      expect(
        errorSignature(
          'expect(terminal).toBeVisible(marker)\n\nstrict mode violation: getByText(marker) resolved to 2 elements'
        )
      ).toBe(
        'expect(terminal).toBeVisible(marker) ⏎ strict mode violation: getByText(marker) resolved to 2 elements'
      );
    });

    it('counts repeats and caps the number shown, so one case cannot flood an annotation', () => {
      expect(attemptErrors({ errors: ['same', 'same'] })).toEqual(['same (2 attempts)']);
      expect(attemptErrors({ errors: ['a', 'b', 'c', 'd', 'e'] })).toEqual([
        'a',
        'b',
        'c',
        '… and 2 more',
      ]);
      expect(attemptErrors({ errors: [] })).toEqual([
        '(no error was recorded for the failed attempt)',
      ]);
    });
  });

  /**
   * QA-13 / GS2-20, I3 — every decision `run-tui-e2e.js` makes after vitest exits, one branch per
   * case. The runner only performs what `decideVerdict` returns, so these are the runner's verdicts.
   */
  describe('decideVerdict', () => {
    const LEAK = '1 throwaway HOME directory could not be removed: /tmp/x — EPERM';

    it('a leak fails the run even when vitest exited 0, and says why', () => {
      const verdict = decideVerdict({ childCode: 0, leak: LEAK, results: ALL_PASS });
      expect(verdict.exitCode).toBe(1);
      expect(verdict.stderr).toContain(LEAK);
    });

    it('a leak never masks a red run', () => {
      expect(decideVerdict({ childCode: 3, leak: LEAK, results: ALL_PASS }).exitCode).toBe(3);
    });

    it('a leak is decided before the flake analysis', () => {
      // Results that would otherwise be green with a flake: the leak still decides, and nothing
      // about the flake is printed over it.
      const verdict = decideVerdict({ childCode: 0, leak: LEAK, results: FLAKY_ONLY });
      expect(verdict.exitCode).toBe(1);
      expect(verdict.stdout).toBe('');
    });

    it('a missing results file fails the run even when vitest exited 0', () => {
      const verdict = decideVerdict({ childCode: 0, leak: null, results: null });
      expect(verdict.exitCode).toBe(1);
      expect(verdict.stderr).toContain('wrote no results file');
    });

    it('a results file it cannot read fails the run even when vitest exited 0', () => {
      const verdict = decideVerdict({ childCode: 0, leak: null, results: '{not json' });
      expect(verdict.exitCode).toBe(1);
      expect(verdict.stderr).toContain('could not read the run report');
    });

    it('an empty run fails even when vitest exited 0', () => {
      const verdict = decideVerdict({ childCode: 0, leak: null, results: NO_TESTS });
      expect(verdict.exitCode).toBe(1);
      expect(verdict.stderr).toContain('ran none of them');
    });

    it('a failure the result records fails the run even when vitest exited 0', () => {
      const verdict = decideVerdict({ childCode: 0, leak: null, results: FAILED_AND_FLAKY });
      expect(verdict.exitCode).toBe(1);
      expect(verdict.stderr).toContain('vitest exited 0 but the result records 1 failed case(s)');
    });

    it('a failed case with vitest also red keeps vitest’s code', () => {
      expect(decideVerdict({ childCode: 1, leak: null, results: FAILED_AND_FLAKY }).exitCode).toBe(
        1
      );
    });

    it('a flake stays green, and is printed with its error', () => {
      const verdict = decideVerdict({ childCode: 0, leak: null, results: FLAKY_ONLY });
      expect(verdict.exitCode).toBe(0);
      expect(verdict.stderr).toBe('');
      expect(verdict.stdout).toContain('1 passed (1 flaky)');
      expect(verdict.stdout).toContain('FLAKY');
      expect(verdict.stdout).toContain(
        'failed attempt: locator timeout: getByText(OPS153-NEVER-ON-SCREEN)'
      );
      expect(verdict.stepSummary).toContain('1 flaky TUI e2e test');
    });

    it('annotates a flake on GitHub Actions, and only there', () => {
      const onActions = decideVerdict({
        childCode: 0,
        leak: null,
        results: FLAKY_ONLY,
        githubActions: true,
      });
      expect(onActions.stdout).toContain('::warning file=packages/app/tui-e2e/zzprobe.tui.test.ts');
      const local = decideVerdict({ childCode: 0, leak: null, results: FLAKY_ONLY });
      expect(local.stdout).not.toContain('::warning');
    });

    it('a clean run is green, with no flake block and no summary', () => {
      const verdict = decideVerdict({ childCode: 0, leak: null, results: ALL_PASS });
      expect(verdict.exitCode).toBe(0);
      expect(verdict.stdout).toContain('1 passed (0 flaky)');
      expect(verdict.stdout).not.toContain('FLAKY');
      expect(verdict.stepSummary).toBeNull();
    });
  });

  /**
   * GS2-20 — the leak gate. A `gth` session holds `<HOME>/.gsloth/history.db` open for its whole
   * life, and the suite's throwaway HOME cannot be removed on win32 while that handle is alive.
   * POSIX unlinks an open file regardless, so the win32 cell is the only detector there is, and a
   * hook that merely warned would be no detector at all. The report is written to a file and the
   * runner fails the run on it.
   *
   * The report travels by file because the hooks that write it run in a test worker process,
   * while the runner that has to act on it is the parent; the parent owns the worker's
   * environment, so a path handed down is the one channel that always arrives.
   *
   * **The two findings must stay distinguishable.** A session that outlived its kill and a
   * directory that will not delete have different causes and different fixes, and a message that
   * merges them sends the reader after the wrong one. These cases pin that separation.
   */
  describe('describeLeakReport', () => {
    it('says nothing when nothing failed', () => {
      // The control, and the one that matters most: this gate runs on EVERY green run, so a
      // function that reported a leak from an empty or whitespace-only file would turn the whole
      // PTY suite red for every developer, immediately.
      expect(describeLeakReport('')).toBeNull();
      expect(describeLeakReport('\n')).toBeNull();
      expect(describeLeakReport('  \n\n  \n')).toBeNull();
    });

    it('names every directory that would not delete, with its reason', () => {
      const report = describeLeakReport(
        `${JSON.stringify({
          kind: 'unremovable',
          dir: 'C:\\Users\\runner\\AppData\\Local\\Temp\\gth-e2e-attack-home-a1',
          reason: 'EPERM: operation not permitted',
        })}\n${JSON.stringify({
          kind: 'unremovable',
          dir: 'C:\\Users\\runner\\AppData\\Local\\Temp\\gth-e2e-attack-home-b2',
          reason: 'EBUSY: resource busy',
        })}\n`
      );
      expect(report).not.toBeNull();
      expect(report).toContain('2 throwaway HOME directories');
      expect(report).toContain('gth-e2e-attack-home-a1');
      expect(report).toContain('EPERM: operation not permitted');
      expect(report).toContain('gth-e2e-attack-home-b2');
      expect(report).toContain('EBUSY: resource busy');
      // With no still-running row the message reports WHAT WAS OBSERVED — that the pty signalled an
      // exit — and keeps the diagnosis conditional on that signal being faithful.
      expect(report).toContain('The pty reported an exit for every session');
      expect(report).toContain('If that signal is faithful');
      // It must NOT claim the process was alive. That was the first message's unearned conclusion.
      expect(report).not.toContain('still holding a file open well after the process was killed');
      // Nor may it claim the sessions were CONFIRMED dead, which was the second one: on win32 that
      // signal is the pty's output socket closing, which is not an observation of process death.
      expect(report).not.toContain('confirmed exited');
      expect(report).toContain('evidence and not proof');
    });

    it('prints how long the exits took, which is what indicts or exonerates the exit signal', () => {
      const withTimings = describeLeakReport(
        `${JSON.stringify({
          kind: 'unremovable',
          dir: '/tmp/gth-e2e-menu-x',
          reason: 'EPERM',
          exitWaits: { n: 12, minMs: 0, maxMs: 3 },
        })}\n`
      );
      expect(withTimings).toContain('reported in 0-3ms across 12 session(s)');
      // And it must not fabricate the sentence when the worker recorded no timings at all.
      const without = describeLeakReport(
        `${JSON.stringify({ kind: 'unremovable', dir: '/tmp/gth-e2e-menu-x', reason: 'EPERM' })}\n`
      );
      expect(without).not.toContain('Those exits were reported in');
    });

    it('reports a session that outlived its kill as its own finding, not as a leak', () => {
      const report = describeLeakReport(
        `${JSON.stringify({ kind: 'still-running', waitedMs: 5000 })}\n`
      );
      expect(report).not.toBeNull();
      expect(report).toContain('1 session(s) were STILL RUNNING');
      expect(report).toContain('5000ms');
      expect(report).toContain('does not wait');
      // No directory failed here, so it must not invent one.
      expect(report).not.toContain('throwaway HOME director');
    });

    it('stops claiming the sessions were settled once one of them was not', () => {
      const both = describeLeakReport(
        `${JSON.stringify({ kind: 'still-running', waitedMs: 5000 })}\n` +
          `${JSON.stringify({ kind: 'unremovable', dir: '/tmp/gth-e2e-menu-x', reason: 'EPERM' })}\n`
      );
      expect(both).toContain('STILL RUNNING');
      expect(both).toContain('/tmp/gth-e2e-menu-x');
      // The discriminating assertion: with a live session in the run, the removal failure may be
      // nothing but that race, and the message must not assert the stronger diagnosis. Pinned on a
      // string the OTHER branch really does emit — asserting the absence of wording that appears in
      // neither branch would be an assertion that cannot fail.
      expect(both).not.toContain('The pty reported an exit for every session');
      expect(both).toContain('may simply be that race');
    });

    it('carries the run-end re-check through, which is what separates a race from a leak', () => {
      const raw = `${JSON.stringify({
        kind: 'unremovable',
        dir: '/tmp/gth-e2e-menu-x',
        reason: 'EPERM',
      })}\n`;
      expect(
        describeLeakReport(raw, { '/tmp/gth-e2e-menu-x': 'removable once the run had exited' })
      ).toContain('[removable once the run had exited]');
      expect(describeLeakReport(raw)).toContain('1 throwaway HOME directory');
    });

    it('never goes quiet on a row it cannot read', () => {
      // A garbled report is evidence that a hook reported SOMETHING. Dropping it would turn a
      // broken instrument into a green run, which is the failure mode this whole gate exists to
      // avoid.
      const report = describeLeakReport('{not json at all\n');
      expect(report).not.toBeNull();
      expect(report).toContain('could not be read');
      expect(report).toContain('{not json at all');
    });
  });

  describe('leakedDirs', () => {
    it('returns only the directories, so the run-end re-check has something to retry', () => {
      const raw =
        `${JSON.stringify({ kind: 'still-running', waitedMs: 5000 })}\n` +
        `${JSON.stringify({ kind: 'unremovable', dir: '/tmp/a', reason: 'EPERM' })}\n` +
        `${JSON.stringify({ kind: 'unremovable', dir: '/tmp/b', reason: 'EBUSY' })}\n`;
      expect(leakedDirs(raw)).toEqual(['/tmp/a', '/tmp/b']);
    });

    it('is empty for a clean run and survives an unreadable row', () => {
      expect(leakedDirs('')).toEqual([]);
      expect(leakedDirs('{broken\n')).toEqual([]);
    });
  });
});
