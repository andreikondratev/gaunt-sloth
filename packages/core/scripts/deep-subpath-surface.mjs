/**
 * The core package's GATED DEEP SUBPATHS, bound to `surface/deep-subpath-surface.mjs`.
 *
 * That engine is the single implementation shared by every package that pins deep subpaths.
 * `value-surface.mjs` is the twin of this file and pins the ROOT BARREL, `@gaunt-sloth/core`.
 * This one pins a chosen few of the paths reachable as `@gaunt-sloth/core/<something>.js`. Read
 * `spec/coreDeepSubpathValueSurface.spec.ts` for the design — which paths are gated, which are
 * left to the compiler, and on what evidence. The engine is the mechanism; this file is the
 * evidence, expressed as a descriptor.
 *
 * **Why only a few paths, when `exports` publishes 128 of them.** `exports` here is
 * `{".": "./dist/index.js", "./*.js": "./dist/*.js"}` — a wildcard, so the published subpath set
 * is not a list anyone wrote down but whatever the build emits. Gating all of it would pin every
 * internal module of the package, and would be largely redundant: 116 of the 128 are named by a
 * literal import specifier in some package's production `src/`, so `tsc` resolves that edge and
 * re-proves the names taken across it on every build. The remaining twelve are what this file and
 * the barrel golden between them cover, and they are the three shapes a type checker cannot see:
 *
 * - a path reached by a COMPUTED specifier,
 * - a path imported only from outside this repository, and
 * - a path nothing in this repository imports at all.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createDeepSubpathSurface } from './surface/deep-subpath-surface.mjs';
import { CORE_DIR } from './value-surface.mjs';

export { PRODUCTION_SRC_GLOBS } from './surface/deep-subpath-surface.mjs';
export { CORE_DIR };

/** The name an embedder writes. Resolved by SELF-REFERENCE through the package `exports` map. */
const NAME = '@gaunt-sloth/core';

/** The probe reads the built package, so a regeneration is only as fresh as `dist/`. */
const BUILD = 'pnpm --filter @gaunt-sloth/core run build';

/**
 * The one command that rewrites the golden — the SAME command that rewrites the root barrel's,
 * because one generator writes both. A surface change that moves one of them usually moves the
 * other, and two commands is one command to forget.
 */
const REGENERATE = `${BUILD} && pnpm --filter @gaunt-sloth/core run value-surface:generate`;

/**
 * The deep subpath the CONSUMER REPOSITORIES import. Measured, not assumed: reading
 * `pukeko-robot-controller` and `galvanized-pukeko`, this is the only `@gaunt-sloth/core/…` path
 * either of them names — `server/index.ts` takes `DEFAULT_CONFIG` and the `GthConfig` type from it.
 */
export const CONSUMER_SUBPATH = 'config.js';

/**
 * A floor for {@link CONSUMER_SUBPATH}, not a pin on the size of its API. It exists for one
 * failure: a probe that resolved to something other than the built module and came back with
 * almost nothing, which would make every name assertion pass by checking nothing.
 */
export const MIN_CONSUMER_SUBPATH_EXPORTS = 60;

/**
 * What the two COMPUTED specifiers in this repository call on the module they load. This is the
 * independent oracle, and it does not come from the artifact under test — it comes from the call
 * sites:
 *
 * - `packages/app/src/commands/configSetup.ts` does
 *   ``await import(`@gaunt-sloth/core/providers/${configType}.js`)`` and then calls `.init(...)`.
 *   That one crosses a package boundary, so on an installed tree it resolves through the published
 *   `exports` map.
 * - `packages/core/src/config/loader.ts` does ``await import(`#src/providers/${llmType}.js`)`` and
 *   then calls `.processJsonConfig(...)`.
 *
 * Neither specifier is a literal, so no type checker sees either edge.
 */
export const PROVIDER_CONTRACT = ['init', 'processJsonConfig'];

/**
 * The degeneracy floor for a provider module, and deliberately NOT `PROVIDER_CONTRACT.length`.
 *
 * Measured: with the floor at 2, deleting `export` from `init` in `providers/openai.ts` left one
 * export, tripped this guard, and the reader was told "this is a broken probe, not a small module"
 * — the one sentence that is false, about the one failure the gate exists for. A floor set to the
 * size of the contract swallows every single-name loss and reports it as an instrument fault.
 *
 * The floor's job is narrower than the contract's: it catches a probe that resolved to something
 * that is not a module at all. `PROVIDER_CONTRACT` is what says a real module is missing a real
 * name, and it says so by name.
 */
export const MIN_PROVIDER_EXPORTS = 1;

/** How a gated subpath earned its place, written into the golden beside each entry. */
export const GATE_REASONS = {
  'consumer-repo': `imported by a consumer repository through this exact subpath — the only @gaunt-sloth/core/… path either pukeko-robot-controller or galvanized-pukeko names. Nothing in this repository imports it on their behalf, so no build here re-proves it.`,
  'computed-specifier': `reached only by a COMPUTED import specifier, which no type checker can follow: packages/app/src/commands/configSetup.ts resolves @gaunt-sloth/core/providers/<id>.js from a variable and calls init() on it, and packages/core/src/config/loader.ts does the same for processJsonConfig(). The one spec that exercises the first call site mocks the module away, so before this golden nothing checked that these modules exist, resolve, or still export what is called on them.`,
  unwatched: `published by the "./*.js" wildcard and named by no literal import specifier in any package's production src/, so no build in this repository re-proves anything about it. Whatever reaches it reaches it at runtime.`,
};

/**
 * The module the ROOT BARREL golden already pins, named here so the completeness check can account
 * for it rather than report it as an escape.
 */
export const GATED_ELSEWHERE = [
  {
    module: 'index.js',
    why: 'the root barrel — pinned by spec/coreBarrelValueSurface.golden.json, which is the twin of this file',
  },
];

/**
 * The rule that decides everything this gate does NOT pin, written into the golden so the one file
 * a reviewer opens says both what is watched and why the rest needs no watching.
 *
 * It is a rule rather than a list because a list of 116 modules would be a second inventory to
 * maintain, and because the reason is the same sentence for all of them.
 */
export const EXCLUSION_RULE = `Everything else the "./*.js" wildcard publishes is named by a LITERAL import specifier in some package's production src/ — #src/…, a relative path, or @gaunt-sloth/core/… from a sibling — so tsc resolves that edge and re-proves the names it takes on every build, on every cell of the matrix. That is an earlier and louder gate than a golden, and duplicating it here would buy churn rather than coverage. Measured by listLiterallyImportedModules() in scripts/deep-subpath-surface.mjs, and the spec asserts that nothing falls outside both that scan and this golden.`;

const core = createDeepSubpathSurface({
  packageName: NAME,
  packageDir: CORE_DIR,
  goldenPath: path.join(CORE_DIR, 'spec', 'coreDeepSubpathValueSurface.golden.json'),
  buildCommand: BUILD,
  regenerateCommand: REGENERATE,
  goldenComment: `GENERATED — do not hand-edit. The public runtime (value) surface of the core package's GATED DEEP SUBPATHS, resolved through the package exports map by scripts/deep-subpath-surface.mjs and compared against this file by spec/coreDeepSubpathValueSurface.spec.ts. The root barrel has its own golden, coreBarrelValueSurface.golden.json. Regenerate both with: ${REGENERATE}`,
  gateReasons: GATE_REASONS,
  gatedElsewhere: GATED_ELSEWHERE,
  exclusionRule: EXCLUSION_RULE,
  deriveSeedSubpaths: async () => [
    {
      subpath: CONSUMER_SUBPATH,
      reason: 'consumer-repo',
      minExports: MIN_CONSUMER_SUBPATH_EXPORTS,
    },
    ...(await readAvailableDefaultConfigs()).map((id) => ({
      subpath: `providers/${id}.js`,
      reason: 'computed-specifier',
      minExports: MIN_PROVIDER_EXPORTS,
    })),
  ],
  reasonForUnwatched: (module) =>
    module.startsWith('providers/') ? 'computed-specifier' : 'unwatched',
  minExportsForUnwatched: MIN_PROVIDER_EXPORTS,
});

export const {
  PACKAGE_NAME,
  DIST_DIR,
  GOLDEN_PATH,
  BUILD_COMMAND,
  REGENERATE_COMMAND,
  GOLDEN_COMMENT,
  listPublishedModules,
  listLiterallyImportedModules,
  listUnwatchedModules,
  resolveSubpath,
  deriveGatedSubpaths,
  assertNonDegenerate,
  deriveDeepSubpathSurface,
  toGoldenDocument,
  readGoldenDocument,
  describeDeepSurfaceDrift,
} = core;

/**
 * Which provider modules the package claims to support, read from the BUILT `config.js` through
 * the `exports` map — the same list, reached the same way, that
 * `packages/app/src/commands/configSetup.ts` validates `gth init <provider>` against before it
 * builds its computed specifier.
 *
 * @returns {Promise<string[]>} Provider ids, in the order the package declares them.
 */
export async function readAvailableDefaultConfigs() {
  const resolved = core.resolveSubpath(CONSUMER_SUBPATH);
  const namespace = await import(pathToFileURL(resolved).href);
  const ids = namespace.availableDefaultConfigs;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error(
      `${NAME}/${CONSUMER_SUBPATH} no longer exports a non-empty availableDefaultConfigs array — the provider list this gate derives from has collapsed, and a collapsed list gates nothing`
    );
  }
  return [...ids];
}
