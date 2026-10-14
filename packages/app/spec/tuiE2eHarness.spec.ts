import { describe, expect, it } from 'vitest';
import { Locator, Terminal, findMatches, screenBlock } from '../tui-e2e/fixtures/harness.mjs';
import {
  BASE_ENV_VAR,
  VITEST_SET_KEYS,
  encodeBaseEnv,
  restoreBaseEnv,
} from '../tui-e2e/fixtures/baseEnv.mjs';

/**
 * [[OPS-153]] — the PTY harness's matching semantics, pinned.
 *
 * Under tui-test 0.0.4 these lived in a pinned library; the harness now carries them as local code
 * behind roughly 640 assertions. Every one of them could be LOOSENED without the PTY suite noticing,
 * because a looser matcher passes everything a stricter one did. So each is asserted here, against
 * a terminal whose engine is a fake holding a fixed screen:
 *
 * - `getByText` is strict by default, and a strict locator that sees two matches fails in BOTH
 *   directions, at once;
 * - matches are counted, non-overlapping, across the whole screen;
 * - the screen is the rows joined with NO separator, so a match can run across a row boundary;
 * - an error that is not a strict violation fails `.not.toBeVisible()` too (the one tightening over
 *   0.0.4, which let it pass).
 *
 * Plus the input and buffer guarantees: a write lost on a live session throws from the next read,
 * a write refused after the program exited is ignored, and `getBuffer()` fails rather than return
 * a scrollback and viewport it could not line up.
 */

/** An engine stand-in: a fixed screen of `rows` (each padded to `cols`), and scripted writes. */
function fakeEngine(
  rows: string[],
  {
    cols = 20,
    write = async () => {},
    exited = null as number | null,
    fullText = null as string | null,
  } = {}
) {
  const grid = rows.map((r) => Array.from(r.padEnd(cols, ' ')));
  // The engine's text() omits the screen's trailing blank rows.
  const text = rows
    .map((r) => r.trimEnd())
    .join('\n')
    .replace(/\n+$/u, '');
  return {
    getSize: async () => ({ cols, rows: grid.length }),
    cells: async () => grid.flatMap((row, y) => row.map((char, x) => ({ x, y, char }))),
    text: async (opts?: { full?: boolean }) => (opts?.full ? (fullText ?? text) : text),
    write,
    state: async () => ({ exited, exit_signal: null }),
    closeQuiet: async () => {},
  };
}

const terminalOn = (rows: string[], opts = {}) => new Terminal(fakeEngine(rows, opts), 0);

describe('OPS-153 the harness locator keeps 0.0.4’s strictness', () => {
  it('getByText is strict by default: two matches fail toBeVisible at once', async () => {
    const terminal = terminalOn(['dup here', 'and dup']);
    await expect(expect(terminal.getByText('dup')).toBeVisible({ timeout: 0 })).rejects.toThrow(
      /strict mode violation: getByText\(dup\) resolved to 2 elements/
    );
  });

  it('and fails .not.toBeVisible at once too', async () => {
    const terminal = terminalOn(['dup here', 'and dup']);
    await expect(expect(terminal.getByText('dup')).not.toBeVisible({ timeout: 0 })).rejects.toThrow(
      /strict mode violation/
    );
  });

  it('a non-strict locator accepts several matches', async () => {
    const terminal = terminalOn(['dup here', 'and dup']);
    await expect(terminal.getByText('dup', { strict: false })).toBeVisible({ timeout: 0 });
  });

  it('a strict locator with exactly one match passes, and its absence passes .not', async () => {
    const terminal = terminalOn(['only once']);
    await expect(terminal.getByText('once')).toBeVisible({ timeout: 0 });
    await expect(terminal.getByText('absent')).not.toBeVisible({ timeout: 0 });
  });

  it('the strict check is in the scan itself, for a Locator built directly', async () => {
    const terminal = terminalOn(['ab', 'ab']);
    await expect(new Locator(terminal, 'ab', false, true).scanOnce()).rejects.toThrow(
      /strict mode violation/
    );
    await expect(new Locator(terminal, 'ab', false, false).scanOnce()).resolves.toBe(2);
  });
});

describe('OPS-153 the harness counts matches as 0.0.4 did', () => {
  it('counts every non-overlapping hit of a string', () => {
    expect(findMatches('ab', 'xxabyyabzz')).toEqual([
      { index: 2, length: 2 },
      { index: 6, length: 2 },
    ]);
    // Non-overlapping: "aaaa" holds "aa" twice, not three times; "aaa" holds it once.
    expect(findMatches('aa', 'aaaa')).toHaveLength(2);
    expect(findMatches('aa', 'aaa')).toHaveLength(1);
    expect(findMatches('zz', 'abc')).toEqual([]);
  });

  it('counts every hit of a global regex', () => {
    expect(findMatches(/a./g, 'abxacx')).toHaveLength(2);
  });

  it('joins rows with NO separator, so the padding is what separates them', () => {
    expect(
      screenBlock([
        ['a', 'b'],
        ['c', 'd'],
      ])
    ).toBe('abcd');
    // A match can run across the boundary between two rows, as it could in 0.0.4.
    expect(
      findMatches(
        'bc',
        screenBlock([
          ['a', 'b'],
          ['c', 'd'],
        ])
      )
    ).toHaveLength(1);
  });
});

describe('OPS-153 a locator error is a failure in both directions', () => {
  it('a regex without the g flag fails toBeVisible', async () => {
    const terminal = terminalOn(['abc']);
    await expect(expect(terminal.getByText(/abc/)).toBeVisible({ timeout: 0 })).rejects.toThrow(
      TypeError
    );
  });

  it('and fails .not.toBeVisible, where 0.0.4 let it pass', async () => {
    const terminal = terminalOn(['abc']);
    await expect(expect(terminal.getByText(/zzz/)).not.toBeVisible({ timeout: 0 })).rejects.toThrow(
      TypeError
    );
  });
});

describe('OPS-153 the harness input and buffer guarantees', () => {
  it('a write refused on a live session throws from the next read', async () => {
    const terminal = terminalOn(['screen'], {
      write: async () => {
        throw new Error('EIO');
      },
    });
    terminal.write('x');
    await expect(terminal.getViewableBuffer()).rejects.toThrow(
      /a write to the running program failed: EIO/
    );
  });

  it('a write refused after the program exited is ignored, as 0.0.4 ignored it', async () => {
    const terminal = terminalOn(['screen'], {
      exited: 0,
      write: async () => {
        throw new Error('EIO');
      },
    });
    terminal.write('x');
    const grid = await terminal.getViewableBuffer();
    expect(grid[0].join('').trimEnd()).toBe('screen');
  });

  it('getBuffer() returns scrollback above the screen when they line up', async () => {
    const terminal = terminalOn(['two', 'three'], { fullText: 'one\ntwo\nthree' });
    const rows = (await terminal.getBuffer()).map((row: string[]) => row.join('').trimEnd());
    expect(rows).toEqual(['one', 'two', 'three']);
  });

  it('getBuffer() keeps the screen’s trailing blank rows that the full text omits', async () => {
    const terminal = terminalOn(['one', 'two', '', ''], { fullText: 'zero\none\ntwo' });
    const rows = (await terminal.getBuffer()).map((row: string[]) => row.join('').trimEnd());
    expect(rows).toEqual(['zero', 'one', 'two', '', '']);
  });

  it('getBuffer() fails rather than return rows it could not line up', async () => {
    const terminal = terminalOn(['two', 'three'], { fullText: 'three' });
    await expect(terminal.getBuffer()).rejects.toThrow(
      /visible line count was impossible on 5 reads/
    );
  });
});

describe('OPS-153 the CI retry count', () => {
  it('retries twice on CI and never locally', async () => {
    // The config reads CI when it loads, so each reading is a fresh import of it.
    const saved = process.env.CI;
    try {
      process.env.CI = 'true';
      const onCi = (await import('../tui-e2e/vitest.config.mjs?ci=on')).default as any;
      delete process.env.CI;
      const local = (await import('../tui-e2e/vitest.config.mjs?ci=off')).default as any;
      expect(onCi.test.retry).toBe(2);
      expect(local.test.retry).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.CI;
      else process.env.CI = saved;
    }
  });
});

describe('OPS-153 the base environment handed to the workers', () => {
  const runnerEnv = {
    PATH: '/bin',
    SECRET_API_KEY: 'sk-live-do-not-write-me',
    NODE_ENV: 'production',
    GTH_E2E_RESULTS: '/tmp/r.json',
  };

  it('carries names, and values only for the keys vitest sets', () => {
    const encoded = encodeBaseEnv(runnerEnv, 'linux');
    expect(encoded).not.toContain('sk-live-do-not-write-me');
    expect(encoded).not.toContain('/bin');
    expect(JSON.parse(encoded).names).toEqual(Object.keys(runnerEnv));
    expect(JSON.parse(encoded).restore.NODE_ENV).toBe('production');
    expect(JSON.parse(encoded).restore.VITEST).toBeNull();
  });

  it('puts a worker back to exactly the runner’s environment', () => {
    const encoded = encodeBaseEnv(runnerEnv, 'linux');
    // What a vitest worker starts with: the runner's keys, vitest's additions and overwrites.
    const worker: Record<string, string | undefined> = {
      ...runnerEnv,
      ...Object.fromEntries(VITEST_SET_KEYS.map((key) => [key, 'vitest'])),
      [BASE_ENV_VAR]: encoded,
    };
    restoreBaseEnv(worker, encoded, 'linux');
    expect(worker).toEqual(runnerEnv);
  });

  it('matches names case-insensitively on win32, as the environment does', () => {
    const encoded = encodeBaseEnv({ Path: 'C:\\x', node_env: 'production' }, 'win32');
    const worker: Record<string, string | undefined> = {
      Path: 'C:\\x',
      NODE_ENV: 'test',
      VITEST: 'true',
    };
    restoreBaseEnv(worker, encoded, 'win32');
    expect(worker).toEqual({ Path: 'C:\\x', NODE_ENV: 'production' });
  });

  it('refuses something the runner did not write', () => {
    expect(() => restoreBaseEnv({}, '{"names": 1}', 'linux')).toThrow(/is not what/);
  });
});
