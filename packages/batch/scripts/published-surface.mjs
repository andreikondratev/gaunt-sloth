/**
 * Account for every module the batch package's `"./*.js"` wildcard publishes, bound to core's
 * `scripts/surface/deep-subpath-surface.mjs`.
 *
 * **This package has no deep-subpath golden, and that is a measured decision rather than an
 * omission.** `exports` here is `{".": "./dist/index.js", "./*.js": "./dist/*.js"}`, the same
 * wildcard core and agent publish, and it emits 33 modules. Sorted by what already watches them:
 *
 * - **31 are named by a literal import specifier in some package's production `src/`**, so `tsc`
 *   resolves that edge and re-proves the names taken across it on every build, on every cell of
 *   the matrix.
 * - **`index.js`** is the root barrel, pinned by `spec/batchBarrelValueSurface.golden.json`.
 * - **`bin.js`** is the `gth-batch` executable — see {@link BIN_SUBPATH}.
 *
 * That leaves nothing for a deep-subpath gate to pin, and core's engine refuses an empty gated set
 * outright ("a gate over an empty list compares clean against its own golden forever"), which is
 * the correct answer rather than an obstacle to work around. What this package needs instead is
 * the COMPLETENESS property — that no published module escapes both the compiler and the barrel
 * golden — and `spec/batchPublishedSurface.spec.ts` asserts exactly that. The day a module appears
 * here that nothing watches, that cell reds and names it, and the remedy is to give this package
 * the deep-subpath golden the engine already knows how to build.
 *
 * The batch package is also the one where the node behind this file predicted the opposite result
 * — it is the eval runtime, so much of its surface was expected to be reachable only from eval
 * configs and fixtures, which are not production `src/` and re-prove nothing. Measured, that is
 * not what it is: 31 of 33 are ordinary internal modules that production source imports by name.
 */
import path from 'node:path';

import { listDeclaredExports } from '../../core/scripts/surface/barrel-value-surface.mjs';
import { createPublishedModuleScan } from '../../core/scripts/surface/deep-subpath-surface.mjs';
import { BATCH_DIR, REGENERATE_COMMAND } from './value-surface.mjs';

export { PRODUCTION_SRC_GLOBS } from '../../core/scripts/surface/deep-subpath-surface.mjs';
export { BATCH_DIR };

/**
 * The `gth-batch` executable, published by the wildcard like everything else in `dist/`.
 *
 * **It must never be imported by a probe.** It is a shebang CLI with top-level side effects: a
 * plain `import()` of it runs `runBatchCli`, prints the usage block and can exit the process,
 * taking the test run with it. Measured directly, not assumed.
 *
 * It is accounted for instead by the one property that makes it harmless — it exports nothing, so
 * it has no runtime surface for a consumer to depend on or for a change to break silently. That is
 * checked rather than asserted in prose, in `spec/batchPublishedSurface.spec.ts`, by reading the
 * emitted `bin.d.ts` with the TypeScript API. An exclusion whose premise nothing checks is exactly
 * the silently-expiring exclusion this whole gate exists to eliminate: the day `bin.ts` grows an
 * export, that cell reds and says to gate it or stop publishing it.
 */
export const BIN_SUBPATH = 'bin.js';

/** The emitted declarations for {@link BIN_SUBPATH} — read instead of importing the module. */
export const BIN_DECLARATIONS = path.join(BATCH_DIR, 'dist', 'bin.d.ts');

/**
 * Published modules something other than this scan accounts for, so the completeness check reports
 * them as covered rather than as an escape. Each entry is a claim with a cell behind it.
 */
export const GATED_ELSEWHERE = [
  {
    module: 'index.js',
    why: 'the root barrel — pinned by spec/batchBarrelValueSurface.golden.json',
  },
  {
    module: BIN_SUBPATH,
    why: 'the gth-batch executable: a shebang CLI with top-level side effects that must not be imported, and which exports nothing at all. The no-exports premise is checked against the emitted bin.d.ts by spec/batchPublishedSurface.spec.ts rather than taken on trust',
  },
];

/**
 * The rule that decides everything the scan does not report, kept here beside the exclusions so
 * one file says both halves.
 */
export const EXCLUSION_RULE = `Everything else the "./*.js" wildcard publishes is named by a LITERAL import specifier in some package's production src/ — #src/…, a relative path, or @gaunt-sloth/batch/… from a sibling — so tsc resolves that edge and re-proves the names it takes on every build, on every cell of the matrix. That is an earlier and louder gate than a golden, and duplicating it here would buy churn rather than coverage. Measured by listLiterallyImportedModules() in core's scripts/surface/deep-subpath-surface.mjs.`;

/** The remedy named on a completeness red, so a correct failure arrives with something to do. */
export const REMEDY = `Give @gaunt-sloth/batch the deep-subpath golden core and agent already have — bind core's createDeepSubpathSurface() in a scripts/deep-subpath-surface.mjs here, add a spec beside this one, and regenerate with: ${REGENERATE_COMMAND}. If instead the module is dead, delete it; if something else already watches it, add it to GATED_ELSEWHERE in scripts/published-surface.mjs with the cell that does so.`;

const scan = createPublishedModuleScan({
  packageName: '@gaunt-sloth/batch',
  packageDir: BATCH_DIR,
  gatedElsewhere: GATED_ELSEWHERE,
});

export const {
  PACKAGE_NAME,
  DIST_DIR,
  listPublishedModules,
  listLiterallyImportedModules,
  listUnwatchedModules,
} = scan;

/**
 * What the emitted declarations say {@link BIN_SUBPATH} publishes, read WITHOUT executing it.
 *
 * @returns {string[]} Exported names; empty is the expected answer.
 */
export function listBinDeclaredExports() {
  return listDeclaredExports(BIN_DECLARATIONS).map((entry) => entry.name);
}
