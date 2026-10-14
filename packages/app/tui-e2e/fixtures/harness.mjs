/**
 * [[OPS-153]] — the PTY e2e harness: the `test` / `expect` / `terminal` surface this suite was
 * written against, rebuilt on `@microsoft/tui-test` 0.1 and vitest.
 *
 * tui-test 0.1 replaced the package rather than updating it. It ships a terminal engine and a
 * `TuiTest` client — no runner, no `test`, no `expect`, no `Terminal`. Every case in this folder
 * imports `test` and `expect` from HERE instead, and this module keeps the meaning of what they
 * assert. It does that by reading the screen itself rather than through the engine's own
 * `getByText().expect()`, because the engine's locator means something different, measured:
 *
 * - **Strictness.** 0.0.4's `getByText(text)` was strict by default: a matcher that saw MORE than
 *   one match failed at once, in both directions. The engine's default selects `any`, which would
 *   quietly turn every one of this suite's ~640 `toBeVisible()` calls into "at least one".
 * - **Padding.** 0.0.4 scanned the visible rows padded to the full width and joined with no
 *   separator, so a match could run across a row boundary and a run of spaces meant empty cells.
 *   The engine's `text()` trims trailing blanks, and `EMPTY_PROMPT` (readlinePrompt.mjs) is a run
 *   of spaces — it would never match.
 * - **Wide characters.** The engine's emulator draws emoji such as `⚡` and `⛔` two cells wide and
 *   reports the second cell as `""`. 0.0.4's emulator drew them ONE cell wide, so its rows read
 *   `⚡ Bypass` where a space-filled second cell would read `⚡  Bypass` (measured: the two cases that
 *   assert on those glyphs failed exactly so). This module drops the `""` cell, so a row reads as
 *   the text the app wrote — which is what 0.0.4's rows read for every glyph this suite uses. A
 *   row holding a wide character is one entry shorter than the width, as the text it holds is. (The
 *   suite asserts on no CJK text, the one case where 0.0.4 did insert a space.)
 * - **Regex.** The engine takes a pattern string for its own regex dialect. 0.0.4 ran the
 *   JavaScript `RegExp` through `String.prototype.matchAll`, which is what `EMPTY_PROMPT` and its
 *   spec are written against.
 *
 * So a locator here is resolved exactly as 0.0.4's `lib/terminal/locator.js` resolved it — `cells()`
 * of the viewport, the `""` half of a wide character dropped, rows joined with no separator, a string by repeated
 * `indexOf` and a regex by `matchAll`, polled every 50 ms — and `toBeVisible` keeps 0.0.4's
 * `lib/test/matchers/toBeVisible.js` outcome table. `cells()` costs about 0.3 ms for a 120x40
 * screen, measured, so the poll is cheap.
 *
 * **What the engine IS used for:** the pty, the terminal emulator (the `xtermjs` backend, the same
 * emulator 0.0.4 embedded), input, resize, size and cells.
 *
 * **The traps this module carries, each measured on OPS-11's probe (2026-10-14) or here:**
 *
 * 1. **The engine layers `run()`'s `env` over this process's own environment**, so a key cannot be
 *    removed through it. 0.0.4 handed node-pty the case's env as the WHOLE environment. To keep
 *    that, {@link Terminal.spawn} deletes from `process.env`, for the duration of the spawn, every
 *    key the case's env does not carry, and restores them after (measured: the child then sees
 *    exactly the requested env, no more and no less). `CI` and `GTH_NO_TUI` are also deleted from
 *    this process up front by `vitest.setup.mjs`, after the config has read `CI` for retries.
 * 2. **Enter has to arrive as a read of its own** — `PromptEditor.tsx` treats `text\r` in one chunk
 *    as a paste. Input here is byte-for-byte what 0.0.4 sent: `write(x)` writes `x`, `submit(x)`
 *    writes `x + "\r"` in one write, `submit()` writes `"\r"` alone. The engine's own `submit`,
 *    `type` and `press` are never used, because their bytes and chunking are not 0.0.4's.
 * 3. **The engine's exit-code helpers track shell commands, not the program.** {@link Terminal.onExit}
 *    reads `state().exited` / `state().exit_signal`.
 * 4. **The engine's `signal('TERM')` delivers SIGHUP and then kills.** A real signal goes to the
 *    program's pid ({@link Terminal.pid}, the `shell_pid` of `run()`, measured to be the program's
 *    own pid) through `process.kill`, which is also what 0.0.4's `kill()` did (`process.kill(pid, 9)`).
 *
 * **Input ordering.** 0.0.4's `write()` was synchronous; the engine's is a promise. Writes here are
 * queued in call order and every read of the screen waits for the queue first, so a case that
 * writes and then asserts sees its write delivered, exactly as before. A write after the program
 * has exited is ignored, as 0.0.4 ignored it.
 *
 * **Two writes stay two reads.** Under 0.0.4 each write was its own `write(2)` on the pty, and a
 * program that was waiting for input read them separately. The engine resolves a write before the
 * program has read it, and with nothing between two writes they often reach the program as ONE
 * chunk — which the TUI reads as a paste, so the return becomes a newline and the message is never
 * sent (the `/compact` "after three turns" case failed exactly so). Each write is therefore followed
 * by a short pause, {@link WRITE_GAP_MS}, before the next one goes out; the measurements are there.
 *
 * **Screen frames.** 0.0.4's emulator was JavaScript on the test's own event loop: it parsed the
 * program's output in its own callbacks, so the screen could only change when the event loop
 * turned, and reads were synchronous. Two assertions in a row, with no wait between them, therefore
 * saw the SAME screen — and cases rely on it (measured: TUI-C17's "folds streamed tool output" case
 * checks two strings back to back while a second copy of both is about to paint; on 0.0.4 it passes
 * under full CPU load, and with a fresh read per assertion it failed every attempt on the ubuntu CI
 * cell and on every loaded local run). The engine here parses on its own thread, so the screen moves
 * between any two reads. To keep the old meaning, a read of the visible screen is held until the
 * event loop next turns (`setImmediate`), and any input drops it at once. A poll still re-reads every
 * 50 ms, exactly as before; only reads with nothing but promise continuations between them share a
 * frame, which is what 0.0.4 gave them.
 *
 * **The 5 s before every case body is kept.** 0.0.4 raced the program's exit against a fixed 5 s
 * after spawning, before running the body (`lib/runner/worker.js`). Cases were written under that
 * wait, and a case whose first assertion is a `not.toBeVisible()` or a buffer read meant something
 * only because the app had had those 5 s to paint. Dropping it is a separate, audited change, not a
 * side effect of moving engines.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, test as vitestTest } from 'vitest';
import { TuiTest } from '@microsoft/tui-test';

/**
 * [[QA-15]] — how long `toBeVisible()` / `not.toBeVisible()` poll before failing, in milliseconds.
 *
 * The one place the number is written. It is 3x the 5000 ms that 0.0.4 fell back to, and that the
 * engine's own `getByText().expect()` still defaults to — so a case that bypassed this module would
 * silently be back on 5 s. `expect-timeout.tui.test.ts` is the case that can tell the two apart, and
 * `spec/tuiE2eExpectTimeoutWired.spec.ts` keeps every case file going through this module.
 */
export const EXPECT_TIMEOUT_MS = 15_000;

/**
 * The pause after each write before the next queued write goes out. See "Two writes stay two
 * reads" in the module docblock.
 *
 * Measured on Linux only, with a raw-mode probe that records each chunk it reads, driving 50
 * `write('abc'); submit()` pairs per run (a 3-byte payload), counting pairs that arrived as one chunk:
 *
 * | writes             | idle runs           | runs under full CPU load |
 * | ------------------ | ------------------- | ------------------------ |
 * | 0.0.4 (node-pty)   | 0 of 50 (1 run)     | 0 of 50 (1 run)          |
 * | this engine, no pause | 13, 26, 23, 22 of 50 | 1, 1 of 50          |
 * | 1 ms pause         | 0 of 50 (4 runs)    | 0 of 50 (2 runs)         |
 * | 5 ms pause         | 0 of 50 (2 runs)    | 0 of 50 (2 runs)         |
 *
 * 5 ms rather than 1 for margin on slower hosts; Windows was not measured.
 */
const WRITE_GAP_MS = 5;

/** The poll interval 0.0.4's locator used (`lib/utils/poll.js`). */
const POLL_MS = 50;

/** The engine backend. `xtermjs` is the emulator 0.0.4 embedded, and the one OPS-11's probe proved on all three OSes. */
const BACKEND = 'xtermjs';

/** xterm.js's default scrollback, which is what 0.0.4's headless terminal ran with. */
const SCROLLBACK_ROWS = 1000;

/** 0.0.4's default terminal size, used by a describe that sets none. */
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 30;

/** 0.0.4's fixed wait between spawning a program and running the case body. See the module docblock. */
const PRE_BODY_WAIT_MS = 5_000;

/** The bytes 0.0.4's key helpers wrote (`lib/terminal/ansi.js`). */
const KEYS = {
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
  escape: '\u001b',
  delete: '\u001b[3~',
  backspace: '\u007f',
  ctrlC: '\u0003',
  ctrlD: '\u0004',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The string 0.0.4's locator scanned: every row of the grid joined with NO separator.
 *
 * The rows are padded to the full width by construction, so the padding is what keeps the end of
 * one row from running into the start of the next. Exported so the QA-49 control spec scans the
 * same string this module scans, instead of a hand-written model of it.
 *
 * @param {string[][]} grid rows of cell strings
 * @returns {string}
 */
export function screenBlock(grid) {
  return grid.map((row) => row.join('')).join('');
}

/**
 * Every match of `pattern` in `block`, as 0.0.4 found them: a string by repeated `indexOf` stepping
 * past each hit (non-overlapping), a `RegExp` by `matchAll` — which throws a TypeError for a pattern
 * without the `g` flag rather than reporting no match.
 *
 * @param {string | RegExp} pattern
 * @param {string} block
 * @returns {{ index: number, length: number }[]}
 */
export function findMatches(pattern, block) {
  if (typeof pattern === 'string') {
    const hits = [];
    let index = 0;
    while ((index = block.indexOf(pattern, index)) > -1) {
      hits.push({ index, length: pattern.length });
      index += pattern.length;
    }
    return hits;
  }
  return Array.from(block.matchAll(pattern)).map((m) => ({ index: m.index, length: m[0].length }));
}

/** 0.0.4's prefix for a strict-mode violation (`lib/utils/constants.js`). */
const STRICT_MODE_PREFIX = 'strict mode violation';

class StrictModeViolation extends Error {}

/**
 * A text locator with 0.0.4's semantics. Created by {@link Terminal.getByText}; asserted on with
 * `expect(locator).toBeVisible()`.
 */
export class Locator {
  #terminal;
  #text;
  #full;
  #strict;

  constructor(terminal, text, full, strict) {
    this.#terminal = terminal;
    this.#text = text;
    this.#full = full;
    this.#strict = strict;
  }

  /** The search term, as 0.0.4's `searchTerm()` returned it. */
  searchTerm() {
    return this.#text;
  }

  /** One scan of the current screen: the number of matches, or a strict-mode violation. */
  async scanOnce() {
    const grid = this.#full
      ? await this.#terminal.getBuffer()
      : await this.#terminal.getViewableBuffer();
    const matches = findMatches(this.#text, screenBlock(grid));
    if (matches.length > 1 && this.#strict) {
      throw new StrictModeViolation(
        `${STRICT_MODE_PREFIX}: getByText(${this.#text.toString()}) resolved to ${matches.length} elements`
      );
    }
    return matches.length;
  }

  /**
   * 0.0.4's `resolve(timeout, isNot)`: poll until the locator is found (or, for `isNot`, until it is
   * not), checking the deadline only after a scan, so a zero timeout still scans once.
   *
   * @returns {Promise<boolean>} whether it was visible when the poll ended
   */
  async resolve(timeout, isNot) {
    const started = Date.now();
    for (;;) {
      const found = (await this.scanOnce()) > 0;
      if (!isNot && found) return true;
      if (isNot && !found) return false;
      if (started + timeout < Date.now()) return isNot;
      await sleep(POLL_MS);
    }
  }

  /** The visible rows, trimmed, for a failure message — what 0.0.4 printed under "Terminal content". */
  async snapshot() {
    try {
      const grid = this.#full
        ? await this.#terminal.getBuffer()
        : await this.#terminal.getViewableBuffer();
      return grid.map((row) => row.join('').trimEnd()).join('\n');
    } catch (err) {
      return `<screen unavailable: ${err instanceof Error ? err.message : String(err)}>`;
    }
  }
}

expect.extend({
  /**
   * 0.0.4's `toBeVisible`, outcome for outcome:
   *
   * | case                                     | `toBeVisible()` | `.not.toBeVisible()` |
   * | ---------------------------------------- | --------------- | -------------------- |
   * | found exactly once within the timeout    | pass            | —                    |
   * | never found                              | fail            | pass (as soon as it is absent) |
   * | still present when the timeout ends      | —               | fail                 |
   * | found more than once (strict, default)   | fail at once    | fail at once         |
   *
   * One deliberate tightening: an error that is not a strict-mode violation (a regex without the
   * `g` flag, a dead session) fails the assertion in both directions. 0.0.4 reported it as "not
   * visible", which let a `.not.toBeVisible()` pass on a locator that could never match anything.
   */
  async toBeVisible(received, options) {
    if (!(received instanceof Locator)) {
      throw new TypeError('toBeVisible() expects a locator from terminal.getByText()');
    }
    const timeout = options?.timeout ?? EXPECT_TIMEOUT_MS;
    const term = received.searchTerm().toString();
    let visible;
    try {
      visible = await received.resolve(timeout, this.isNot);
    } catch (err) {
      if (err instanceof StrictModeViolation) {
        const screen = await received.snapshot();
        return {
          pass: this.isNot,
          message: () =>
            `expect(terminal).${this.isNot ? 'not.' : ''}toBeVisible(${term})\n\n${err.message}\n\n` +
            `Terminal content:\n---START---\n${screen}\n---END---`,
        };
      }
      throw err;
    }
    const screen = await received.snapshot();
    return {
      pass: visible,
      message: () =>
        this.isNot
          ? `expect(terminal).not.toBeVisible(${term})\n\nStill visible after ${timeout} ms.\n\n` +
            `Terminal content:\n---START---\n${screen}\n---END---`
          : `locator timeout: getByText(${term}) resolved to 0 elements after ${timeout} ms\n\n` +
            `Terminal content:\n---START---\n${screen}\n---END---`,
    };
  },
});

export { expect };

/**
 * Resolve a program name the way 0.0.4 did (`which`, from PATH), so a bare `node` means the same
 * binary it meant before. An absolute or relative path is taken as given.
 */
function which(file) {
  if (path.isAbsolute(file) || file.includes('/') || file.includes('\\')) return file;
  const exts =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
      : [''];
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, file + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  throw new Error(`unable to spawn terminal, unable to resolve file '${file}' from PATH`);
}

/**
 * Run `fn` with `process.env` holding no key that `target` does not carry, then put them back.
 * See trap 1 in the module docblock. Keys compare case-insensitively on win32, where the
 * environment does.
 */
async function withExactEnv(target, fn) {
  const norm = process.platform === 'win32' ? (key) => key.toUpperCase() : (key) => key;
  const wanted = new Set(Object.keys(target).map(norm));
  const removed = {};
  for (const key of Object.keys(process.env)) {
    if (!wanted.has(norm(key))) {
      removed[key] = process.env[key];
      delete process.env[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(removed)) process.env[key] = value;
  }
}

/**
 * The terminal a case receives as `{ terminal }`: 0.0.4's `Terminal` surface over a `TuiTest`
 * session. Reads are async here where they were sync in 0.0.4 — the one change a case has to make.
 */
export class Terminal {
  #tt;
  #pid;
  #io = Promise.resolve();
  #exit = null;
  #disposed = false;

  constructor(tt, pid) {
    this.#tt = tt;
    this.#pid = pid;
  }

  /**
   * Spawn a case's program with the options its describe's `test.use` set.
   *
   * @param {{ program?: { file: string, args?: string[] }, env?: Record<string, string | undefined>, columns?: number, rows?: number }} options
   */
  static async spawn(options) {
    if (!options.program) {
      throw new Error(
        'this harness runs programs only: every describe sets test.use({ program }). A shell ' +
          'session was never used by this suite and is not ported.'
      );
    }
    const file = which(options.program.file);
    const env = Object.fromEntries(
      Object.entries(options.env ?? process.env).filter(([, value]) => value !== undefined)
    );
    const tt = TuiTest.ephemeral('gth-e2e', {
      backend: BACKEND,
      profile: { scrollback: SCROLLBACK_ROWS },
    });
    try {
      const opened = await withExactEnv(env, () =>
        tt.run(file, options.program.args ?? [], {
          cols: options.columns ?? DEFAULT_COLUMNS,
          rows: options.rows ?? DEFAULT_ROWS,
          // 0.0.4 spawned with the runner's cwd, which is this suite's folder.
          cwd: process.cwd(),
          env,
        })
      );
      return new Terminal(tt, opened.shell_pid);
    } catch (err) {
      await tt.closeQuiet();
      throw err;
    }
  }

  /** The program's own pid (the engine's `shell_pid`), for delivering a real signal. */
  get pid() {
    return this.#pid;
  }

  #enqueue(action) {
    // Input moves the screen on, so nothing read before it may answer a read after it.
    this.#frame = null;
    const next = this.#io.then(async () => {
      if (this.#disposed || this.#exit !== null || this.#inputError) return;
      try {
        await action();
      } catch (err) {
        // 0.0.4 ignored a write the pty refused after the program exited, and only that. A write
        // lost on a live session is kept and thrown from the next read, so an assertion that
        // follows it cannot pass on a screen the input never reached.
        if ((await this.readExit().catch(() => null)) === null && !this.#disposed) {
          this.#inputError = err instanceof Error ? err : new Error(String(err));
        }
      }
    });
    this.#io = next;
    return next;
  }

  /** Write raw data to the program, in call order with every other write. */
  write(data) {
    return this.#enqueue(async () => {
      await this.#tt.write(data);
      // Keep two writes two reads (see "Input ordering" in the module docblock).
      await sleep(WRITE_GAP_MS);
    });
  }

  /** Write `data` followed by a carriage return, in ONE write — as 0.0.4 did. */
  submit(data) {
    return this.write(`${data ?? ''}\r`);
  }

  keyUp(count = 1) {
    return this.write(KEYS.up.repeat(count));
  }
  keyDown(count = 1) {
    return this.write(KEYS.down.repeat(count));
  }
  keyLeft(count = 1) {
    return this.write(KEYS.left.repeat(count));
  }
  keyRight(count = 1) {
    return this.write(KEYS.right.repeat(count));
  }
  keyEscape(count = 1) {
    return this.write(KEYS.escape.repeat(count));
  }
  keyDelete(count = 1) {
    return this.write(KEYS.delete.repeat(count));
  }
  keyBackspace(count = 1) {
    return this.write(KEYS.backspace.repeat(count));
  }
  keyCtrlC(count = 1) {
    return this.write(KEYS.ctrlC.repeat(count));
  }
  keyCtrlD(count = 1) {
    return this.write(KEYS.ctrlD.repeat(count));
  }

  /** Resize the terminal (pty and emulator), queued with the writes. */
  resize(columns, rows) {
    return this.#enqueue(() => this.#tt.resize(columns, rows));
  }

  /** A locator, strict unless `{ strict: false }` — 0.0.4's default. */
  getByText(text, options) {
    return new Locator(this, text, options?.full, options?.strict ?? true);
  }

  /** A write the engine refused while the program was still running; thrown from every read. */
  #inputError = null;

  /** Wait for every queued write, then read. */
  async #settled() {
    await this.#io;
    if (this.#inputError) {
      throw new Error(`a write to the running program failed: ${this.#inputError.message}`, {
        cause: this.#inputError,
      });
    }
  }

  /**
   * The visible grid: one array of cell strings per row, blank cells as `" "`, the `""` second half
   * of a wide character dropped (see the module docblock) — 0.0.4's `getViewableBuffer()`.
   */
  async getViewableBuffer() {
    await this.#settled();
    if (this.#frame !== null) return this.#frame;
    const { cols, rows } = await this.#tt.getSize();
    const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
    for (const cell of await this.#tt.cells(0, 0, cols, rows)) {
      if (cell.y < rows && cell.x < cols) grid[cell.y][cell.x] = cell.char;
    }
    const frame = grid.map((row) => row.filter((char) => char !== ''));
    this.#holdFrame(frame);
    return frame;
  }

  /**
   * The screen as last read, held until the event loop next turns (see "Screen frames" in the
   * module docblock), or null when the next read must go to the engine.
   * Held: `getViewableBuffer()`, and so every locator. Not held: `serialize()`, `getCursor()` and
   * `getBuffer()`, which always read the engine afresh.
   */
  #frame = null;

  #holdFrame(frame) {
    this.#frame = frame;
    setImmediate(() => {
      if (this.#frame === frame) this.#frame = null;
    });
  }

  /**
   * The whole buffer, scrollback first, as rows of cell strings — 0.0.4's `getBuffer()`.
   *
   * Built from ONE `text({ full: true })` read, because that is the one read the engine takes
   * atomically: the engine parses on its own thread, so a cells read and a text read taken one
   * after the other can see different screens. Measured: under CPU load an animated status row (the
   * "Thinking…" spinner) differed between two consecutive reads on every one of five attempts, and
   * a redraw once left the full text at 3 lines against a 50-line viewport. `text()` reads a wide
   * character as the one character it is, as {@link getViewableBuffer} does, so each line padded to
   * the width is the row 0.0.4 returned.
   *
   * The full text omits the viewport's trailing blank rows; their count comes from a `text()` read
   * of the viewport (the screen minus its trailing blanks). Only that COUNT is taken from the second
   * read, and a count that cannot be right — more visible lines than the screen has rows, or than
   * the full text holds — is re-read, and after five reads fails rather than return rows a case's
   * row arithmetic would then misplace.
   *
   * It does not use the held frame, so it can see a LATER screen than the locator that ran just
   * before it, where in 0.0.4 the two shared one screen. That trade was taken on purpose. The rows
   * have to come from the full text, and the full text cannot be read together with the held cells.
   * The only way to stitch the held frame into the scrollback was the split read that threw 32
   * times on the Windows cell and 18 on ubuntu. A case that needs what a locator saw should assert
   * it through the locator, and a case that needs rows should read them from `getBuffer()` once and
   * do all its row arithmetic on that one buffer.
   */
  async getBuffer() {
    await this.#settled();
    for (let attempt = 0; ; attempt++) {
      const { cols, rows } = await this.#tt.getSize();
      const fullText = await this.#tt.text({ full: true });
      const viewText = await this.#tt.text();
      const fullLines = fullText === '' ? [] : fullText.split('\n');
      const visibleLines = viewText === '' ? 0 : viewText.split('\n').length;
      if (visibleLines <= rows && visibleLines <= fullLines.length) {
        const trailingBlank = rows - visibleLines;
        return [...fullLines, ...Array(trailingBlank).fill('')].map((line) =>
          Array.from(line.padEnd(cols, ' '))
        );
      }
      if (attempt >= 4) {
        throw new Error(
          'getBuffer(): the visible line count was impossible on 5 reads ' +
            `${POLL_MS} ms apart (more than the screen's rows or the full text's lines), so the ` +
            'trailing blank rows cannot be counted (last read: the full text has ' +
            `${fullLines.length} lines, the visible text ${visibleLines}, the screen ${rows} rows).`
        );
      }
      await sleep(POLL_MS);
    }
  }

  /**
   * 0.0.4's `serialize()`: the visible rows framed in a box (`view`), and `shifts` — the attribute
   * transitions between consecutive cells in reading order, keyed `"x,y"`. `y` is the visible row.
   * Only the attributes 0.0.4 tracked are compared; colours are compared by value.
   * Unlike `getViewableBuffer()`, this keeps the `""` half of a wide character, so `x` here counts
   * cells.
   */
  async serialize() {
    await this.#settled();
    const { cols, rows } = await this.#tt.getSize();
    const cells = await this.#tt.cells(0, 0, cols, rows);
    const byPos = new Map(cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
    const shifts = new Map();
    const lines = [];
    let prev;
    const attrs = [
      ['bg', 'bgColor'],
      ['fg', 'fgColor'],
      ['blink', 'blink'],
      ['bold', 'bold'],
      ['dim', 'dim'],
      ['inverse', 'inverse'],
      ['invisible', 'invisible'],
      ['italic', 'italic'],
      ['strike', 'strike'],
      ['underline', 'underline'],
    ];
    for (let y = 0; y < rows; y++) {
      let line = '';
      for (let x = 0; x < cols; x++) {
        const cell = byPos.get(`${x},${y}`);
        line += cell ? cell.char : ' ';
        const shift = {};
        for (const [field, name] of attrs) {
          if (prev?.[field] !== cell?.[field]) shift[name] = cell?.[field];
        }
        if (Object.keys(shift).length > 0) shifts.set(`${x},${y}`, shift);
        prev = cell;
      }
      lines.push(line);
    }
    const top = `╭${'─'.repeat(cols)}╮`;
    const bottom = `╰${'─'.repeat(cols)}╯`;
    const view = [top, ...lines.map((line) => `│${line}│`), bottom].join('\n');
    return { view, shifts };
  }

  /** Where the emulator's cursor is: `{ x, y }` on the visible grid. */
  async getCursor() {
    await this.#settled();
    const { x, y } = await this.#tt.getCursor();
    return { x, y };
  }

  /**
   * The program's exit, once there is one: `{ exitCode, signal }`, or null while it runs — 0.0.4's
   * `exitResult`, read from `state()` (trap 3). `exitCode` is null when a signal ended the program.
   */
  async readExit() {
    if (this.#exit !== null) return this.#exit;
    if (this.#disposed) return null;
    const state = await this.#tt.state();
    if (state.exited !== null || state.exit_signal !== null) {
      this.#exit = { exitCode: state.exited, signal: state.exit_signal };
    }
    return this.#exit;
  }

  /**
   * Call `callback` once the program has exited. Polled from `state()` every 10 ms — not from the
   * engine's exit-code helpers (trap 3) — so it is never synchronous: an exit already seen settles
   * on the first poll, where 0.0.4's `onExit` called back at once.
   */
  onExit(callback) {
    void (async () => {
      for (;;) {
        let exit;
        try {
          exit = await this.readExit();
        } catch {
          return;
        }
        if (exit !== null) {
          callback(exit);
          return;
        }
        if (this.#disposed) return;
        await sleep(10);
      }
    })();
  }

  /**
   * Kill the program: `process.kill(pid, 9)`, exactly what 0.0.4's node-pty `kill()` did. It does
   * not wait for the process to die — `fixtures/tmpHome.mjs` is what waits.
   */
  kill() {
    try {
      process.kill(this.#pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }

  /** 0.0.4's pre-body wait: the program's exit (plus 100 ms) or 5 s, whichever is first. */
  async preBodyWait() {
    const exited = new Promise((resolve) => this.onExit(() => setTimeout(resolve, 100)));
    await Promise.race([exited, sleep(PRE_BODY_WAIT_MS)]);
  }

  /** Kill the program and close the engine session. Safe to call twice. */
  async dispose() {
    if (this.#disposed) return;
    this.kill();
    this.#disposed = true;
    await this.#tt.closeQuiet();
  }
}

/** A describe scope: the options `test.use` set and the hooks that receive `{ terminal }`. */
const newScope = (parent) => ({
  options: {},
  beforeEach: [],
  afterEach: [],
  parent,
});

let currentScope = newScope(null);

/** The scopes from the file's root to `scope`, outermost first. */
function chainOf(scope) {
  const chain = [];
  for (let s = scope; s; s = s.parent) chain.unshift(s);
  return chain;
}

/** The options in force for a case: every enclosing scope's `test.use`, innermost last. */
function optionsOf(scope) {
  return Object.assign({}, ...chainOf(scope).map((s) => s.options));
}

/**
 * Run one case the way 0.0.4's worker did: spawn the describe's program, wait as it waited, run the
 * `beforeEach` hooks, the body and the `afterEach` hooks with `{ terminal }`, then kill the program.
 * Each attempt — including a retry — gets a fresh terminal. If vitest times the case out, its abort
 * signal disposes the terminal so the abandoned body stops polling a live session.
 */
async function runCase(scope, body, signal) {
  const terminal = await Terminal.spawn(optionsOf(scope));
  const onAbort = () => void terminal.dispose();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await terminal.preBodyWait();
    const chain = chainOf(scope);
    try {
      for (const s of chain) for (const hook of s.beforeEach) await hook({ terminal });
      await body({ terminal });
    } finally {
      for (const s of chain) for (const hook of s.afterEach) await hook({ terminal });
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await terminal.dispose();
  }
}

/**
 * Declare a case: `test(title, async ({ terminal }) => { ... })`.
 *
 * @param {string} title
 * @param {(args: { terminal: Terminal }) => unknown} body
 */
export function test(title, body) {
  const scope = currentScope;
  vitestTest(title, (context) => runCase(scope, body, context?.signal));
}

/**
 * A group of cases; `test.use` inside it applies to the group and the groups nested in it.
 *
 * The parent is taken when `test.describe` is CALLED, not when vitest runs the callback: vitest
 * collects a nested describe after the outer callback has returned, by which point the current
 * scope is the root again. Options are merged along the chain when a case runs (`optionsOf`), so a
 * `test.use` placed after a nested group still reaches it.
 */
test.describe = (title, callback) => {
  const parent = currentScope;
  describe(title, () => {
    const outer = currentScope;
    currentScope = newScope(parent);
    try {
      callback();
    } finally {
      currentScope = outer;
    }
  });
};

/** Set options for the enclosing describe: `program`, `env`, `columns`, `rows`. */
test.use = (options) => {
  Object.assign(currentScope.options, options);
};

/** A case that is never run (reported as skipped). */
test.skip = (title, body) => {
  vitestTest.skip(title, () => body);
};

/** A case run only when `shouldRun` holds, otherwise reported as skipped — 0.0.4's `test.when`. */
test.when = (shouldRun, title, body) => {
  if (shouldRun) test(title, body);
  else test.skip(title, body);
};

test.beforeAll = (fn) => beforeAll(() => fn());
test.afterAll = (fn) => afterAll(() => fn());
test.beforeEach = (fn) => {
  currentScope.beforeEach.push(fn);
};
test.afterEach = (fn) => {
  currentScope.afterEach.push(fn);
};
