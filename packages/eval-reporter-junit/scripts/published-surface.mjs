/**
 * Account for every module the JUnit reporter package's `"./*.js"` wildcard publishes, bound to
 * core's `scripts/surface/deep-subpath-surface.mjs`.
 *
 * **This package has no deep-subpath golden, and that is a measured decision rather than an
 * omission.** `exports` here is `{".": "./dist/index.js", "./*.js": "./dist/*.js"}`, the same
 * wildcard core, agent, batch and review publish, and it emits two modules:
 *
 * - **`index.js`** is the root barrel, pinned by `spec/junitBarrelValueSurface.golden.json`.
 * - **`junitReporter.js`** is named by a literal import specifier in production source —
 *   `src/index.ts` re-exports it as `#src/junitReporter.js` — so `tsc` resolves that edge and
 *   re-proves the name taken across it on every build, on every cell of the matrix.
 *
 * That leaves nothing for a deep-subpath gate to pin, and core's engine refuses an empty gated set
 * outright ("a gate over an empty list compares clean against its own golden forever"), which is
 * the correct answer rather than an obstacle to work around. What this package needs instead is
 * the COMPLETENESS property — that no published module escapes both the compiler and the barrel
 * golden — and `spec/junitPublishedSurface.spec.ts` asserts exactly that. The day a module appears
 * here that nothing watches, that cell reds and names it, and the remedy is to give this package
 * the deep-subpath golden the engine already knows how to build.
 *
 * **This package is the bundled reporter, and that is why its barrel is compiler-watched where its
 * sibling's is not.** `packages/app/src/commands/evalCommand.ts` registers it through the public
 * `custom` reporter seam with a literal `await import('@gaunt-sloth/eval-reporter-junit/index.js')`,
 * so the compiler follows that edge. `@gaunt-sloth/eval-reporter-teamcity` is reached only through
 * a user's `reporters` config, by a specifier built at runtime, and its barrel is genuinely
 * unwatched as a result.
 */
import { createPublishedModuleScan } from '../../core/scripts/surface/deep-subpath-surface.mjs';
import { JUNIT_DIR, REGENERATE_COMMAND } from './value-surface.mjs';

export { PRODUCTION_SRC_GLOBS } from '../../core/scripts/surface/deep-subpath-surface.mjs';
export { JUNIT_DIR };

/** The implementation module, named by the barrel and therefore re-proved by every build. */
export const REPORTER_SUBPATH = 'junitReporter.js';

/**
 * Published modules something other than this scan accounts for, so the completeness check reports
 * them as covered rather than as an escape. Each entry is a claim with a cell behind it.
 */
export const GATED_ELSEWHERE = [
  {
    module: 'index.js',
    why: 'the root barrel — pinned by spec/junitBarrelValueSurface.golden.json. It is additionally named by a literal specifier in packages/app/src/commands/evalCommand.ts, which registers this bundled reporter through the public custom seam, so the compiler follows that edge too',
  },
];

/**
 * The rule that decides everything the scan does not report, kept here beside the exclusion so one
 * file says both halves.
 */
export const EXCLUSION_RULE = `Everything else the "./*.js" wildcard publishes is named by a LITERAL import specifier in some package's production src/ — #src/…, a relative path, or @gaunt-sloth/eval-reporter-junit/… from a sibling — so tsc resolves that edge and re-proves the names it takes on every build, on every cell of the matrix. That is an earlier and louder gate than a golden, and duplicating it here would buy churn rather than coverage. Measured by listLiterallyImportedModules() in core's scripts/surface/deep-subpath-surface.mjs.`;

/** The remedy named on a completeness red, so a correct failure arrives with something to do. */
export const REMEDY = `Give @gaunt-sloth/eval-reporter-junit the deep-subpath golden core, agent and review already have — bind core's createDeepSubpathSurface() in a scripts/deep-subpath-surface.mjs here, add a spec beside this one, and regenerate with: ${REGENERATE_COMMAND}. If instead the module is dead, delete it; if something else already watches it, add it to GATED_ELSEWHERE in scripts/published-surface.mjs with the cell that does so.`;

const scan = createPublishedModuleScan({
  packageName: '@gaunt-sloth/eval-reporter-junit',
  packageDir: JUNIT_DIR,
  gatedElsewhere: GATED_ELSEWHERE,
});

export const {
  PACKAGE_NAME,
  DIST_DIR,
  listPublishedModules,
  listLiterallyImportedModules,
  listUnwatchedModules,
} = scan;
