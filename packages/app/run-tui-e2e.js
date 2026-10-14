/**
 * Runner for the PTY e2e suite (the Ink TUI driven in a real pseudo-terminal). `pnpm run it-tui`
 * builds and then runs this; `tui-e2e.yml` runs that, and `release.yml` calls `tui-e2e.yml`, so this
 * file is a release gate.
 *
 * ## The runner is vitest, not `node:test`
 *
 * `@microsoft/tui-test` 0.1 is a terminal engine with no runner of its own, so the suite needs one
 * that gives each case **retries** and reports, as **data**, which cases needed one — the flake
 * report (QA-13) is built on exactly that.
 *
 * - **vitest** has per-case `retry`, and its reporter API exposes each case's final state together
 *   with `diagnostic().retryCount` and `.flaky`. `tui-e2e-results-reporter.mjs` writes those to a
 *   JSON file, and this runner reads that file. It is also the repo's unit runner, so it adds no
 *   dependency, and its `expect` is the Jest-compatible one the cases were written against.
 * - **`node:test` was rejected** because it has no retry. A retry loop would have to be built into
 *   the harness around each case, and then the per-attempt outcomes would exist only in the harness,
 *   not in `node:test`'s structured reporter output — the flake report would be reading our own
 *   bookkeeping rather than the runner's record.
 *
 * ## What happens after the run, in order
 *
 * 1. **GS2-20 leak check.** `fixtures/tmpHome.mjs` writes any throwaway HOME it could not remove (and
 *    any session that outlived its kill) to the file in `GTH_E2E_LEAK_REPORT`. Anything there fails
 *    the run, checked BEFORE the flake analysis, because a leak is a cause and a broken report is at
 *    most a symptom of one.
 * 2. **QA-13 flake check**, from the structured result: a case that passed only on a retry is printed,
 *    annotated as a GitHub `::warning` and added to `$GITHUB_STEP_SUMMARY`, and the run stays green.
 *    A case that failed every attempt fails the run through vitest's own exit code. A result that is
 *    missing or unreadable, or a run that ran no cases, fails the run even if vitest exited 0: a gate
 *    that measured nothing must not report green.
 *
 * The suite has to run with `packages/app/tui-e2e` as its working directory — the cases resolve the
 * cli and their fixtures from `process.cwd()`, and the programs they spawn inherit it — so vitest is
 * spawned here with an explicit cwd rather than relying on a shell `cd`.
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  analyseRun,
  describeLeakReport,
  githubAnnotations,
  leakedDirs,
  repoPath,
  stepSummaryMarkdown,
} from './tui-e2e-report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eDir = path.join(here, 'tui-e2e');
const configPath = path.join(e2eDir, 'vitest.config.mjs');
const vitestBin = path.join(
  path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs'
);

// Every scratch file this run hands down lives in one directory, removed at the end.
const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'gth-e2e-run-'));

// The environment the cases see is this process's, plus `FORCE_COLOR=1` when our own stdout is a
// terminal. That reproduces what reached `gth` under 0.0.4, whose runner set `FORCE_COLOR` for its
// workers from whether its stdout supported colour: on an interactive run it did, and on CI (stdout
// a pipe, no FORCE_COLOR set) it did not. The colour a case renders in depends on it.
const env = { ...process.env, ...(process.stdout.isTTY ? { FORCE_COLOR: '1' } : {}) };

// GS2-20 — the channel a suite reports an unremovable throwaway HOME on. It has to be a FILE: the
// removals happen in a test worker process, and this parent is the one place that sees the whole run.
const leakReportPath = path.join(scratchDir, 'unremovable-homes.tsv');
env.GTH_E2E_LEAK_REPORT = leakReportPath;

// QA-13 — where tui-e2e-results-reporter.mjs writes the structured result.
const resultsPath = path.join(scratchDir, 'results.json');
env.GTH_E2E_RESULTS = resultsPath;

// The environment a test worker restores before any case loads (fixtures/vitest.setup.mjs), because
// vitest adds keys of its own — NODE_ENV=test among them — that would otherwise reach `gth`. Written
// last, so it carries the two paths above.
const baseEnvPath = path.join(scratchDir, 'base-env.json');
env.GTH_E2E_BASE_ENV_FILE = baseEnvPath;
writeFileSync(baseEnvPath, JSON.stringify(env), 'utf8');

const child = spawn(
  process.execPath,
  [vitestBin, 'run', '--config', configPath, ...process.argv.slice(2)],
  { cwd: e2eDir, stdio: 'inherit', env }
);

// `close` rather than `exit`: it fires once the child's stdio is done, so the run's own output is
// complete before the verdict below is printed under it.
child.on('close', (code) => {
  const childCode = code ?? 1;

  // GS2-20 — checked BEFORE the flake analysis, because a leak is a cause and "the flake check went
  // blind" is at most a symptom of one. Read first, and only the read is allowed to mean "nothing
  // happened". Folding the analysis into the same try would let a throw inside it be mistaken for an
  // absent file, which is a green run.
  let raw = null;
  try {
    raw = readFileSync(leakReportPath, 'utf8');
  } catch {
    // No file means no hook ever reported anything, which is the ordinary case — the fixture only
    // creates it when a session outlived its kill or a removal exhausted its retries.
  }
  let leak = null;
  if (raw !== null) {
    // Re-attempt each removal now that the run is over. This is the one place it can be done with
    // no worker alive, and it separates the two things the hook cannot tell apart: a directory that
    // deletes cleanly here was locked only while the run was going, whereas one that still refuses
    // is genuinely held. They are different defects and the message says which it saw.
    const outcomes = {};
    for (const dir of leakedDirs(raw)) {
      if (!existsSync(dir)) {
        outcomes[dir] = 'already gone by run end';
        continue;
      }
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        outcomes[dir] = 'removable once the run had exited — a transient lock, not a leak';
      } catch (err) {
        outcomes[dir] = `STILL locked after the run exited: ${err.message}`;
      }
    }
    leak = describeLeakReport(raw, outcomes);
  }

  let results = null;
  try {
    results = readFileSync(resultsPath, 'utf8');
    // Keep a copy of the structured result when asked to — for a CI artifact, or to capture the
    // fixtures under spec/fixtures/tui-e2e-output/. Never on by default.
    if (process.env.GTH_E2E_RESULTS_COPY) writeFileSync(process.env.GTH_E2E_RESULTS_COPY, results);
  } catch {
    // Handled below: no result is a blind gate, never a clean one.
  }
  rmSync(scratchDir, { recursive: true, force: true });

  if (leak) {
    process.stderr.write(`\n✗ tui-e2e ${leak}\n`);
    // Never mask the child's own verdict: a red run that also leaked stays red for its own reason.
    process.exitCode = childCode === 0 ? 1 : childCode;
    return;
  }

  const analysis =
    results === null
      ? { problem: 'the run wrote no results file, so nothing is known about what ran.' }
      : analyseRun(results);

  if (analysis.problem) {
    // The flake check has gone blind. Reporting "no flakes" here would be a green light from a
    // gate that measured nothing, so say so and fail even if vitest itself was happy.
    process.stderr.write(
      `\n✗ tui-e2e flake check could not read the run report: ${analysis.problem}\n`
    );
    process.exitCode = childCode === 0 ? 1 : childCode;
    return;
  }

  const { summary } = analysis;
  process.stdout.write(
    `\ntui-e2e: ${summary.passed} passed (${summary.flaky} flaky), ${summary.failed} failed, ` +
      `${summary.skipped} skipped, ${summary.didNotRun} did not run, ${summary.total} total\n`
  );

  if (analysis.flaky.length > 0) {
    const lines = analysis.flaky.map(
      (entry) => `    ${repoPath(entry)}:${entry.row} › ${entry.title}`
    );
    process.stdout.write(
      `\n⚠ ${analysis.flaky.length} FLAKY test(s) — passed only on a retry, so this run is green ` +
        `but the defect is real:\n${lines.join('\n')}\n` +
        `  Record it in docs/known-flakes.md (takahe) so the next person mid-merge does not have ` +
        `to re-derive it.\n`
    );

    if (process.env.GITHUB_ACTIONS) {
      for (const annotation of githubAnnotations(analysis.flaky)) {
        process.stdout.write(`${annotation}\n`);
      }
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        stepSummaryMarkdown(analysis.flaky, { os: process.platform }),
        'utf8'
      );
    }
  }

  // A case that failed every attempt is already a non-zero vitest exit; the structured result is
  // checked too, so a red case can never be waved through by an exit code that disagrees with it.
  if (summary.failed > 0 && childCode === 0) {
    process.stderr.write(
      `\n✗ tui-e2e: vitest exited 0 but the result records ${summary.failed} failed case(s).\n`
    );
    process.exitCode = 1;
    return;
  }

  // A flake stays green: vitest's own exit code is the authority on pass/fail, and the node's
  // acceptance asks for a flake to be *reported as flaky rather than as a pass*, not to be turned
  // into a failure. Promoting a flake to a hard failure is the promote-after-soak rule, which
  // belongs to OPS-14.
  //
  // Set the code and let the process end on its own — do NOT force the exit here. On macOS
  // `process.stdout` is ASYNCHRONOUS when it is a pipe, which is exactly what a GitHub Actions step
  // gives it, and forcing an exit does not drain what is still queued. The flake block and the
  // `::warning` annotations are written immediately above, so they are what would be lost.
  // Nothing holds the loop open once the child has closed, so the process still exits promptly.
  // `packages/app/spec/tuiE2eRunnerFlush.spec.ts` keeps it this way.
  process.exitCode = childCode;
});
