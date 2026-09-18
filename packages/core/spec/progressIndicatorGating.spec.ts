import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusLevel } from '#src/core/types.js';
import { resetConsoleLevel, setConsoleLevel } from '#src/utils/consoleLevel.js';

// ProgressIndicator writes through systemUtils' stdout wrapper (AGENTS.md: never console/process
// directly), so that is the seam every cell here asserts output on. The console LEVEL deliberately
// lives in its own module (`utils/consoleLevel.js`) and is NOT mocked anywhere in this file: the
// gate under test is the real one.
const stdoutWriteMock = vi.fn();
const systemUtilsMock = {
  stdout: { write: stdoutWriteMock },
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

/** Everything the indicator wrote, in order, as one string. */
const written = (): string => stdoutWriteMock.mock.calls.map((call) => call[0]).join('');

describe('ProgressIndicator byte stream at the default console level', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetConsoleLevel();
  });

  /**
   * [[TUI-C110]] — the byte-identity cell, and it is written to be run TWICE: once against the
   * ungated implementation and once against the gated one. The node asks for the default `info`
   * rung to be byte-identical "including the newline `stop()` writes", and an assertion on the
   * exact ordered stream is the only form of that claim which can fail — a set of
   * `toHaveBeenCalledWith` checks would pass just as happily with an extra write between them, and
   * an extra write is precisely what a gate is capable of adding.
   */
  it('writes the label, one dot per second, and the terminating newline — in that exact order', async () => {
    const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

    const indicator = new ProgressIndicator('Thinking.');
    vi.advanceTimersByTime(3000);
    indicator.stop();

    expect(stdoutWriteMock.mock.calls.map((call) => call[0])).toEqual([
      'Thinking.',
      '.',
      '.',
      '.',
      '\n',
    ]);
    expect(written()).toBe('Thinking....\n');
  });

  it('writes the label and the terminating newline and nothing else in manual mode', async () => {
    const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

    const indicator = new ProgressIndicator('reading STDIN', true);
    vi.advanceTimersByTime(5000);
    indicator.indicate();
    indicator.indicate();
    indicator.stop();

    expect(written()).toBe('reading STDIN..\n');
  });
});

describe('ProgressIndicator console-level gate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetConsoleLevel();
  });

  /**
   * The rung table. The first two rungs are the ones that keep today's behaviour; the rest are the
   * ticket: `display` is the configuration issue #445 was reported from, and `error` is the rung a
   * user reaches for when they want the CLI to stop talking altogether — which, before this, still
   * printed a label and a dot per second.
   */
  const rungs: Array<[name: string, level: StatusLevel, visible: boolean]> = [
    ['debug', StatusLevel.DEBUG, true],
    ['info (the default)', StatusLevel.INFO, true],
    ['display', StatusLevel.DISPLAY, false],
    ['success', StatusLevel.SUCCESS, false],
    ['warning', StatusLevel.WARNING, false],
    ['error', StatusLevel.ERROR, false],
    ['stream', StatusLevel.STREAM, false],
  ];

  for (const [name, level, visible] of rungs) {
    it(`${visible ? 'draws' : 'draws nothing'} at consoleLevel ${name}`, async () => {
      setConsoleLevel(level);
      const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

      const indicator = new ProgressIndicator('Thinking.');
      vi.advanceTimersByTime(2000);
      indicator.stop();

      expect(written()).toBe(visible ? 'Thinking...\n' : '');
    });
  }

  /**
   * The failure mode a naive gate produces, and the reason it gets a cell of its own: gating only
   * the label and the dots leaves `stop()` writing the terminating newline for a line that was
   * never started, so a quieted run gains a BLANK LINE exactly where it used to gain a dot line.
   * Silent output and empty output are not the same thing — a run piped into a file or a PR comment
   * shows the difference.
   */
  it('gains no blank line where the dot line used to be', async () => {
    setConsoleLevel(StatusLevel.DISPLAY);
    const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

    const indicator = new ProgressIndicator('Thinking.');
    vi.advanceTimersByTime(4000);
    indicator.stop();
    indicator.stop(); // the EXT-53 belt-and-braces stop must not conjure one either

    expect(stdoutWriteMock).not.toHaveBeenCalled();
    expect(stdoutWriteMock.mock.calls.filter((call) => call[0] === '\n')).toHaveLength(0);
    expect(written()).toBe('');
  });

  /**
   * A hidden indicator arms no interval at all. The 1s timer is an active libuv handle (EXT-53), so
   * a quieted run should not be paying for a per-second wakeup that writes nothing.
   */
  it('arms no interval when it is not going to draw', async () => {
    setConsoleLevel(StatusLevel.ERROR);
    const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

    const indicator = new ProgressIndicator('Thinking.');

    expect(vi.getTimerCount()).toBe(0);
    indicator.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * The decision is taken ONCE, when the line starts — so a level change mid-line cannot tear the
   * line in half. A started line is always closed…
   */
  it('still terminates a line it started when the level is quietened mid-line', async () => {
    const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

    const indicator = new ProgressIndicator('Thinking.');
    vi.advanceTimersByTime(1000);
    setConsoleLevel(StatusLevel.ERROR);
    vi.advanceTimersByTime(1000);
    indicator.stop();

    expect(written()).toBe('Thinking...\n');
  });

  /** …and a line that was never started stays unstarted, dots and newline alike. */
  it('draws nothing for a line it never started when the level is raised mid-line', async () => {
    setConsoleLevel(StatusLevel.DISPLAY);
    const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

    const indicator = new ProgressIndicator('Thinking.');
    setConsoleLevel(StatusLevel.INFO);
    vi.advanceTimersByTime(3000);
    indicator.stop();

    expect(written()).toBe('');
  });

  it('quietens the manual mode too — label, indicate() dots and the newline', async () => {
    setConsoleLevel(StatusLevel.DISPLAY);
    const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

    const indicator = new ProgressIndicator('reading STDIN', true);
    indicator.indicate();
    indicator.indicate();
    indicator.stop();

    expect(written()).toBe('');
  });

  /**
   * Misuse is a programming error at every rung, so the guard sits BEFORE the visibility check: a
   * quieted console must not turn a bug into silence.
   */
  it('still throws from indicate() on an automatic indicator while quietened', async () => {
    setConsoleLevel(StatusLevel.ERROR);
    const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

    const indicator = new ProgressIndicator('Thinking.');
    expect(() => indicator.indicate()).toThrow(
      'ProgressIndicator.indicate only to be called in manual mode'
    );
    indicator.stop();
  });
});
