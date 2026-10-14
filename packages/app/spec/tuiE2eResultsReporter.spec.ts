import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TuiE2eResultsReporter, {
  MAX_MESSAGE_CHARS,
  RESULTS_SCHEMA,
  recordedMessage,
} from '../tui-e2e-results-reporter.mjs';
import { analyseRun } from '../tui-e2e-report.mjs';

/**
 * QA-13 — the reporter that writes the PTY run's structured result, EXECUTED against objects
 * shaped like vitest's reporter API.
 *
 * The report spec reads captured results, so on its own it cannot see a change in how the reporter
 * MAPS vitest's data — dropping the retry count would turn every flake into a silent pass and
 * leave that spec green. This one drives `onTestRunEnd` and reads back what it wrote, so the
 * mapping is pinned field by field: state, retry count, flaky flag, location, title and errors.
 *
 * The fakes carry only what the reporter reads; each is named after the vitest 5 API it stands in
 * for (`TestModule`, `TestCase`, `TestCase.result()`, `TestCase.diagnostic()`).
 */
const E2E_DIR = fileURLToPath(new URL('../tui-e2e/', import.meta.url));

type Attempted = {
  name: string;
  state: 'passed' | 'failed' | 'skipped' | 'pending';
  retryCount?: number;
  flaky?: boolean;
  errors?: { message: string }[];
  line?: number;
};

/** A vitest `TestCase` inside one `describe` inside `module`. */
const fakeCase = (module: any, suiteName: string, c: Attempted) => ({
  type: 'test',
  name: c.name,
  parent: { type: 'suite', name: suiteName, parent: module },
  location: { line: c.line ?? 10, column: 5 },
  result: () => ({ state: c.state, errors: c.errors ?? [] }),
  diagnostic: () =>
    c.state === 'skipped' || c.state === 'pending'
      ? undefined
      : { retryCount: c.retryCount ?? 0, flaky: c.flaky ?? false },
});

/** A vitest `TestModule` for `<tui-e2e>/<file>` holding `cases`. */
const fakeModule = (file: string, cases: Attempted[], state = 'passed', errors: any[] = []) => {
  const module: any = {
    type: 'module',
    moduleId: path.join(E2E_DIR, ...file.split('/')),
    state: () => state,
    errors: () => errors,
  };
  const tests = cases.map((c) => fakeCase(module, 'zzsuite', c));
  module.children = { allTests: () => tests[Symbol.iterator]() };
  return module;
};

let dir: string;
let target: string;
const saved = process.env.GTH_E2E_RESULTS;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gth-reporter-spec-'));
  target = path.join(dir, 'results.json');
  process.env.GTH_E2E_RESULTS = target;
});

afterEach(() => {
  if (saved === undefined) delete process.env.GTH_E2E_RESULTS;
  else process.env.GTH_E2E_RESULTS = saved;
  rmSync(dir, { recursive: true, force: true });
});

const run = (modules: any[], reason = 'passed', unhandled: any[] = []) => {
  new TuiE2eResultsReporter().onTestRunEnd(modules, unhandled, reason);
  return JSON.parse(readFileSync(target, 'utf8'));
};

describe('QA-13 the results reporter maps vitest’s record faithfully', () => {
  it('records a pass on a retry with its retry count, its flag and the failed attempt’s error', () => {
    const record = run([
      fakeModule('zz.tui.test.ts', [
        {
          name: 'passes on the retry',
          state: 'passed',
          retryCount: 1,
          flaky: true,
          errors: [{ message: 'expected 1 to be greater than 1' }],
          line: 21,
        },
      ]),
    ]);
    expect(record.schema).toBe(RESULTS_SCHEMA);
    expect(record.cases).toEqual([
      {
        file: 'zz.tui.test.ts',
        line: 21,
        column: 5,
        title: 'zzsuite › passes on the retry',
        state: 'passed',
        retryCount: 1,
        flaky: true,
        errors: ['expected 1 to be greater than 1'],
      },
    ]);
    // And the reader sees it as the flake it is — the end-to-end property this reporter serves.
    expect(analyseRun(JSON.stringify(record)).flaky).toHaveLength(1);
  });

  it('records each case’s own state, so a failure is never written as a pass', () => {
    const record = run(
      [
        fakeModule('zz.tui.test.ts', [
          { name: 'a', state: 'passed' },
          { name: 'b', state: 'failed', retryCount: 2, errors: [{ message: 'boom' }] },
          { name: 'c', state: 'skipped' },
        ]),
      ],
      'failed'
    );
    expect(record.cases.map((c: any) => [c.title, c.state, c.retryCount, c.flaky])).toEqual([
      ['zzsuite › a', 'passed', 0, false],
      ['zzsuite › b', 'failed', 2, false],
      ['zzsuite › c', 'skipped', 0, false],
    ]);
    expect(record.reason).toBe('failed');
    expect(analyseRun(JSON.stringify(record)).summary).toMatchObject({ passed: 1, failed: 1 });
  });

  it('records a module that failed to load, with its error', () => {
    const record = run(
      [fakeModule('sub/broken.tui.test.ts', [], 'failed', [{ message: 'SyntaxError: nope' }])],
      'failed'
    );
    expect(record.modules).toEqual([
      { file: 'sub/broken.tui.test.ts', state: 'failed', errors: ['SyntaxError: nope'] },
    ]);
  });

  it('records unhandled errors and the run’s reason', () => {
    const record = run([], 'interrupted', [{ message: 'worker died' }]);
    expect(record.unhandledErrors).toEqual(['worker died']);
    expect(record.reason).toBe('interrupted');
  });

  it('writes nothing when the runner did not ask for a result', () => {
    delete process.env.GTH_E2E_RESULTS;
    new TuiE2eResultsReporter().onTestRunEnd([], [], 'passed');
    expect(() => readFileSync(target, 'utf8')).toThrow();
  });
});

describe('QA-13 what the reporter keeps of an error', () => {
  it('keeps every line of the message and drops the harness’s screen dump', () => {
    expect(
      recordedMessage({
        message:
          'expect(terminal).toBeVisible(x)\n\nstrict mode violation: getByText(x) resolved to 2 elements' +
          '\n\nTerminal content:\n---START---\nx\nx\n---END---',
      })
    ).toBe(
      'expect(terminal).toBeVisible(x)\n\nstrict mode violation: getByText(x) resolved to 2 elements'
    );
  });

  it('never records a stack', () => {
    const error = new Error('the message');
    expect(recordedMessage(error)).toBe('the message');
  });

  it('cuts a message past the cap, and says so', () => {
    const recorded = recordedMessage({ message: 'x'.repeat(MAX_MESSAGE_CHARS + 50) });
    expect(recorded.startsWith('x'.repeat(MAX_MESSAGE_CHARS))).toBe(true);
    expect(recorded).toContain(`[cut at ${MAX_MESSAGE_CHARS} characters]`);
    expect(recordedMessage({ message: 'short' })).toBe('short');
  });
});
