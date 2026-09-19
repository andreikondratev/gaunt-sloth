/**
 * The agent package's GATED DEEP SUBPATHS, bound to core's
 * `scripts/surface/deep-subpath-surface.mjs`.
 *
 * `value-surface.mjs` is the twin of this file and pins the ROOT BARREL, `@gaunt-sloth/agent`.
 * This one pins the paths reachable as `@gaunt-sloth/agent/<something>.js`. Read
 * `spec/agentDeepSubpathValueSurface.spec.ts` for the design — which paths are gated, which are
 * left to the compiler, and on what evidence. The engine is the mechanism; this file is the
 * evidence, expressed as a descriptor.
 *
 * **Why only a few paths, when `exports` publishes 46 of them.** `exports` here is
 * `{".": "./dist/index.js", "./*.js": "./dist/*.js"}` — a wildcard, so the published subpath set
 * is not a list anyone wrote down but whatever the build emits. Measured: **40 of the 46 are named
 * by a literal import specifier in some package's production `src/`**, so `tsc` resolves that edge
 * and re-proves the names taken across it on every build, on every cell of the matrix. Pinning
 * those would duplicate a gate that already runs earlier and says more.
 *
 * **Six are not**: the root barrel, which keeps its own golden, and the **five built-in tool
 * modules**, which are the whole of the gap here and are reached the way nothing else in this
 * package is — see {@link TOOL_CONTRACT}.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createDeepSubpathSurface } from '../../core/scripts/surface/deep-subpath-surface.mjs';
import { AGENT_DIR } from './value-surface.mjs';

export { PRODUCTION_SRC_GLOBS } from '../../core/scripts/surface/deep-subpath-surface.mjs';
export { AGENT_DIR };

/** The name an embedder writes. Resolved by SELF-REFERENCE through the package `exports` map. */
const NAME = '@gaunt-sloth/agent';

/** The probe reads the built package, so a regeneration is only as fresh as `dist/`. */
const BUILD = 'pnpm --filter @gaunt-sloth/agent run build';

/**
 * The one command that rewrites the golden — the SAME command that rewrites the root barrel's,
 * because one generator writes both. A surface change that moves one of them usually moves the
 * other, and two commands is one command to forget.
 */
const REGENERATE = `${BUILD} && pnpm --filter @gaunt-sloth/agent run value-surface:generate`;

/**
 * The module that holds the built-in tool registry, read below for the tool list.
 *
 * It is not gated here and does not need to be: `src/index.ts` re-exports it with
 * `export * from '#src/builtInToolsConfig.js'`, so `tsc` re-proves the path and the barrel golden
 * pins `AVAILABLE_BUILT_IN_TOOLS` itself. What a golden cannot say is that the table still has
 * entries — an empty one would derive an empty gate that compares clean forever — so
 * {@link readBuiltInToolModules} refuses that outright rather than leaving it to a pin.
 */
export const TOOL_REGISTRY_SUBPATH = 'builtInToolsConfig.js';

/**
 * The deep subpath a CONSUMER REPOSITORY imports. Measured, not assumed: reading
 * `pukeko-robot-controller` and `galvanized-pukeko`, this is the only `@gaunt-sloth/agent/…` path
 * either of them names — `src/agent/frontendImageInjectionMiddleware.ts` line 35 takes
 * `imageBlockFor` from it, deliberately sharing the per-provider block table rather than keeping a
 * second copy. (`galvanized-pukeko` consumes the `gaunt-sloth-api` BIN and no module surface.)
 */
export const CONSUMER_SUBPATH = 'middleware/frontendImageInjectionMiddleware.js';

/**
 * What the consumer repository actually takes off {@link CONSUMER_SUBPATH}. This is an oracle from
 * OUTSIDE the artifact under test — read off the robot's own import statement, not off this
 * package's build — which is what separates the cell that uses it from the golden's
 * change-detection. That repository builds against the PUBLISHED package at a pinned version, so a
 * literal import inside this repository is not on its behalf and re-proves nothing for it.
 */
export const CONSUMER_SUBPATH_CONTRACT = ['imageBlockFor'];

/**
 * What the COMPUTED specifier in this package calls on every tool module it loads. The independent
 * oracle, and it comes from the call site rather than from the artifact:
 * `packages/agent/src/builtInToolsConfig.ts` does
 * ``await import(AVAILABLE_BUILT_IN_TOOLS[toolName])`` — a TABLE LOOKUP, so not even a template
 * literal a reader might mistake for a specifier — and then calls `tool.get(config)`.
 *
 * **That call sits inside a `try/catch` whose catch only `displayWarning`s.** So a tool module
 * that stops resolving, or stops exporting `get`, does not crash: the tool silently disappears
 * from the agent's toolset and the user gets one warning line. That is strictly quieter than
 * core's provider equivalent, which at least throws, and it is why these five modules are the
 * gap this gate exists to close.
 */
export const TOOL_CONTRACT = ['get'];

/**
 * The degeneracy floor for a tool module, and deliberately NOT `TOOL_CONTRACT.length`.
 *
 * A floor set to the size of the contract swallows every single-name loss and reports it as an
 * instrument fault — "this is a broken probe, not a small module", the one sentence that is false
 * about the one failure the gate exists for. The floor's job is narrower than the contract's: it
 * catches a probe that resolved to something that is not a module at all. {@link TOOL_CONTRACT} is
 * what says a real module is missing a real name, and it says so by name.
 */
export const MIN_TOOL_EXPORTS = 1;

/** How a gated subpath earned its place, written into the golden beside each entry. */
export const GATE_REASONS = {
  'consumer-repo': `imported by a consumer repository through this exact subpath — the only @gaunt-sloth/agent/… path either pukeko-robot-controller or galvanized-pukeko names. That repository builds against the published package at a pinned version, so no literal import inside this repository is on its behalf and no build here re-proves it.`,
  'computed-specifier': `reached only by a COMPUTED import specifier, which no type checker can follow: packages/agent/src/builtInToolsConfig.ts looks the module path up in the AVAILABLE_BUILT_IN_TOOLS table and calls get(config) on whatever comes back. The await import() is wrapped in a try/catch that only displayWarning()s, so a module that stops resolving or stops exporting get does not crash — the tool silently vanishes from the agent's toolset and the user gets one warning line.`,
  unwatched: `published by the "./*.js" wildcard and named by no literal import specifier in any package's production src/, so no build in this repository re-proves anything about it. Whatever reaches it reaches it at runtime.`,
};

/**
 * The module the ROOT BARREL golden already pins, named here so the completeness check can account
 * for it rather than report it as an escape.
 */
export const GATED_ELSEWHERE = [
  {
    module: 'index.js',
    why: 'the root barrel — pinned by spec/agentBarrelValueSurface.golden.json, which is the twin of this file, and the path pukeko-robot-controller imports startAgUiServer from',
  },
];

/**
 * The rule that decides everything this gate does NOT pin, written into the golden so the one file
 * a reviewer opens says both what is watched and why the rest needs no watching.
 *
 * It is a rule rather than a list because a list of 40 modules would be a second inventory to
 * maintain, and because the reason is the same sentence for all of them.
 */
export const EXCLUSION_RULE = `Everything else the "./*.js" wildcard publishes is named by a LITERAL import specifier in some package's production src/ — #src/…, a relative path, or @gaunt-sloth/agent/… from a sibling — so tsc resolves that edge and re-proves the names it takes on every build, on every cell of the matrix. That is an earlier and louder gate than a golden, and duplicating it here would buy churn rather than coverage. Measured by listLiterallyImportedModules() in core's scripts/surface/deep-subpath-surface.mjs, and the spec asserts that nothing falls outside both that scan and this golden.`;

const agent = createDeepSubpathSurface({
  packageName: NAME,
  packageDir: AGENT_DIR,
  goldenPath: path.join(AGENT_DIR, 'spec', 'agentDeepSubpathValueSurface.golden.json'),
  buildCommand: BUILD,
  regenerateCommand: REGENERATE,
  goldenComment: `GENERATED — do not hand-edit. The public runtime (value) surface of the agent package's GATED DEEP SUBPATHS, resolved through the package exports map by scripts/deep-subpath-surface.mjs and compared against this file by spec/agentDeepSubpathValueSurface.spec.ts. The root barrel has its own golden, agentBarrelValueSurface.golden.json. Regenerate both with: ${REGENERATE}`,
  gateReasons: GATE_REASONS,
  gatedElsewhere: GATED_ELSEWHERE,
  exclusionRule: EXCLUSION_RULE,
  deriveSeedSubpaths: async () => [
    {
      subpath: CONSUMER_SUBPATH,
      reason: 'consumer-repo',
      minExports: MIN_TOOL_EXPORTS,
    },
    ...(await readBuiltInToolModules()).map((subpath) => ({
      subpath,
      reason: 'computed-specifier',
      minExports: MIN_TOOL_EXPORTS,
    })),
  ],
  reasonForUnwatched: (module) =>
    module.startsWith('tools/') ? 'computed-specifier' : 'unwatched',
  minExportsForUnwatched: MIN_TOOL_EXPORTS,
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
} = agent;

/**
 * Which tool modules the package will load at runtime, read from the BUILT
 * {@link TOOL_REGISTRY_SUBPATH} through the `exports` map — the same table, reached the same way,
 * that `getBuiltInTools` looks a module path up in before it builds its computed specifier.
 *
 * The table's values are `#src/…` specifiers, which is how the package names its own modules; the
 * published subpath is the same path without that prefix. Derived rather than written down, so a
 * tool added to the registry joins this gate the day it appears.
 *
 * @returns {Promise<string[]>} Published subpaths, in the order the package declares them.
 */
export async function readBuiltInToolModules() {
  const resolved = agent.resolveSubpath(TOOL_REGISTRY_SUBPATH);
  const namespace = await import(pathToFileURL(resolved).href);
  const table = namespace.AVAILABLE_BUILT_IN_TOOLS;
  if (!table || typeof table !== 'object' || Object.keys(table).length === 0) {
    throw new Error(
      `${NAME}/${TOOL_REGISTRY_SUBPATH} no longer exports a non-empty AVAILABLE_BUILT_IN_TOOLS object — the tool list this gate derives from has collapsed, and a collapsed list gates nothing`
    );
  }
  const subpaths = [];
  for (const [toolName, specifier] of Object.entries(table)) {
    if (typeof specifier !== 'string' || !specifier.startsWith('#src/')) {
      throw new Error(
        `${NAME}/${TOOL_REGISTRY_SUBPATH} maps ${toolName} to ${JSON.stringify(specifier)}, which is not a "#src/…" module specifier — this gate derives the published subpath by stripping that prefix, and cannot do so for this entry`
      );
    }
    subpaths.push(specifier.slice('#src/'.length));
  }
  return subpaths;
}
