import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusLevel } from '#src/core/types.js';
import { resetConsoleLevel, setConsoleLevel } from '#src/utils/consoleLevel.js';

/**
 * [[TUI-C110]] — the tenth construction site: `reading STDIN`, the manual-mode indicator
 * `systemUtils.readStdin` draws while a piped run waits for its input to end.
 *
 * This site is gated like the other nine, with no exemption of its own, and what these cells pin is
 * the WIRING: the label, the dots and the terminating newline all follow the one gate. The argument
 * for gating a line that reports on the user's own input is at the construction site in
 * `systemUtils.ts`.
 *
 * **What these cells cannot see.** This line is written before `program.parseAsync()`, so whether a
 * real run is quiet depends on the level being resolved before the parse — which the CLI does, from
 * the config, on the piped branch ([[REL-25]]; `cli.ts`, `loadConfiguredConsoleLevel`). Nothing in
 * this file exercises that ordering, and an in-process cell never could: it sets the level itself,
 * in whatever order it likes. The evidence that a piped `gth` at `consoleLevel: "display"` prints
 * nothing is `packages/app/spec/stdinNoticeConsoleLevel.e2e.spec.ts`, which spawns the built CLI.
 *
 * `readStdin` reads `systemUtils`' own module-level `stdin`/`stdout` bindings, which are captured
 * from `process` when the module is evaluated — so the seam here is the global `process` itself,
 * replaced before the module is imported, exactly as `systemUtils.spec.ts` does it. `systemUtils`
 * itself is NOT mocked: it is the module under test.
 */
const stdoutWriteMock = vi.fn();
const stdinHandlers: Record<string, (this: unknown) => void> = {};

const realProcess = globalThis.process;
const processMock = {
  stdin: {
    isTTY: false,
    on: vi.fn((event: string, handler: (this: unknown) => void) => {
      stdinHandlers[event] = handler;
    }),
    read: vi.fn(() => null),
    setRawMode: vi.fn(),
    off: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    isPaused: vi.fn(),
  },
  stdout: { write: stdoutWriteMock },
  stderr: { write: vi.fn() },
  argv: ['node', 'gth', 'review'],
  env: {},
  versions: { node: '24.0.0' },
  on: vi.fn(),
  exit: vi.fn(),
  cwd: vi.fn(() => '/project'),
};

Object.defineProperty(globalThis, 'process', { value: processMock, writable: true });

/** Everything written to the terminal by the site under test, in order, as one string. */
const written = (): string => stdoutWriteMock.mock.calls.map((call) => call[0]).join('');

/** Drive one piped read: two chunks arrive, then EOF. */
async function pipedRun(): Promise<void> {
  const { readStdin } = await import('#src/utils/systemUtils.js');
  const program = {
    getOptionValue: () => undefined,
    parseAsync: vi.fn().mockResolvedValue(undefined),
  };

  const done = readStdin(program);
  stdinHandlers['readable']?.call(processMock.stdin);
  stdinHandlers['readable']?.call(processMock.stdin);
  stdinHandlers['end']?.call(processMock.stdin);
  await done;
}

describe('progress-line gating, per construction site: readStdin (reading STDIN)', () => {
  beforeEach(() => {
    stdoutWriteMock.mockClear();
    for (const key of Object.keys(stdinHandlers)) delete stdinHandlers[key];
  });

  afterEach(() => {
    resetConsoleLevel();
  });

  // The stand-in `process` has to outlive every cell — `systemUtils` captures `stdin`/`stdout` from
  // it when the module is imported, which happens inside the cells — so it is put back here rather
  // than at the end of the file.
  afterAll(() => {
    Object.defineProperty(globalThis, 'process', { value: realProcess, writable: true });
  });

  /**
   * The byte-identity evidence for this site: the label, a dot per chunk, and the newline `stop()`
   * writes before the command's own first line — the run header has to start at column 0
   * (`maintenance/ux-guidelines.md`).
   */
  it('draws its line, and nothing more, at the default info level', async () => {
    await pipedRun();

    expect(written()).toBe('reading STDIN..\n');
  });

  it('consults the same gate as every other site — nothing drawn at consoleLevel display', async () => {
    setConsoleLevel(StatusLevel.DISPLAY);

    await pipedRun();

    expect(written()).toBe('');
  });

  it('and nothing at consoleLevel error, including the terminating newline', async () => {
    setConsoleLevel(StatusLevel.ERROR);

    await pipedRun();

    expect(written()).toBe('');
  });
});
