/**
 * Account for every module the TeamCity reporter package's `"./*.js"` wildcard publishes, bound to
 * core's `scripts/surface/deep-subpath-surface.mjs`.
 *
 * **This package has no deep-subpath golden, and that is a measured decision rather than an
 * omission.** `exports` here is `{".": "./dist/index.js", "./*.js": "./dist/*.js"}`, the same
 * wildcard core, agent, batch and review publish, and it emits two modules:
 *
 * - **`index.js`** is the root barrel, pinned by `spec/teamcityBarrelValueSurface.golden.json` —
 *   and the barrel is the whole of this package's exposure, because it is what a user's config
 *   names.
 * - **`teamcityReporter.js`** is named by a literal import specifier in production source —
 *   `src/index.ts` re-exports it as `#src/teamcityReporter.js` — so `tsc` resolves that edge and
 *   re-proves the names taken across it on every build, on every cell of the matrix.
 *
 * That leaves nothing for a deep-subpath gate to pin, and core's engine refuses an empty gated set
 * outright ("a gate over an empty list compares clean against its own golden forever"), which is
 * the correct answer rather than an obstacle to work around. What this package needs instead is
 * the COMPLETENESS property — that no published module escapes both the compiler and the barrel
 * golden — and `spec/teamcityPublishedSurface.spec.ts` asserts exactly that.
 *
 * **The barrel is genuinely unwatched here, and that is the difference from the JUnit reporter.**
 * That package is bundled: `packages/app/src/commands/evalCommand.ts` names
 * `@gaunt-sloth/eval-reporter-junit/index.js` in a literal specifier, so the compiler follows the
 * edge. This one is optional and separately installed, registered through the `reporters` config
 * seam by bare package name and resolved against the USER's project at run time. No literal
 * specifier in any package's production source names it, and the scan says so.
 */
import { createPublishedModuleScan } from '../../core/scripts/surface/deep-subpath-surface.mjs';
import { REGENERATE_COMMAND, TEAMCITY_DIR } from './value-surface.mjs';

export { PRODUCTION_SRC_GLOBS } from '../../core/scripts/surface/deep-subpath-surface.mjs';
export { TEAMCITY_DIR };

/** The barrel: the path the `reporters` config seam resolves, and the only one it resolves. */
export const BARREL_SUBPATH = 'index.js';

/** The implementation module, named by the barrel and therefore re-proved by every build. */
export const REPORTER_SUBPATH = 'teamcityReporter.js';

/**
 * Published modules something other than this scan accounts for, so the completeness check reports
 * them as covered rather than as an escape. Each entry is a claim with a cell behind it.
 */
export const GATED_ELSEWHERE = [
  {
    module: BARREL_SUBPATH,
    why: "the root barrel — pinned by spec/teamcityBarrelValueSurface.golden.json. It is the path a user's `reporters` config names, reached by a specifier built at run time from that config, and no literal import specifier in any package's production src/ names it: that golden is the only thing in this repository watching it",
  },
];

/**
 * The rule that decides everything the scan does not report, kept here beside the exclusion so one
 * file says both halves.
 */
export const EXCLUSION_RULE = `Everything else the "./*.js" wildcard publishes is named by a LITERAL import specifier in some package's production src/ — #src/…, a relative path, or @gaunt-sloth/eval-reporter-teamcity/… from a sibling — so tsc resolves that edge and re-proves the names it takes on every build, on every cell of the matrix. That is an earlier and louder gate than a golden, and duplicating it here would buy churn rather than coverage. Measured by listLiterallyImportedModules() in core's scripts/surface/deep-subpath-surface.mjs.`;

/** The remedy named on a completeness red, so a correct failure arrives with something to do. */
export const REMEDY = `Give @gaunt-sloth/eval-reporter-teamcity the deep-subpath golden core, agent and review already have — bind core's createDeepSubpathSurface() in a scripts/deep-subpath-surface.mjs here, add a spec beside this one, and regenerate with: ${REGENERATE_COMMAND}. If instead the module is dead, delete it; if something else already watches it, add it to GATED_ELSEWHERE in scripts/published-surface.mjs with the cell that does so.`;

const scan = createPublishedModuleScan({
  packageName: '@gaunt-sloth/eval-reporter-teamcity',
  packageDir: TEAMCITY_DIR,
  gatedElsewhere: GATED_ELSEWHERE,
});

export const {
  PACKAGE_NAME,
  DIST_DIR,
  listPublishedModules,
  listLiterallyImportedModules,
  listUnwatchedModules,
} = scan;
