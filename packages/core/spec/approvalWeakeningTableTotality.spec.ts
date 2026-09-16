import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EXT-182 §4.7.4 — **a hint the MCP specification adds later cannot slip into the vocabulary with
 * nobody deciding whether a move along it invalidates a saved approval.**
 *
 * `WEAKENING_MOVES` (`core/approvals/grants.ts`) is the whole of what withdraws a grant. While it
 * was a list of rows, a hint with no row read as *"this can never weaken a grant"* — which is an
 * answer nobody gave, and it fails **open**: the grant goes on covering a tool that has since
 * become more dangerous along the new dimension, with nothing logged, because nothing detected
 * anything. It is now a `Record` over the vocabulary, so the compiler refuses the release that
 * widens the vocabulary until the new hint is answered for.
 *
 * ## Why this file spawns a compiler instead of asserting in prose
 *
 * The claim is about what does not build, and no runtime assertion can hold it: `packages/core
 * /tsconfig.json` builds `src/` only, so nothing in a spec file is ever type-checked, and vitest
 * strips types without checking them. So each cell below copies `src/`, edits the copy the way a
 * release adopting a fifth hint would, runs the type-checker over it, and reads its exit status and
 * diagnostics — an ordinary runtime assertion about a real compile. It type-checks **source**, so
 * no `dist/` staleness can make it pass or fail about a previous build.
 *
 * ## The cell that carries this node, and why the obvious one does not
 *
 * *"A member added to `TOOL_ANNOTATION_HINTS` and nowhere else fails to compile"* was **already
 * true** before this table changed, and the first cell shows why: [[EXT-75]]'s fix indexes
 * `MCP_FAIL_CLOSED_ANNOTATIONS` by the hint, so a widened vocabulary reds at nine sites on its own.
 * Every one of those is about what a hint *means* — the declared and effective annotation shapes,
 * the fail-closed constant, the authored built-in sets — and a maintainer clearing them has done
 * something entirely reasonable and has not been asked this table's question.
 *
 * So the load-bearing cell is the second one: widen the vocabulary, satisfy **every other seam**,
 * and require the build to fail anyway, at the weakening table, naming the new hint. Measured
 * against the table as a list of rows, that variant compiled clean — which is exactly the silence
 * this node exists to end.
 *
 * The two controls close it from the other side. Answering the new hint with a real move compiles;
 * answering it with `NO_WEAKENING_MOVE` **also** compiles, which is the build-time statement that
 * *"no move along this hint weakens"* stayed a first-class answer rather than becoming a hole
 * somebody has to fill with fiction. They are also this file's own self-test: the edits below are
 * text-keyed, and a patch set that missed a site would leave both controls red rather than leaving
 * the second cell passing for the wrong reason.
 *
 * ## The compiler this spawns
 *
 * The repo's `typescript` devDependency — the JS compiler — run through `process.execPath`, the way
 * `coreBarrelTypeSurface.spec.ts` does and for the same reason: a `.bin` shim is a shell script on
 * Windows and would not spawn. The build runs the native compiler instead. Both were run over all
 * four variants while this was written and agreed on every one, but the diagnostics asserted below
 * are this compiler's, so moving the pin to the native one means re-reading its output rather than
 * assuming these strings survive.
 */
const CORE_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** The TypeScript compiler's own CLI entry. */
const TSC_ENTRY = createRequire(import.meta.url).resolve('typescript/lib/tsc.js');

/**
 * The hint the MCP specification has not added. Any name outside the current vocabulary does; this
 * one is spelled like a plausible future hint so a diagnostic quoting it reads as what it models.
 */
const FIFTH_HINT = 'sandboxedHint';

/** What the probe compiles with: `packages/core/tsconfig.json`, redirected at the copied tree. */
const PROBE_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    noEmit: true,
    rootDir: 'src',
    allowJs: true,
    checkJs: false,
    // The probe sits one level deeper than `packages/core`, which is also why it sits INSIDE the
    // package at all: `zod` and everything else the sources import resolve by walking up into
    // `packages/core/node_modules`, which only happens from here.
    typeRoots: ['../../../node_modules/@types'],
    paths: { '#src/*': ['./src/*'] },
  },
  include: ['src/**/*'],
  exclude: ['node_modules'],
};

/**
 * Replace text that must appear **exactly once**, and throw naming the edit when it does not.
 *
 * Every edit below is keyed on source text, so each one has two ways to go wrong quietly: matching
 * nothing leaves the probe compiling something other than what the cell describes, and matching
 * twice edits a site nobody looked at. A refused edit fails the cell with the name of the edit,
 * which is a maintenance instruction; a silent one is a false green.
 */
function substituteOnce(source: string, find: string, replace: string, what: string): string {
  const parts = source.split(find);
  if (parts.length !== 2) {
    throw new Error(
      `probe edit "${what}" matched ${parts.length - 1} sites, expected exactly 1 — the source it ` +
        'is keyed on has moved, so this probe is no longer editing what the cell describes'
    );
  }
  return parts.join(replace);
}

/** Read, transform and write one file of the copied tree. */
function editProbeFile(dir: string, relative: string, transform: (source: string) => string): void {
  const file = path.join(dir, 'src', relative);
  // `.gitattributes` checks every tracked file out LF on every platform, so the normalisation is a
  // no-op — kept because the edits are keyed on '\n' and a CRLF tree would fail all of them at once
  // on the Windows cell alone, which reads like a real regression and is not one.
  const source = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  writeFileSync(file, transform(source), 'utf8');
}

/**
 * What the release adopting a fifth hint edits, in the order the compiler asks for it.
 *
 * - `vocabulary-only` — the hint is added to `TOOL_ANNOTATION_HINTS` and nowhere else.
 * - `other-seams-satisfied` — plus everything every OTHER seam demands, and nothing about this one.
 * - `decided-with-a-move` / `decided-as-no-move` — plus this table's own answer, either way.
 */
type ProbeVariant =
  'vocabulary-only' | 'other-seams-satisfied' | 'decided-with-a-move' | 'decided-as-no-move';

/** Type-check a copy of `src/` in which the MCP hint vocabulary has gained a member. */
function typeCheckWithFifthHint(variant: ProbeVariant): { status: number | null; output: string } {
  const dir = mkdtempSync(path.join(CORE_DIR, '.hint-probe-'));
  try {
    cpSync(path.join(CORE_DIR, 'src'), path.join(dir, 'src'), { recursive: true });
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify(PROBE_TSCONFIG, null, 2) + '\n',
      'utf8'
    );

    // The one edit every variant makes: the vocabulary itself. `ToolAnnotationHint` is declared as
    // `(typeof TOOL_ANNOTATION_HINTS)[number]` on the next line, so this is the whole of "add a
    // member to the vocabulary" — the type widens with the list, with nothing else written.
    editProbeFile(dir, 'config/shell-policy.ts', (source) =>
      substituteOnce(
        source,
        "  'openWorldHint',\n] as const;",
        `  'openWorldHint',\n  '${FIFTH_HINT}',\n] as const;`,
        'widen the hint vocabulary'
      )
    );

    if (variant !== 'vocabulary-only') {
      // What a hint MEANS, which is what every other seam is about: the shape a tool declares, the
      // shape a call effectively holds, the fail-closed default an absent declaration takes, and
      // the annotations authored for our own built-in tools.
      editProbeFile(dir, 'core/approvals/annotations.ts', (source) =>
        substituteOnce(
          source,
          '  openWorldHint?: boolean;\n}',
          `  openWorldHint?: boolean;\n  ${FIFTH_HINT}?: boolean;\n}`,
          'declared annotation shape'
        )
      );
      editProbeFile(dir, 'core/approvals/matcher.ts', (source) =>
        substituteOnce(
          substituteOnce(
            source,
            '  openWorldHint: boolean;\n}',
            `  openWorldHint: boolean;\n  ${FIFTH_HINT}: boolean;\n}`,
            'effective annotation shape'
          ),
          '  openWorldHint: true,\n});',
          `  openWorldHint: true,\n  ${FIFTH_HINT}: true,\n});`,
          'fail-closed default for the new hint'
        )
      );
      editProbeFile(dir, 'core/approvals/toolAnnotationSources.ts', (source) => {
        // `authored()` takes `Required<DeclaredToolAnnotations>`, so every built-in tool's set must
        // state the new hint. Counted rather than listed: a built-in tool added later moves the
        // number, and a count taken from the file itself keeps this edit total without pinning one.
        const sets = (source.match(/authored\(\{/g) ?? []).length;
        let patched = 0;
        const result = source.replace(
          /(authored\(\{[^}]*?\n(\s*)openWorldHint: (?:true|false),\n)/g,
          (_match, head: string, indent: string) => {
            patched += 1;
            return `${head}${indent}${FIFTH_HINT}: false,\n`;
          }
        );
        // The `[^}]` class is why the throw above it exists: it stops the match at the first
        // closing brace, so an authored set that ever contains a nested object stops matching and
        // this counts short. That is the intended direction — read it as an edit to teach, and do
        // NOT loosen the class to make it pass, which would trade a named failure for a silent one.
        if (sets === 0 || patched !== sets) {
          throw new Error(
            `probe edit "authored built-in annotation sets" reached ${patched} of ${sets} — the ` +
              'shape it is keyed on has moved, so the probe would fail for the wrong reason'
          );
        }
        return result;
      });
    }

    if (variant === 'decided-with-a-move' || variant === 'decided-as-no-move') {
      // The answer this node's seam demands, in whichever of its two forms the cell is about.
      const answer =
        variant === 'decided-with-a-move' ? '{ from: false, to: true }' : 'NO_WEAKENING_MOVE';
      editProbeFile(dir, 'core/approvals/grants.ts', (source) =>
        substituteOnce(
          source,
          '  idempotentHint: NO_WEAKENING_MOVE,\n};',
          `  idempotentHint: NO_WEAKENING_MOVE,\n  ${FIFTH_HINT}: ${answer},\n};`,
          'answer the new hint in the weakening table'
        )
      );
    }

    const run = spawnSync(
      process.execPath,
      [TSC_ENTRY, '--noEmit', '-p', path.join(dir, 'tsconfig.json')],
      { cwd: CORE_DIR, encoding: 'utf8', timeout: 120_000 }
    );
    return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
  } finally {
    // A surviving probe directory means this run was killed; nothing else writes one.
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The diagnostics naming `core/approvals/grants.ts`, on either platform's separator. */
function grantsDiagnostics(output: string): string[] {
  return output.split('\n').filter((line) => /core[\\/]approvals[\\/]grants\.ts/.test(line));
}

const PROBE_TIMEOUT_MS = 120_000;

describe('EXT-182 — the weakening table cannot drift from the hint vocabulary', () => {
  /**
   * The layering, stated first so the cell below cannot be read as proving something it does not.
   * This much was true before the table changed: [[EXT-75]]'s reader indexes the fail-closed
   * defaults by the hint, so a widened vocabulary already stops compiling. What it asks for is what
   * a hint MEANS, and it asks it in `annotations.ts` — not in the table that decides invalidation.
   */
  it(
    'a fifth hint added to the vocabulary alone does not compile',
    () => {
      const { status, output } = typeCheckWithFifthHint('vocabulary-only');
      expect(status).not.toBe(0);
      expect(output).toContain(FIFTH_HINT);
      // The fail-closed-defaults seam, which is EXT-75's and fires wherever a hint is used to index
      // an annotation set.
      expect(output).toMatch(/annotations\.ts.*error TS7053/);
    },
    PROBE_TIMEOUT_MS
  );

  /**
   * **The cell this node exists for.** Every other seam is satisfied — the two annotation shapes,
   * the fail-closed constant, every authored built-in set — which is precisely the edit a
   * maintainer makes when the compiler walks them through adopting a new hint. Before this change
   * that variant compiled clean, and the new hint could never invalidate a grant with nobody
   * having said so; now the table is what is left red, naming the hint and the type that requires
   * it.
   *
   * Asserted on `WeakeningMove` rather than on an error code: which code the compiler picks for a
   * missing property depends on how many are missing, and the node's claim is about *this table*
   * being the thing that refuses — which is what the type in the message says.
   */
  it(
    'still does not compile once every OTHER seam is satisfied — the weakening table is what refuses',
    () => {
      const { status, output } = typeCheckWithFifthHint('other-seams-satisfied');
      expect(status).not.toBe(0);
      const refusals = grantsDiagnostics(output);
      expect(refusals.join('\n')).toContain(FIFTH_HINT);
      expect(refusals.join('\n')).toContain('WeakeningMove');
    },
    PROBE_TIMEOUT_MS
  );

  /**
   * CONTROL, and the self-test for every edit above: answering the question compiles. A probe whose
   * patch set had missed a site would red here too, so the cell above could not pass for a reason
   * that had nothing to do with the weakening table.
   */
  it(
    'compiles once the new hint is answered with a weakening move',
    () => {
      const { status, output } = typeCheckWithFifthHint('decided-with-a-move');
      expect(output.trim()).toBe('');
      expect(status).toBe(0);
    },
    PROBE_TIMEOUT_MS
  );

  /**
   * The other control, and an acceptance in its own right: **"no move along this hint weakens" is a
   * first-class answer**, not a hole. `idempotentHint` holds it today for a stated reason, and a
   * future hint whose movement genuinely cannot make a tool more dangerous must be able to say so
   * without inventing a move that would withdraw grants nobody meant to withdraw.
   */
  it(
    'compiles just as well when the new hint is answered NO_WEAKENING_MOVE',
    () => {
      const { status, output } = typeCheckWithFifthHint('decided-as-no-move');
      expect(output.trim()).toBe('');
      expect(status).toBe(0);
    },
    PROBE_TIMEOUT_MS
  );
});
