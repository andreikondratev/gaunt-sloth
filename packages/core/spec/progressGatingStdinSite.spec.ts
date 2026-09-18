import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusLevel } from '#src/core/types.js';
import { resetConsoleLevel, setConsoleLevel } from '#src/utils/consoleLevel.js';

/**
 * [[TUI-C110]] — the tenth construction site: `reading STDIN`, the manual-mode indicator
 * `systemUtils.readStdin` draws while a piped run waits for its input to end.
 *
 * **Read the honest part first.** This site is gated like the other nine, and the gate cannot take
 * effect in the CLI today: `readStdin` runs BEFORE `program.parseAsync()`, and `consoleLevel` is
 * applied from the config inside the command action, i.e. after the parse — so the level in force
 * when this line is written is always the INFO default. The first cell below is the live behaviour;
 * the quiet ones pin the WIRING (this site consults the same gate as the rest, with no exemption of
 * its own) and would become user-visible the moment a level is resolvable that early. They are not
 * evidence that a piped run at `consoleLevel: "display"` is quiet today, and no other cell in this
 * repo should be read as saying so either. The argument for gating it anyway is at the construction
 * site in `systemUtils.ts`.
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
   * The live behaviour, and the byte-identity evidence for this site: the label, a dot per chunk,
   * and the newline `stop()` writes before the command's own first line — the run header has to
   * start at column 0 (`maintenance/ux-guidelines.md`).
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
