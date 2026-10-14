// [[OPS-153]] / QA-13 — the PTY e2e run's structured result, written for `run-tui-e2e.js` to read.
//
// vitest's own `json` reporter records each case's final state but not whether it took a retry to
// get there, and a pass on a retry is exactly what the flake report exists to surface. So this
// reporter writes its own record from vitest's reporter API, where `diagnostic().retryCount` and
// `diagnostic().flaky` are first-class. It is deliberately dumb: it records what vitest says and
// leaves every judgement to `tui-e2e-report.mjs`, which is pure and unit-tested.
//
// It writes to the path in `GTH_E2E_RESULTS`, which the runner sets. With no such variable it
// writes nothing, so a hand-run vitest is not broken by it — and the runner treats a missing file
// as a failed run, never as a clean one.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Bumped whenever the shape below changes; `analyseRun` refuses a schema it does not know. */
export const RESULTS_SCHEMA = 1;

const e2eDir = fileURLToPath(new URL('./tui-e2e/', import.meta.url));

/** A module path relative to the suite folder, with forward slashes on every OS. */
const relativeFile = (moduleId) => path.relative(e2eDir, moduleId).split(path.sep).join('/');

/** The first line of each error, which is what a summary can usefully carry. */
const messages = (errors) =>
  (errors ?? []).map((error) => String(error?.message ?? error).split('\n')[0]);

/** `describe › describe › case`, the title form 0.0.4's reporter printed. */
function titleOf(testCase) {
  const parts = [testCase.name];
  for (let parent = testCase.parent; parent && parent.type === 'suite'; parent = parent.parent) {
    parts.unshift(parent.name);
  }
  return parts.join(' › ');
}

export default class TuiE2eResultsReporter {
  onTestRunEnd(testModules, unhandledErrors, reason) {
    const target = process.env.GTH_E2E_RESULTS;
    if (!target) return;
    const modules = [];
    const cases = [];
    for (const testModule of testModules) {
      const file = relativeFile(testModule.moduleId);
      modules.push({ file, state: testModule.state(), errors: messages(testModule.errors()) });
      for (const testCase of testModule.children.allTests()) {
        const result = testCase.result();
        const diagnostic = testCase.diagnostic();
        cases.push({
          file,
          line: testCase.location?.line ?? null,
          column: testCase.location?.column ?? null,
          title: titleOf(testCase),
          state: result.state,
          retryCount: diagnostic?.retryCount ?? 0,
          flaky: diagnostic?.flaky ?? false,
          errors: messages(result.errors),
        });
      }
    }
    const record = {
      schema: RESULTS_SCHEMA,
      reason,
      unhandledErrors: messages(unhandledErrors),
      modules,
      cases,
    };
    fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }
}
