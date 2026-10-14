import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXPECT_TIMEOUT_MS, Locator } from '../tui-e2e/fixtures/harness.mjs';

/**
 * QA-15 — every PTY e2e case asserts through `fixtures/harness.mjs`, and the harness's
 * `toBeVisible()` waits the suite's own bound rather than the 5000 ms fallback.
 *
 * The bound lives in one place, `EXPECT_TIMEOUT_MS` in the harness, and reaches a matcher only
 * through the harness's `toBeVisible`. Two things would silently put a case back on 5 s: a case file
 * that takes `test` / `expect` from somewhere else (vitest itself, or the engine's own
 * `getByText().expect()`, whose default is 5000 ms), or a harness whose matcher stopped reading the
 * bound. Either is invisible from a run — a matcher that resolves in 200 ms resolves identically
 * under 5 s and under 15 s — so this is the gate for both.
 *
 * `expect-timeout.tui.test.ts` proves the bound binds in a real session. This proves it binds
 * *everywhere*, and that the harness's matcher really waits it.
 *
 * Resolved as a URL, never through a native path: a `D:\…` string is not a valid URL (OPS-39).
 */
const E2E_DIR = fileURLToPath(new URL('../tui-e2e/', import.meta.url));

const read = (name: string): string => readFileSync(`${E2E_DIR}${name}`, 'utf8');

/**
 * The names a module's source imports as VALUES from a specifier ending in `/<basename>`.
 *
 * Matched on a real `import { … } from '…'` statement rather than on the bare filename, so a mention
 * of the module in a comment — which many of these files carry — is not mistaken for the import. A
 * type-only import (`import type { … }`) imports no value and contributes nothing.
 */
function valueImportsFrom(source: string, basename: string): Set<string> {
  const escaped = basename.replace(/\./g, '\\.');
  const statement = new RegExp(
    `^\\s*import\\s+(?!type\\b)\\{([^}]*)\\}\\s*from\\s+['"][^'"]*/${escaped}['"]\\s*;?\\s*$`,
    'gm'
  );
  const names = new Set<string>();
  for (const match of source.matchAll(statement)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name && !name.startsWith('type ')) names.add(name);
    }
  }
  return names;
}

/** Whether the source has a real value import from a package (or one of its subpaths). */
function importsPackage(source: string, pkg: string): boolean {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(
    `^\\s*import\\s+(?!type\\b)(?:[^'"]*\\sfrom\\s+)?['"]${escaped}(?:/[^'"]*)?['"]\\s*;?\\s*$`,
    'm'
  ).test(source);
}

/** Whether a case file takes BOTH `test` and `expect` from the harness. */
function assertsThroughHarness(source: string): boolean {
  const names = valueImportsFrom(source, 'harness.mjs');
  return names.has('test') && names.has('expect');
}

describe('QA-15 every PTY e2e case asserts through the harness', () => {
  it('detects the imports only when there is a real one', () => {
    // Control: without this the matchers could return true (or false) for everything and the
    // assertions below would pass whatever the suite actually contained.
    expect(assertsThroughHarness("import { test, expect } from './fixtures/harness.mjs';")).toBe(
      true
    );
    expect(
      assertsThroughHarness(
        "import {\n  test,\n  expect,\n  EXPECT_TIMEOUT_MS,\n} from './fixtures/harness.mjs';"
      )
    ).toBe(true);
    // Only one of the two, a type-only import, or a mention in prose is not enough.
    expect(assertsThroughHarness("import { test } from './fixtures/harness.mjs';")).toBe(false);
    expect(
      assertsThroughHarness("import type { test, expect } from './fixtures/harness.mjs';")
    ).toBe(false);
    expect(assertsThroughHarness("// import { test, expect } from './fixtures/harness.mjs';")).toBe(
      false
    );
    expect(assertsThroughHarness(" * see './fixtures/harness.mjs' for test and expect")).toBe(
      false
    );

    expect(importsPackage("import { expect } from 'vitest';", 'vitest')).toBe(true);
    expect(
      importsPackage("import { test } from '@microsoft/tui-test';", '@microsoft/tui-test')
    ).toBe(true);
    expect(
      importsPackage(
        "import { createTerminal } from '@microsoft/tui-test/test';",
        '@microsoft/tui-test'
      )
    ).toBe(true);
    expect(
      importsPackage("import type { Terminal } from '@microsoft/tui-test';", '@microsoft/tui-test')
    ).toBe(false);
    expect(
      importsPackage("// the engine, '@microsoft/tui-test', has no runner", '@microsoft/tui-test')
    ).toBe(false);
    expect(importsPackage("import { expect } from 'vitest-extra';", 'vitest')).toBe(false);
  });

  it('finds the PTY test files at all', () => {
    // An empty glob would make every per-file assertion below vacuously true, which is the exact
    // shape of a gate that cannot fail. The count is asserted as a floor rather than an equality so
    // adding a test file does not red this, while a rename or a moved directory does.
    expect(testFiles().length).toBeGreaterThanOrEqual(15);
  });

  it('every *.tui.test.ts file takes test and expect from fixtures/harness.mjs', () => {
    const unwired = testFiles().filter((name) => !assertsThroughHarness(read(name)));
    expect(unwired).toEqual([]);
  });

  it('no *.tui.test.ts file imports vitest or the engine directly', () => {
    // A second `expect` or `test` beside the harness's would be one a case could reach for by
    // accident — the engine's locator defaults to 5000 ms and is not strict.
    const direct = testFiles().filter((name) => {
      const source = read(name);
      return importsPackage(source, 'vitest') || importsPackage(source, '@microsoft/tui-test');
    });
    expect(direct).toEqual([]);
  });
});

describe('QA-15 the harness matcher waits the declared bound', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('declares a bound above the 5000 ms fallback', () => {
    expect(EXPECT_TIMEOUT_MS).toBeGreaterThan(5_000);
  });

  it('a toBeVisible() with no timeout polls until the declared bound, not 5 s', async () => {
    // Measured on the matcher itself, against a screen that never shows the text. A matcher that
    // stopped reading the bound would give up at 5 s, and only a wait past 5 s can tell the two
    // apart — which fake timers make free.
    vi.useFakeTimers();
    const screen = { getViewableBuffer: async () => [['n', 'o', 'p', 'e']] };
    const locator = new Locator(screen, 'absent', false, true);

    let settled: 'pending' | 'passed' | Error = 'pending';
    const assertion = expect(locator)
      .toBeVisible()
      .then(
        () => (settled = 'passed'),
        (err: Error) => (settled = err)
      );

    await vi.advanceTimersByTimeAsync(5_500);
    expect(settled, 'the matcher gave up at the 5 s fallback').toBe('pending');

    await vi.advanceTimersByTimeAsync(EXPECT_TIMEOUT_MS);
    await assertion;
    expect(settled).toBeInstanceOf(Error);
    expect((settled as unknown as Error).message).toContain(`after ${EXPECT_TIMEOUT_MS} ms`);
  });
});

/**
 * Every file the suite would run, found the way the suite finds them.
 *
 * Recursive, because the suite's `include` is `**` + `/*.tui.test.ts` and a flat read is not: a case
 * added in a subdirectory would run in the suite and be invisible to the gate whose whole job is
 * catching files added later. The vitest cache under `node_modules/` holds no `.tui.test.ts`.
 */
function testFiles(): string[] {
  return readdirSync(E2E_DIR, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.tui.test.ts') && !name.includes('node_modules'));
}
