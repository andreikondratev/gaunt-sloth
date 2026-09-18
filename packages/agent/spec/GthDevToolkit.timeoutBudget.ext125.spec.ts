/**
 * EXT-125 — the per-call shell time budget, its config ceiling, and a kill a model can tell apart
 * from a failure.
 *
 * Three claims are load-bearing here and each has a test that fails if only that claim breaks:
 *
 *  1. **A model cannot grant itself an unbounded wait.** The ceiling comes from config alone, and a
 *     call asking above it is refused BEFORE anything is spawned — asserted on the spawn mock, not
 *     on the returned text, because a refusal that still ran the command would pass a text check.
 *  2. **Absent the argument, nothing moved.** The armed budget, the spawn options and the
 *     clean/non-zero-exit bodies are pinned as literals rather than rebuilt from the production
 *     templates, so a reworded body reds here instead of agreeing with itself.
 *  3. **A kill does not read like a non-zero exit.** Asserted DIFFERENTIALLY — what each body
 *     contains and what it must NOT contain — because the pre-existing `toContain('was killed…')`
 *     assertions elsewhere would go red on a message change without ever proving the two texts
 *     differ from one another.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMock = { spawn: vi.fn() };
vi.mock('child_process', () => childProcessMock);

vi.mock('#src/utils/consoleUtils.js', () => ({
  displayInfo: vi.fn(),
  displayError: vi.fn(),
  displayWarning: vi.fn(),
}));

const FAKE_WORKDIR = '/fake/fs-backend-root';
vi.mock('#src/utils/systemUtils.js', () => ({
  stdout: { write: vi.fn() },
  env: { PATH: '/usr/bin', HOME: '/home/test' },
  getCurrentWorkDir: vi.fn(() => FAKE_WORKDIR),
}));

/** A controllable child: the test decides when output arrives and when the process closes. */
function makeChild() {
  const handlers: Record<string, (_arg: unknown) => void> = {};
  const stdoutHandlers: Record<string, (_arg: unknown) => void> = {};
  const stderrHandlers: Record<string, (_arg: unknown) => void> = {};
  return {
    child: {
      on: vi.fn((event: string, cb: (_arg: unknown) => void) => {
        handlers[event] = cb;
      }),
      stdout: {
        on: vi.fn((event: string, cb: (_arg: unknown) => void) => {
          stdoutHandlers[event] = cb;
        }),
      },
      stderr: {
        on: vi.fn((event: string, cb: (_arg: unknown) => void) => {
          stderrHandlers[event] = cb;
        }),
      },
      kill: vi.fn(),
    },
    emitStdout: (text: string) => stdoutHandlers.data?.(Buffer.from(text)),
    emitStderr: (text: string) => stderrHandlers.data?.(Buffer.from(text)),
    close: (code: number | null) => handlers.close?.(code),
  };
}

describe('EXT-125 — resolveShellTimeoutBudget (the bound itself)', () => {
  it('grants a budget at or below the ceiling, and marks it as the CALL’s', async () => {
    const { resolveShellTimeoutBudget } = await import('#src/tools/GthDevToolkit.js');

    const under = resolveShellTimeoutBudget(300_000, 120_000, 600_000);
    expect(under).toEqual({
      kind: 'granted',
      timeoutMs: 300_000,
      ceilingMs: 600_000,
      requested: true,
    });

    // Exactly AT the ceiling is granted — the boundary belongs to the model, not to the refusal.
    const at = resolveShellTimeoutBudget(600_000, 120_000, 600_000);
    expect(at).toEqual({
      kind: 'granted',
      timeoutMs: 600_000,
      ceilingMs: 600_000,
      requested: true,
    });
  });

  it('REFUSES a budget above the ceiling and offers no timeoutMs to use by accident', async () => {
    const { resolveShellTimeoutBudget } = await import('#src/tools/GthDevToolkit.js');

    const refused = resolveShellTimeoutBudget(600_001, 120_000, 600_000);
    expect(refused.kind).toBe('refused');
    // The refused arm carries no budget at all, so no caller can read one off it.
    expect((refused as unknown as { timeoutMs?: number }).timeoutMs).toBeUndefined();
    if (refused.kind !== 'refused') throw new Error('unreachable');
    expect(refused.requestedMs).toBe(600_001);
    expect(refused.ceilingMs).toBe(600_000);
    // The model is told what it asked for, what the bound is, and that nothing ran.
    expect(refused.message).toContain('600001ms');
    expect(refused.message).toContain('600000ms');
    expect(refused.message).toContain('No command was executed');
  });

  it('falls back to the configured default for an absent or unusable request', async () => {
    const { resolveShellTimeoutBudget } = await import('#src/tools/GthDevToolkit.js');
    const expected = {
      kind: 'granted',
      timeoutMs: 120_000,
      ceilingMs: 600_000,
      requested: false,
    };
    expect(resolveShellTimeoutBudget(undefined, 120_000, 600_000)).toEqual(expected);
    // Belt and braces behind the schema: a non-finite or non-positive value is not a budget, and
    // must not become one by arithmetic (0 would arm an immediate kill; NaN never fires).
    expect(resolveShellTimeoutBudget(0, 120_000, 600_000)).toEqual(expected);
    expect(resolveShellTimeoutBudget(-1, 120_000, 600_000)).toEqual(expected);
    expect(resolveShellTimeoutBudget(Number.NaN, 120_000, 600_000)).toEqual(expected);
    expect(resolveShellTimeoutBudget(Number.POSITIVE_INFINITY, 120_000, 600_000)).toEqual(expected);
  });
});

describe('EXT-125 — getShellMaxTimeoutMs (the ceiling is a function of CONFIG alone)', () => {
  it('defaults to ten minutes and honours an explicit maxTimeout', async () => {
    const { getShellMaxTimeoutMs, SHELL_DEFAULT_MAX_TIMEOUT_MS } =
      await import('@gaunt-sloth/core/config.js');
    expect(SHELL_DEFAULT_MAX_TIMEOUT_MS).toBe(600_000);
    expect(getShellMaxTimeoutMs(undefined)).toBe(600_000);
    expect(getShellMaxTimeoutMs({ shell: true })).toBe(600_000);
    expect(getShellMaxTimeoutMs({ shell: { enabled: true, maxTimeout: 900_000 } })).toBe(900_000);
  });

  it('is never below the budget the absent-argument path already gets', async () => {
    const { getShellMaxTimeoutMs } = await import('@gaunt-sloth/core/config.js');
    // A ceiling under the default forbids nothing — every command already gets `timeout` ms — and a
    // model that named a legal-looking number would otherwise get LESS than staying silent gives.
    expect(getShellMaxTimeoutMs({ shell: { enabled: true, maxTimeout: 60_000 } })).toBe(120_000);
    // The user who MEANS a one-minute cap sets `timeout` too, and then the ceiling holds at 60s.
    expect(
      getShellMaxTimeoutMs({ shell: { enabled: true, timeout: 60_000, maxTimeout: 60_000 } })
    ).toBe(60_000);
    // "The model may not raise the budget at all" is maxTimeout === timeout, and it works.
    expect(
      getShellMaxTimeoutMs({ shell: { enabled: true, timeout: 300_000, maxTimeout: 300_000 } })
    ).toBe(300_000);
    // A generous `timeout` with no ceiling raises the ceiling with it: the user already granted
    // that wall-clock to every command, so the model gains nothing it did not already have.
    expect(getShellMaxTimeoutMs({ shell: { enabled: true, timeout: 86_400_000 } })).toBe(
      86_400_000
    );
  });

  it('ignores a non-positive / non-finite maxTimeout exactly as getShellTimeoutMs ignores timeout', async () => {
    const { getShellMaxTimeoutMs } = await import('@gaunt-sloth/core/config.js');
    expect(getShellMaxTimeoutMs({ shell: { enabled: true, maxTimeout: 0 } })).toBe(600_000);
    expect(getShellMaxTimeoutMs({ shell: { enabled: true, maxTimeout: -5 } })).toBe(600_000);
    expect(
      getShellMaxTimeoutMs({ shell: { enabled: true, maxTimeout: Number.POSITIVE_INFINITY } })
    ).toBe(600_000);
  });
});

describe('EXT-125 — the toolkit seam', () => {
  let GthDevToolkit: typeof import('#src/tools/GthDevToolkit.js').default;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ default: GthDevToolkit } = await import('#src/tools/GthDevToolkit.js'));
  });

  const exec = (
    toolkit: InstanceType<typeof import('#src/tools/GthDevToolkit.js').default>,
    command: string,
    toolName: string,
    requestedTimeoutMs?: number
  ) =>
    (
      toolkit as unknown as {
        executeCommand(_c: string, _n: string, _id?: string, _t?: number): Promise<string>;
      }
    ).executeCommand(command, toolName, undefined, requestedTimeoutMs);

  it('THE CAPABILITY GRANT: an over-ceiling budget spawns NOTHING and says so', async () => {
    const toolkit = new GthDevToolkit({ shell: { enabled: true } });

    const result = await exec(toolkit, 'sleep 99999', 'run_shell_command', 600_001);

    // The claim that matters: no process was created. A refusal that still ran the command would
    // satisfy every text assertion below while granting exactly the wait the ceiling forbids.
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
    expect(result).toContain('600001ms');
    expect(result).toContain('600000ms');
    expect(result).toContain('No command was executed');
    // It names the move, so the next call is a different call.
    expect(result).toContain('Re-call with timeoutMs at or below 600000');
  });

  it('refuses above the ceiling on a FIXED run_* tool too, and on the same numbers', async () => {
    const toolkit = new GthDevToolkit({ run_tests: 'npm test', shell: { enabled: true } });
    const result = await exec(toolkit, 'npm test', 'run_tests', 700_000);
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
    expect(result).toContain('700000ms');
    expect(result).toContain('600000ms');
  });

  /**
   * Run one command, let `advanceMs` of fake time pass, then close it with a null code, and hand
   * back the model-facing body.
   *
   * **The kill is observed through the BODY, not through `child.kill`.** `killProcessGroup` no-ops
   * on a child with no numeric `pid`, and giving the mock a real one would make the POSIX branch
   * signal an actual process group from a unit test. The body is the better probe anyway: it is
   * what the model reads, so a timer that fired without changing the observation is not a kill.
   */
  const bodyAfterAdvancing = async (
    commands: Record<string, unknown>,
    advanceMs: number,
    requestedTimeoutMs?: number
  ): Promise<string> => {
    vi.useFakeTimers();
    try {
      const mock = makeChild();
      childProcessMock.spawn.mockReturnValueOnce(mock.child as never);
      const toolkit = new GthDevToolkit(commands as never);
      const promise = exec(toolkit, 'sleep 999', 'run_shell_command', requestedTimeoutMs);
      const captured = promise.catch((e) => e);
      await vi.advanceTimersByTimeAsync(advanceMs);
      mock.close(null);
      const settled = await captured;
      return typeof settled === 'string' ? settled : (settled as { output: string }).output;
    } finally {
      vi.useRealTimers();
    }
  };

  it('honours a per-call budget: the kill fires at the CALL’s value, not the configured one', async () => {
    // Configured default is 120000; this call asks for 5000 — a SHORTER budget, so "honoured" is
    // observable as the kill happening EARLY rather than as it merely not happening.
    const justBefore = await bodyAfterAdvancing({ shell: { enabled: true } }, 4_999, 5_000);
    expect(justBefore).toContain('exited with code null');
    expect(justBefore).not.toContain('time budget');

    const atBudget = await bodyAfterAdvancing({ shell: { enabled: true } }, 5_000, 5_000);
    // The body names the budget the CALL asked for, not the project default.
    expect(atBudget).toContain('5000ms time budget');
    expect(atBudget).not.toContain('120000ms time budget');
  });

  it('BYTE-IDENTICAL: absent the argument, the armed budget is exactly getShellTimeoutMs', async () => {
    // 120_000 is SHELL_DEFAULT_TIMEOUT_MS, which this node is forbidden from moving.
    const justBefore = await bodyAfterAdvancing({ shell: { enabled: true } }, 119_999);
    expect(justBefore).toContain('exited with code null');
    expect(justBefore).not.toContain('time budget');

    const atDefault = await bodyAfterAdvancing({ shell: { enabled: true } }, 120_000);
    expect(atDefault).toContain('120000ms time budget');
  });

  it('BYTE-IDENTICAL: an argument the schema would have rejected cannot shorten the default either', async () => {
    // The seam re-validates behind the schema, and "invalid" must mean the configured default —
    // never 0 (an immediate kill) and never NaN (a timer that never fires).
    const zero = await bodyAfterAdvancing({ shell: { enabled: true } }, 119_999, 0);
    expect(zero).toContain('exited with code null');
    const stillDefault = await bodyAfterAdvancing({ shell: { enabled: true } }, 120_000, 0);
    expect(stillDefault).toContain('120000ms time budget');
  });

  it('BYTE-IDENTICAL: absent the argument, the success body and the spawn options are unchanged', async () => {
    const mock = makeChild();
    childProcessMock.spawn.mockReturnValueOnce(mock.child as never);

    const toolkit = new GthDevToolkit({ shell: { enabled: true } });
    const promise = exec(toolkit, 'echo hi', 'run_shell_command');
    mock.emitStdout('out-1\n');
    mock.emitStderr('err-1\n');
    mock.close(0);

    // Written out as a literal, NOT rebuilt from the production template: an expectation assembled
    // the way the code assembles it agrees with any rewording of the code.
    expect(await promise).toBe(
      "Executing 'echo hi'...\n\n<COMMAND_OUTPUT>\nout-1\nerr-1\n</COMMAND_OUTPUT>\n" +
        "\n\nCommand 'echo hi' completed successfully"
    );

    const [spawnCommand, spawnOptions] = childProcessMock.spawn.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(spawnCommand).toBe('echo hi');
    // The KEY SET is pinned as well as the values: an option added to the spawn on the
    // absent-argument path would otherwise slip past a value-by-value check.
    expect(Object.keys(spawnOptions).sort()).toEqual(['cwd', 'detached', 'env', 'shell', 'stdio']);
    expect(spawnOptions.shell).toBe(true);
    expect(spawnOptions.cwd).toBe(FAKE_WORKDIR);
    expect(spawnOptions.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(spawnOptions.detached).toBe(process.platform !== 'win32');
  });

  it('BYTE-IDENTICAL on a FIXED tool: run_tests’ success and non-zero-exit bodies are unchanged', async () => {
    const toolkit = new GthDevToolkit({ run_tests: 'npm test' });

    const ok = makeChild();
    childProcessMock.spawn.mockReturnValueOnce(ok.child as never);
    const okPromise = exec(toolkit, 'npm test', 'run_tests');
    ok.emitStdout('2 passing\n');
    ok.close(0);
    expect(await okPromise).toBe(
      "Executing 'npm test'...\n\n<COMMAND_OUTPUT>\n2 passing\n</COMMAND_OUTPUT>\n" +
        "\n\nCommand 'npm test' completed successfully"
    );

    const bad = makeChild();
    childProcessMock.spawn.mockReturnValueOnce(bad.child as never);
    const badPromise = exec(toolkit, 'npm test', 'run_tests');
    const badCaptured = badPromise.catch((e) => e);
    bad.emitStdout('1 failing\n');
    bad.close(1);
    const error = (await badCaptured) as { output: string; exitCode: number | null };
    expect(error.output).toBe(
      "Executing 'npm test'...\n\n<COMMAND_OUTPUT>\n1 failing\n</COMMAND_OUTPUT>\n" +
        "\n\nCommand 'npm test' exited with code 1"
    );
    expect(error.exitCode).toBe(1);
  });

  it('THE DISTINCTION: a kill and a non-zero exit do not read as the same thing', async () => {
    vi.useFakeTimers();
    let killBody: string;
    try {
      const mock = makeChild();
      childProcessMock.spawn.mockReturnValueOnce(mock.child as never);
      const toolkit = new GthDevToolkit({ shell: { enabled: true, timeout: 50 } });
      const promise = exec(toolkit, 'long-thing', 'run_shell_command');
      const captured = promise.catch((e) => e);
      mock.emitStdout('progress-line\n');
      await vi.advanceTimersByTimeAsync(50);
      mock.close(null);
      killBody = ((await captured) as { output: string }).output;
    } finally {
      vi.useRealTimers();
    }

    const exitMock = makeChild();
    childProcessMock.spawn.mockReturnValueOnce(exitMock.child as never);
    const exitToolkit = new GthDevToolkit({ shell: { enabled: true, timeout: 50 } });
    const exitPromise = exec(exitToolkit, 'long-thing', 'run_shell_command');
    const exitCaptured = exitPromise.catch((e) => e);
    exitMock.emitStdout('progress-line\n');
    exitMock.close(7);
    const exitBody = ((await exitCaptured) as { output: string }).output;

    // What the KILL says and the exit does not.
    expect(killBody).toContain('50ms time budget');
    expect(killBody).toContain('killed by this tool');
    expect(killBody).toContain('It did not fail and it did not finish');
    expect(killBody).toContain('no exit code exists');
    expect(killBody).toContain('re-call with timeoutMs up to 600000');

    // What the EXIT says and the kill does not.
    expect(exitBody).toContain('exited with code 7');

    // The differential — exactly two legs, one per direction. These are the assertions that die
    // if the two messages are ever made to read alike, which is the node's entire point and is
    // not covered by any `toContain('…time budget')` assertion elsewhere in the suite.
    //
    // Deliberately NOT asserted: that the exit body omits the words 'killed' or 'timeoutMs'.
    // Those pass today only because the exit tail happens to be short, and the non-zero-exit path
    // is allowed to grow a recovery hint the way the spawn-error tail already has. A leg like
    // that reds on a legitimate edit while claiming the failure is about kill-vs-exit, which
    // points the next reader at the wrong thing. Keep the differential to the two phrases each
    // message owns.
    expect(killBody).not.toContain('exited with code');
    expect(exitBody).not.toContain('time budget');
  });

  it('at the ceiling, the kill offers the CONFIG move and not a timeoutMs the model cannot use', async () => {
    vi.useFakeTimers();
    try {
      const mock = makeChild();
      childProcessMock.spawn.mockReturnValueOnce(mock.child as never);
      // timeout === maxTimeout: the call already has everything the ceiling allows.
      const toolkit = new GthDevToolkit({
        shell: { enabled: true, timeout: 50, maxTimeout: 50 },
      });
      const promise = exec(toolkit, 'long-thing', 'run_shell_command');
      const captured = promise.catch((e) => e);
      await vi.advanceTimersByTimeAsync(50);
      mock.close(null);
      const body = ((await captured) as { output: string }).output;

      expect(body).toContain('already used the 50ms ceiling');
      expect(body).toContain('maxTimeout');
      // Offering `timeoutMs` here would promise a move that does not exist and cost a wasted turn.
      expect(body).not.toContain('re-call with timeoutMs up to');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a killed command still returns what it captured BEFORE the kill', async () => {
    vi.useFakeTimers();
    try {
      const mock = makeChild();
      childProcessMock.spawn.mockReturnValueOnce(mock.child as never);
      const toolkit = new GthDevToolkit({ shell: { enabled: true, timeout: 50 } });
      const promise = exec(toolkit, 'noisy-then-stuck', 'run_shell_command');
      const captured = promise.catch((e) => e);

      mock.emitStdout('step-1 done\n');
      mock.emitStderr('warning: slow\n');
      await vi.advanceTimersByTimeAsync(50);
      mock.close(null);

      const body = ((await captured) as { output: string }).output;
      // Scope item 4: the kill must not throw away the observation the command already produced —
      // that output is usually the only evidence of how far it got.
      expect(body).toContain('step-1 done');
      expect(body).toContain('warning: slow');
      expect(body).toContain('<COMMAND_OUTPUT>');
    } finally {
      vi.useRealTimers();
    }
  });
});
