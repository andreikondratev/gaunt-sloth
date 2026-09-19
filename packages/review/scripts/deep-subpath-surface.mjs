/**
 * The review package's GATED DEEP SUBPATHS, bound to core's
 * `scripts/surface/deep-subpath-surface.mjs`.
 *
 * `value-surface.mjs` is the twin of this file and pins the ROOT BARREL, `@gaunt-sloth/review`.
 * This one pins the paths reachable as `@gaunt-sloth/review/<something>.js`. Read
 * `spec/reviewDeepSubpathValueSurface.spec.ts` for the design — which paths are gated, which are
 * left to the compiler, and on what evidence. The engine is the mechanism; this file is the
 * evidence, expressed as a descriptor.
 *
 * **Why only a few paths, when `exports` publishes 20 of them.** `exports` here is
 * `{".": "./dist/index.js", "./*.js": "./dist/*.js"}` — a wildcard, so the published subpath set
 * is not a list anyone wrote down but whatever the build emits. Measured: **15 of the 20 are named
 * by a literal import specifier in some package's production `src/`**, so `tsc` resolves that edge
 * and re-proves the names taken across it on every build, on every cell of the matrix. Pinning
 * those would duplicate a gate that already runs earlier and says more.
 *
 * What this gate covers instead is the **seven content and requirement source modules**, which are
 * reached the way nothing else in this package is — see {@link SOURCE_TABLES_SUBPATH}.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createDeepSubpathSurface } from '../../core/scripts/surface/deep-subpath-surface.mjs';
import { listDeclaredExports, REVIEW_DIR } from './value-surface.mjs';

export { PRODUCTION_SRC_GLOBS } from '../../core/scripts/surface/deep-subpath-surface.mjs';
export { REVIEW_DIR };

/** The name an embedder writes. Resolved by SELF-REFERENCE through the package `exports` map. */
const NAME = '@gaunt-sloth/review';

/** The probe reads the built package, so a regeneration is only as fresh as `dist/`. */
const BUILD = 'pnpm --filter @gaunt-sloth/review run build';

/**
 * The one command that rewrites the golden — the SAME command that rewrites the root barrel's,
 * because one generator writes both. A surface change that moves one of them usually moves the
 * other, and two commands is one command to forget.
 */
const REGENERATE = `${BUILD} && pnpm --filter @gaunt-sloth/review run value-surface:generate`;

/**
 * The module holding the two source tables this gate derives its list from.
 *
 * It is not gated here and does not need to be: `@gaunt-sloth/review/commands/commandUtils.js` is
 * named by a literal specifier in the app package's production source, and the barrel golden pins
 * `REQUIREMENTS_SOURCES` and `CONTENT_SOURCES` themselves. What a golden cannot say is that the
 * tables still have entries — empty ones would derive an empty gate that compares clean forever —
 * so {@link readSourceModules} refuses that outright rather than leaving it to a pin.
 */
export const SOURCE_TABLES_SUBPATH = 'commands/commandUtils.js';

/** The two tables read from {@link SOURCE_TABLES_SUBPATH}, unioned into the gated set. */
export const SOURCE_TABLE_NAMES = ['REQUIREMENTS_SOURCES', 'CONTENT_SOURCES'];

/** Where the source modules live under `dist/`, and the prefix both call sites rebuild. */
const SOURCES_DIR = 'sources';

/**
 * What the COMPUTED specifier calls on every source module it loads. The independent oracle, and
 * it comes from the call site rather than from the artifact.
 *
 * There are two such call sites and they are the same shape. `packages/review/src/commands/
 * commandUtils.ts` looks the file name up in `REQUIREMENTS_SOURCES` or `CONTENT_SOURCES`, builds
 * the specifier by template into `#src/sources/`, destructures `get` from the result and calls
 * `get(config, id)`. `packages/app/src/commands/commandUtils.ts` keeps its own copy of the same
 * two tables holding the PUBLISHED spellings, and does the same lookup-import-destructure-call.
 * Neither specifier is ever written down as a literal at the import site, so no type checker
 * follows either edge.
 *
 * **Unlike the agent package's equivalent, neither call site swallows the failure.** There is no
 * `try`/`catch` around the import or the call, so a source module that stops resolving, or stops
 * exporting `get`, throws at the user rather than disappearing quietly. That makes the gap louder
 * at runtime than agent's and no smaller before it: nothing in this repository goes red for it.
 */
export const SOURCE_CONTRACT = ['get'];

/**
 * The degeneracy floor for a source module, and zero on purpose.
 *
 * Every module this gate pins exports exactly one name, `get`. A floor of one would therefore
 * swallow the single failure the gate exists for — a source module that stopped exporting `get`
 * leaves zero runtime exports — and would report it by throwing "this is a broken probe, not a
 * small module" out of the derivation itself, before any cell could name the loss. Every other
 * cell in the spec would fail with that same sentence, which is the one sentence that is false
 * about it.
 *
 * So the floor is stood down here and the work is split elsewhere, to the two guards that can
 * carry it on this surface: the engine's own check that a gated subpath resolves INSIDE `dist/`,
 * and {@link SOURCE_CONTRACT}, which says a real module is missing a real name and says so by
 * name.
 */
export const MIN_SOURCE_EXPORTS = 0;

/**
 * A types-only module the wildcard publishes, excluded from this gate on a premise the spec
 * checks rather than asserts in prose.
 *
 * `src/modules/types.ts` declares interfaces and type aliases only, so `tsc` emits
 * `dist/modules/types.js` as `export {}` — no runtime surface for a consumer to take, and nothing
 * for a change to break silently. An exclusion whose premise nothing checks is exactly the
 * silently-expiring exclusion this whole gate exists to eliminate, so
 * `spec/reviewDeepSubpathValueSurface.spec.ts` reads the emitted declarations and fails the day
 * one of them appears in a VALUE position.
 *
 * `dist/sources/types.js` has the identical shape and is NOT excluded here, which is not an
 * inconsistency: the app package writes `import type { ProviderConfig } from
 * '@gaunt-sloth/review/sources/types.js'`, the scan matches that specifier like any other, and the
 * module is accounted for as compiler-watched rather than by an exclusion.
 */
export const TYPES_ONLY_SUBPATH = 'modules/types.js';

/** The emitted declarations for {@link TYPES_ONLY_SUBPATH} — read instead of trusting the prose. */
export const TYPES_ONLY_DECLARATIONS = path.join(REVIEW_DIR, 'dist', 'modules', 'types.d.ts');

/** How a gated subpath earned its place, written into the golden beside each entry. */
export const GATE_REASONS = {
  'computed-specifier': `reached only by a COMPUTED import specifier, which no type checker can follow. Both call sites look the module up in a table — packages/review/src/commands/commandUtils.ts in REQUIREMENTS_SOURCES / CONTENT_SOURCES, packages/app/src/commands/commandUtils.ts in its own copy of the same two tables holding the published spellings — then destructure get from whatever the import returns and call get(config, id). Neither wraps that in a try/catch, so a module that stops resolving or stops exporting get throws at the user; nothing in this repository goes red for it first.`,
  unwatched: `published by the "./*.js" wildcard and named by no literal import specifier in any package's production src/, so no build in this repository re-proves anything about it. Whatever reaches it reaches it at runtime.`,
};

/**
 * Published modules something other than this gate accounts for, so the completeness check reports
 * them as covered rather than as an escape. Each entry is a claim with a cell behind it.
 */
export const GATED_ELSEWHERE = [
  {
    module: 'index.js',
    why: 'the root barrel — pinned by spec/reviewBarrelValueSurface.golden.json, which is the twin of this file',
  },
  {
    module: TYPES_ONLY_SUBPATH,
    why: 'a types-only module: tsc emits it as "export {}", so it has no runtime surface for a consumer to take or for a change to break silently. The no-values premise is checked against the emitted modules/types.d.ts by spec/reviewDeepSubpathValueSurface.spec.ts rather than taken on trust',
  },
];

/**
 * The rule that decides everything this gate does NOT pin, written into the golden so the one file
 * a reviewer opens says both what is watched and why the rest needs no watching.
 *
 * It is a rule rather than a list because a list of 15 modules would be a second inventory to
 * maintain, and because the reason is the same sentence for all of them.
 */
export const EXCLUSION_RULE = `Everything else the "./*.js" wildcard publishes is named by a LITERAL import specifier in some package's production src/ — #src/…, a relative path, or @gaunt-sloth/review/… from a sibling — so tsc resolves that edge and re-proves the names it takes on every build, on every cell of the matrix. That is an earlier and louder gate than a golden, and duplicating it here would buy churn rather than coverage. Measured by listLiterallyImportedModules() in core's scripts/surface/deep-subpath-surface.mjs, and the spec asserts that nothing falls outside both that scan and this golden.`;

const review = createDeepSubpathSurface({
  packageName: NAME,
  packageDir: REVIEW_DIR,
  goldenPath: path.join(REVIEW_DIR, 'spec', 'reviewDeepSubpathValueSurface.golden.json'),
  buildCommand: BUILD,
  regenerateCommand: REGENERATE,
  goldenComment: `GENERATED — do not hand-edit. The public runtime (value) surface of the review package's GATED DEEP SUBPATHS, resolved through the package exports map by scripts/deep-subpath-surface.mjs and compared against this file by spec/reviewDeepSubpathValueSurface.spec.ts. The root barrel has its own golden, reviewBarrelValueSurface.golden.json. Regenerate both with: ${REGENERATE}`,
  gateReasons: GATE_REASONS,
  gatedElsewhere: GATED_ELSEWHERE,
  exclusionRule: EXCLUSION_RULE,
  deriveSeedSubpaths: async () =>
    (await readSourceModules()).map((subpath) => ({
      subpath,
      reason: 'computed-specifier',
      minExports: MIN_SOURCE_EXPORTS,
    })),
  reasonForUnwatched: () => 'unwatched',
  minExportsForUnwatched: MIN_SOURCE_EXPORTS,
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
} = review;

/**
 * Which source modules the package will load at runtime, read from the BUILT
 * {@link SOURCE_TABLES_SUBPATH} through the `exports` map — the same tables, reached the same way,
 * that both `getFromSource` implementations look a file name up in before they build their
 * computed specifier.
 *
 * The tables' values are bare file names; the published subpath is that name under `sources/`.
 * Derived rather than written down, so a source added to either table joins this gate the day it
 * appears.
 *
 * **All seven are gated, not only the ones the scan calls unwatched.** Four of them are named by a
 * literal specifier today only because `packages/app/src/commands/prDiscovery.ts` happens to
 * import them statically for its own purposes. That import is nobody's coverage for the table
 * lookup, and an unrelated refactor of `prDiscovery.ts` would move four modules out of the gate
 * silently. The evidence for gating is how the modules are REACHED, which is the same for all
 * seven.
 *
 * @returns {Promise<string[]>} Published subpaths, sorted, each appearing once.
 */
export async function readSourceModules() {
  const resolved = review.resolveSubpath(SOURCE_TABLES_SUBPATH);
  const namespace = await import(pathToFileURL(resolved).href);
  const subpaths = new Set();
  for (const tableName of SOURCE_TABLE_NAMES) {
    const table = namespace[tableName];
    if (!table || typeof table !== 'object' || Object.keys(table).length === 0) {
      throw new Error(
        `${NAME}/${SOURCE_TABLES_SUBPATH} no longer exports a non-empty ${tableName} object — the source list this gate derives from has collapsed, and a collapsed list gates nothing`
      );
    }
    for (const [alias, fileName] of Object.entries(table)) {
      if (typeof fileName !== 'string' || !fileName.endsWith('.js') || fileName.includes('/')) {
        throw new Error(
          `${NAME}/${SOURCE_TABLES_SUBPATH} maps ${tableName}.${alias} to ${JSON.stringify(fileName)}, which is not a bare "<name>.js" file name — this gate derives the published subpath by placing that name under ${SOURCES_DIR}/, and cannot do so for this entry`
        );
      }
      subpaths.add(`${SOURCES_DIR}/${fileName}`);
    }
  }
  return [...subpaths].sort();
}

/**
 * What the emitted declarations say {@link TYPES_ONLY_SUBPATH} publishes in a VALUE position.
 *
 * Read from the declarations rather than from the emitted JavaScript because that is where the
 * change would appear first: a `const` added to `src/modules/types.ts` is a value export in both
 * files, and the declarations are the half a reader of the source would check.
 *
 * @returns {string[]} Value-position export names; empty is the expected answer.
 */
export function listTypesOnlyDeclaredValues() {
  return listDeclaredExports(TYPES_ONLY_DECLARATIONS)
    .filter((entry) => entry.isValue)
    .map((entry) => entry.name);
}
