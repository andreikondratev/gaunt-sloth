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
 * Every one of those decisions is `decideVerdict` in `tui-e2e-report.mjs`, a pure function with a
 * unit spec per branch; this file only reads the two files the run leaves and prints what it is told.
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
import { decideVerdict, describeLeakReport, leakedDirs } from './tui-e2e-report.mjs';
import { BASE_ENV_VAR, encodeBaseEnv } from './tui-e2e/fixtures/baseEnv.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eDir = path.join(here, 'tui-e2e');
const configPath = path.join(e2eDir, 'vitest.config.mjs');
const vitestBin = path.join(
  path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs'
);

// The two files this run hands down live in one directory, removed at the end. Neither holds any
// part of the environment: the leak report holds directory paths, the results hold test outcomes.
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

// What a test worker needs to undo the keys vitest adds (fixtures/vitest.setup.mjs): the names this
// environment has and this process's values for the few keys vitest sets — never any other value.
// Encoded last, so it names the two paths above. See fixtures/baseEnv.mjs.
env[BASE_ENV_VAR] = encodeBaseEnv(env);

const child = spawn(
  process.execPath,
  [vitestBin, 'run', '--config', configPath, ...process.argv.slice(2)],
  { cwd: e2eDir, stdio: 'inherit', env }
);

// `close` rather than `exit`: it fires once the child's stdio is done, so the run's own output is
// complete before the verdict below is printed under it.
child.on('close', (code) => {
  // GS2-20 — read first, and only the read is allowed to mean "nothing happened". Folding anything
  // else into the same try would let a throw inside it be mistaken for an absent file, which is a
  // green run.
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
    // decideVerdict treats no result as a blind gate, never a clean one.
  }
  rmSync(scratchDir, { recursive: true, force: true });

  // Every decision is in decideVerdict (tui-e2e-report.mjs), where each branch is unit-tested; this
  // handler only performs what it returns.
  const verdict = decideVerdict({
    childCode: code ?? 1,
    leak,
    results,
    githubActions: Boolean(process.env.GITHUB_ACTIONS),
    os: process.platform,
  });
  if (verdict.stdout) process.stdout.write(verdict.stdout);
  if (verdict.stderr) process.stderr.write(verdict.stderr);
  if (verdict.stepSummary && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, verdict.stepSummary, 'utf8');
  }

  // Set the code and let the process end on its own — do NOT force the exit here. On macOS
  // `process.stdout` is ASYNCHRONOUS when it is a pipe, which is exactly what a GitHub Actions step
  // gives it, and forcing an exit does not drain what is still queued. The flake block and the
  // `::warning` annotations are written immediately above, so they are what would be lost.
  // Nothing holds the loop open once the child has closed, so the process still exits promptly.
  // `packages/app/spec/tuiE2eRunnerFlush.spec.ts` keeps it this way.
  process.exitCode = verdict.exitCode;
});
