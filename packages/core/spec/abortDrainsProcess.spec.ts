import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * [[EXT-179]] — **the end-to-end proof, and the only cell here that can tell a real abort from a
 * rejected promise.**
 *
 * Every other cell for this node uses a fake model, so all of them would stay green against a
 * signal the provider client quietly ignores — the substituted-component shape the node warns
 * about. This one closes that gap by measuring the symptom itself rather than the mechanism:
 *
 * > a `gth exec` whose provider never answers should EXIT once the answer is printed and the
 * > timeout has passed, instead of waiting on the provider's own timeout.
 *
 * It has to be a child process, because a spec cannot assert that its own process drains — the
 * test runner is holding it open by definition. The fixture ends the way the CLI ends, by setting
 * `process.exitCode` and returning (`setExitCode`; nothing calls `process.exit`), so the only thing
 * that can keep it alive past the budget is an in-flight provider socket.
 *
 * **The control is the load-bearing half.** `noabort` runs the same stalled provider with the
 * pre-fix race — a timer, no signal — and must NOT drain. Without it, `abort` draining would prove
 * nothing, since a process with nothing to hold it open exits either way. Together they are a
 * differential: the only difference between the two runs is whether the call is aborted, so the
 * difference in whether the process ends is attributable to that and nothing else.
 *
 * Hermetic: a `127.0.0.1` HTTP server that never answers, a literal dummy API key, no network.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/ext179-drain-fixture.mjs', import.meta.url));
const OLLAMA_FIXTURE = fileURLToPath(
  new URL('./fixtures/ext180-ollama-drain-fixture.mjs', import.meta.url)
);

/** The fixture's own budget is 300ms; this is the window we allow the process to end within. */
const DRAIN_WINDOW_MS = 8_000;

interface RunResult {
  drained: boolean;
  stdout: string;
  elapsedMs: number;
}

/** Run a fixture in one of its modes and report whether it ended on its own inside the window. */
function runFixture(fixture: string, mode: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [fixture, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', () => {});
    const killer = setTimeout(() => child.kill('SIGKILL'), DRAIN_WINDOW_MS);
    child.on('exit', (_code, signal) => {
      clearTimeout(killer);
      resolve({
        // Ending because we killed it is precisely NOT draining.
        drained: signal !== 'SIGKILL',
        stdout,
        elapsedMs: Date.now() - started,
      });
    });
  });
}

describe('[[EXT-179]] an aborted provider call releases the process', () => {
  it(
    'drains after the budget when the call is aborted, and does NOT when it is only abandoned',
    async () => {
      const aborted = await runFixture(FIXTURE, 'abort');
      const abandoned = await runFixture(FIXTURE, 'noabort');

      // Both runs must actually have reached the timeout — otherwise they are measuring something
      // else entirely (a provider that answered, a fixture that crashed early).
      expect(aborted.stdout).toContain('TIMED_OUT');
      expect(abandoned.stdout).toContain('TIMED_OUT');

      expect(
        aborted.drained,
        'the aborted run did not end on its own — the abort did not reach the socket'
      ).toBe(true);
      expect(
        abandoned.drained,
        'the CONTROL ended on its own, so this cell cannot attribute the other run to the abort'
      ).toBe(false);
    },
    // Two child processes, one of which is expected to be killed at the window.
    DRAIN_WINDOW_MS * 3
  );
});

/**
 * [[EXT-180]] — the same measurement for **ollama**, where the signal does not reach the client at
 * all and a `fetch` the provider installs is what closes the socket.
 *
 * Three runs rather than two, because for ollama "aborted" and "not aborted" is not the axis that
 * matters. The client rejects the promise on a signal it was given either way; what differs is
 * whether the request is torn down. So the run that pins this is the middle one — the same budget,
 * the same signal, against a bare `ChatOllama` — and it is worth more than the other two together:
 *
 * - it attributes the drain to **this mechanism**, not to aborting in general;
 * - it is the **upstream tripwire**. It asserts that `@langchain/ollama` on its own still leaks the
 *   socket, so it FAILS the day a version bump fixes that — which is the only notice anyone will
 *   get, since no promise-level assertion in this suite can tell the two apart. A red here after a
 *   bump is good news: read the client's chat path, and if it now aborts its own request, delete
 *   the bridge rather than this cell.
 */
describe('[[EXT-180]] an aborted ollama call releases the socket', () => {
  it(
    'drains only when the provider installs the ambient-signal fetch',
    async () => {
      const aborted = await runFixture(OLLAMA_FIXTURE, 'ollama-abort');
      // The two runs that must NOT drain are independent child processes on their own ephemeral
      // ports, and each costs the full window, so they are run together.
      const [bareClient, abandoned] = await Promise.all([
        runFixture(OLLAMA_FIXTURE, 'ollama-nofix'),
        runFixture(OLLAMA_FIXTURE, 'ollama-noabort'),
      ]);

      // Every run must actually have reached the timeout, or it is measuring something else
      // entirely — a provider that answered, or a fixture that crashed before it called out.
      for (const [name, run] of [
        ['ollama-abort', aborted],
        ['ollama-nofix', bareClient],
        ['ollama-noabort', abandoned],
      ] as const) {
        expect(run.stdout, `the ${name} run never reached its budget`).toContain('TIMED_OUT');
      }

      expect(
        aborted.drained,
        'the aborted run did not end on its own — the abort did not reach the ollama socket'
      ).toBe(true);
      expect(
        bareClient.drained,
        'a BARE ChatOllama released the socket on its own. Either the provider bridge leaked into ' +
          'this run, or @langchain/ollama now aborts its own request — check the client, and if it ' +
          'does, remove the bridge rather than this assertion'
      ).toBe(false);
      expect(
        abandoned.drained,
        'the CONTROL ended on its own, so this cell cannot attribute the other run to the abort'
      ).toBe(false);
    },
    // Three child processes, two of which are expected to be killed at the window; the two that
    // hang run concurrently, so the wall cost is about two windows.
    DRAIN_WINDOW_MS * 4
  );
});
