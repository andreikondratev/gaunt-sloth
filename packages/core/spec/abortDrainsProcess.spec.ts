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

/** The fixture's own budget is 300ms; this is the window we allow the process to end within. */
const DRAIN_WINDOW_MS = 8_000;

interface RunResult {
  drained: boolean;
  stdout: string;
  elapsedMs: number;
}

/** Run the fixture and report whether it ended on its own inside the window. */
function runFixture(mode: 'abort' | 'noabort'): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [FIXTURE, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
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
      const aborted = await runFixture('abort');
      const abandoned = await runFixture('noabort');

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
