/**
 * Derive the public RUNTIME (value) surface of the core package's GATED DEEP SUBPATHS, and compare
 * that derivation against the committed golden in `spec/coreDeepSubpathValueSurface.golden.json`.
 *
 * `value-surface.mjs` is the twin of this file and pins the ROOT BARREL, `@gaunt-sloth/core`.
 * This one pins a chosen few of the paths reachable as `@gaunt-sloth/core/<something>.js`. Read
 * `spec/coreDeepSubpathValueSurface.spec.ts` for the design — which paths are gated, which are
 * left to the compiler, and on what evidence. This file is the mechanism.
 *
 * **Why only a few paths, when `exports` publishes 128 of them.** `exports` here is
 * `{".": "./dist/index.js", "./*.js": "./dist/*.js"}` — a wildcard, so the published subpath set is
 * not a list anyone wrote down but whatever the build emits. Gating all of it would pin every
 * internal module of the package, and would be largely redundant: 116 of the 128 are named by a
 * literal import specifier in some package's production `src/`, so `tsc` resolves that edge and
 * re-proves the names taken across it on every build. The remaining twelve are what this file and
 * the barrel golden between them cover, and they are the three shapes a type checker cannot see:
 *
 * - a path reached by a COMPUTED specifier,
 * - a path imported only from outside this repository, and
 * - a path nothing in this repository imports at all.
 *
 * **No shebang, and no top-level side effects.** Vitest inlines a non-`node_modules` `.mjs` and
 * evaluates it inside an AsyncFunction wrapper, where a surviving shebang is a hard `SyntaxError`
 * — and on the path Vitest takes for absolute Windows paths the shebang strip does not apply, so
 * it fails on the Windows cell alone (OPS-26). The executable half lives in the sibling CLI entry;
 * this half is a library the spec can import on every platform.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { kindOf } from './value-surface.mjs';

const requireHere = createRequire(import.meta.url);

/** The name an embedder writes. Resolved by SELF-REFERENCE through the package `exports` map. */
export const PACKAGE_NAME = '@gaunt-sloth/core';

/** The `packages/core` directory — this file lives one level down, in `scripts/`. */
export const CORE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const DIST_DIR = path.join(CORE_DIR, 'dist');

/** The committed golden: the deep-subpath name/kind sets as they were last reviewed. */
export const GOLDEN_PATH = path.join(CORE_DIR, 'spec', 'coreDeepSubpathValueSurface.golden.json');

/** The probe reads the built package, so a regeneration is only as fresh as `dist/`. */
export const BUILD_COMMAND = 'pnpm --filter @gaunt-sloth/core run build';

/**
 * The one command that rewrites the golden — the SAME command that rewrites the root barrel's,
 * because one generator writes both. A surface change that moves one of them usually moves the
 * other, and two commands is one command to forget.
 */
export const REGENERATE_COMMAND = `${BUILD_COMMAND} && pnpm --filter @gaunt-sloth/core run value-surface:generate`;

/** Header written into the golden, so the file says what it is to whoever opens it first. */
export const GOLDEN_COMMENT = `GENERATED — do not hand-edit. The public runtime (value) surface of the core package's GATED DEEP SUBPATHS, resolved through the package exports map by scripts/deep-subpath-surface.mjs and compared against this file by spec/coreDeepSubpathValueSurface.spec.ts. The root barrel has its own golden, coreBarrelValueSurface.golden.json. Regenerate both with: ${REGENERATE_COMMAND}`;

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
 * The module the ROOT BARREL golden already pins, named here so the completeness check below can
 * account for it rather than report it as an escape.
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

/**
 * The packages whose `src/` trees are scanned for literal import specifiers — production source
 * only.
 *
 * **`spec/` is deliberately not scanned, and that is the whole point of the boundary.** A spec
 * importing `#src/providers/openai.js` does not stop a consumer's `gth init openai` from
 * exploding: the specs that do exactly that mock the LangChain peer away and assert on
 * `processJsonConfig` alone, which is why `init` could be deleted with every suite green. Counting
 * a spec as coverage would move all eleven provider modules out of this gate and leave the node's
 * gap exactly where it was found.
 */
export const PRODUCTION_SRC_GLOBS = ['src'];

/**
 * Which published modules some package's production source names with a LITERAL specifier.
 *
 * This is the measurement the exclusion rests on, and it is read off the source rather than
 * assumed. Three spellings reach a module in this repository and all three are resolved by `tsc`:
 * `@gaunt-sloth/core/<path>` from a sibling package, `#src/<path>` from within core, and a
 * relative path from within core.
 *
 * A dynamic `import()` with a literal argument counts — `tsc` checks those too. A dynamic
 * `import()` built from a TEMPLATE does not, and cannot, which is the hole this whole file exists
 * for; the regexes below only ever match a quoted literal, so a computed specifier is invisible to
 * them exactly as it is invisible to the compiler.
 *
 * @returns {Set<string>} Module paths relative to `dist/`, forward slashes.
 */
export function listLiterallyImportedModules() {
  const packagesDir = path.join(CORE_DIR, '..');
  const found = new Set();
  for (const pkg of readdirSync(packagesDir)) {
    for (const globName of PRODUCTION_SRC_GLOBS) {
      const srcDir = path.join(packagesDir, pkg, globName);
      if (!existsSync(srcDir)) continue;
      for (const file of walkFiles(srcDir, ['.ts', '.tsx'])) {
        const code = readFileSync(file, 'utf8');
        for (const match of code.matchAll(
          /from\s+'@gaunt-sloth\/core\/([^']+)'|import\(\s*'@gaunt-sloth\/core\/([^']+)'\s*\)/g
        )) {
          found.add(match[1] ?? match[2]);
        }
        if (pkg !== 'core') continue;
        for (const match of code.matchAll(
          /from\s+'#src\/([^']+)'|import\(\s*'#src\/([^']+)'\s*\)/g
        )) {
          found.add(match[1] ?? match[2]);
        }
        for (const match of code.matchAll(/from\s+'(\.[^']+)'|import\(\s*'(\.[^']+)'\s*\)/g)) {
          const relative = match[1] ?? match[2];
          const fromDir = path.dirname(path.relative(srcDir, file));
          found.add(path.normalize(path.join(fromDir, relative)).split(path.sep).join('/'));
        }
      }
    }
  }
  return found;
}

/**
 * Published modules that NO literal specifier in production source names — the population `tsc`
 * cannot speak for, and therefore the population this gate must cover.
 *
 * `index.js` is subtracted because the root barrel has its own golden; everything else here is
 * gated by this one.
 *
 * @returns {string[]} Sorted module paths.
 */
export function listUnwatchedModules() {
  const literal = listLiterallyImportedModules();
  const gatedElsewhere = new Set(GATED_ELSEWHERE.map((entry) => entry.module));
  return listPublishedModules()
    .filter((module) => !literal.has(module) && !gatedElsewhere.has(module))
    .sort(byCodeUnit);
}

/**
 * Resolve one subpath the way an embedder's `import` would.
 *
 * This resolves by SELF-REFERENCE: Node walks up to this package's own `package.json` and matches
 * the subpath against its `exports` map, so nothing in `node_modules` and no workspace link takes
 * part — and, importantly, neither does the Vitest alias that rewrites `@gaunt-sloth/…` onto `src`
 * inside this repository's specs. What comes back is the file a consumer gets.
 *
 * @param {string} subpath A published subpath such as `config.js` or `providers/openai.js`.
 * @returns {string} Absolute path to the resolved module.
 */
export function resolveSubpath(subpath) {
  return requireHere.resolve(`${PACKAGE_NAME}/${subpath}`);
}

/**
 * Which provider modules the package claims to support, read from the BUILT `config.js` through
 * the `exports` map — the same list, reached the same way, that
 * `packages/app/src/commands/configSetup.ts` validates `gth init <provider>` against before it
 * builds its computed specifier.
 *
 * @returns {Promise<string[]>} Provider ids, in the order the package declares them.
 */
export async function readAvailableDefaultConfigs() {
  const resolved = resolveSubpath(CONSUMER_SUBPATH);
  const namespace = await import(pathToFileURL(resolved).href);
  const ids = namespace.availableDefaultConfigs;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error(
      `${PACKAGE_NAME}/${CONSUMER_SUBPATH} no longer exports a non-empty availableDefaultConfigs array — the provider list this gate derives from has collapsed, and a collapsed list gates nothing`
    );
  }
  return [...ids];
}

/**
 * @typedef {object} GatedSubpath
 * @property {string} subpath The published subpath, always with forward slashes.
 * @property {keyof GATE_REASONS} reason Why it is gated.
 * @property {number} minExports The degeneracy floor for this subpath alone.
 */

/**
 * The subpaths this gate pins. Every part of it is DERIVED, so nothing here has to be remembered:
 *
 * - `config.js`, because a consumer repository imports it and nothing in this repository does so
 *   on that consumer's behalf;
 * - `providers/<id>.js` for every id in `availableDefaultConfigs`, because `gth init <id>` reaches
 *   those through a computed specifier no type checker can follow;
 * - **every other published module that no literal specifier in production source names**, because
 *   that is precisely the population `tsc` cannot speak for. Today that clause adds
 *   `providers/fake.js`, reachable from an `llm.type` in a user's config through the loader's own
 *   computed specifier.
 *
 * That last clause is what makes the gate self-maintaining, and it is deliberately a rule and not
 * a list: a new module that nothing type-checks joins the gate the day it appears, and the golden
 * cell reds naming it as a newly gated subpath rather than letting it slip into the published
 * surface unwatched — which is the exact thing the node behind this file was filed about.
 *
 * @returns {Promise<GatedSubpath[]>}
 */
export async function deriveGatedSubpaths() {
  const gated = new Map();
  gated.set(CONSUMER_SUBPATH, {
    subpath: CONSUMER_SUBPATH,
    reason: 'consumer-repo',
    minExports: MIN_CONSUMER_SUBPATH_EXPORTS,
  });
  for (const id of await readAvailableDefaultConfigs()) {
    const subpath = `providers/${id}.js`;
    gated.set(subpath, { subpath, reason: 'computed-specifier', minExports: MIN_PROVIDER_EXPORTS });
  }
  for (const module of listUnwatchedModules()) {
    if (gated.has(module)) continue;
    gated.set(module, {
      subpath: module,
      reason: module.startsWith('providers/') ? 'computed-specifier' : 'unwatched',
      minExports: MIN_PROVIDER_EXPORTS,
    });
  }
  return [...gated.values()].sort((a, b) => byCodeUnit(a.subpath, b.subpath));
}

/**
 * @typedef {object} SubpathSurface
 * @property {string} subpath The published subpath.
 * @property {keyof GATE_REASONS} reason Why it is gated.
 * @property {number} minExports The degeneracy floor for this subpath.
 * @property {string} entry The resolved module, as Node's own resolution answered it.
 * @property {{name: string, kind: string}[]} exports Every runtime export, sorted by name.
 */

/**
 * @typedef {object} DeepSurface
 * @property {SubpathSurface[]} subpaths One entry per gated subpath, sorted by subpath.
 */

/**
 * Refuse a derivation that is degenerate rather than merely small.
 *
 * Called by {@link deriveDeepSubpathSurface} **before it memoises**, so every consumer inherits it
 * — including the generator, which must never write a collapsed probe into the golden and thereby
 * launder the collapse into the reviewed expectation.
 *
 * Its reach is exactly these three checks: no gated subpaths at all, a subpath that resolved
 * outside `dist/`, and a subpath that came back under its own floor. A surface that merely shrank
 * is the golden's job, and keeping both is not redundancy — they fail for different reasons and
 * say different sentences.
 *
 * @param {DeepSurface} surface
 */
export function assertNonDegenerate(surface) {
  if (surface.subpaths.length === 0) {
    throw new Error(
      'the deep-subpath probe gated no subpaths at all — a gate over an empty list compares clean against its own golden forever'
    );
  }
  for (const entry of surface.subpaths) {
    const relative = path.relative(DIST_DIR, entry.entry);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `${PACKAGE_NAME}/${entry.subpath} resolved to ${entry.entry}, which is outside ${DIST_DIR} — the probe is not reading the built package, so it says nothing about what a consumer gets`
      );
    }
    if (entry.exports.length < entry.minExports) {
      throw new Error(
        `the deep-subpath probe found only ${entry.exports.length} runtime exports on ${PACKAGE_NAME}/${entry.subpath}, below its floor of ${entry.minExports} — this is a broken probe, not a small module`
      );
    }
  }
}

/** @type {Promise<DeepSurface> | undefined} */
let derived;

/**
 * Import each gated subpath the way a consumer does and answer what it hands out at runtime.
 *
 * The promise is memoised rather than the value, so a derivation that was refused stays refused:
 * no consumer can retry its way past {@link assertNonDegenerate} into a degenerate surface.
 *
 * @returns {Promise<DeepSurface>}
 */
export function deriveDeepSubpathSurface() {
  derived ??= deriveDeepSubpathSurfaceUncached();
  return derived;
}

/** @returns {Promise<DeepSurface>} */
async function deriveDeepSubpathSurfaceUncached() {
  const gated = await deriveGatedSubpaths();
  const subpaths = [];
  for (const entry of gated) {
    const resolved = resolveSubpath(entry.subpath);
    // `pathToFileURL` rather than the bare path: on win32 an absolute path is not a valid import
    // specifier, and the failure there looks like a missing module rather than a bad specifier.
    const namespace = await import(pathToFileURL(resolved).href);
    subpaths.push({
      ...entry,
      entry: resolved,
      exports: Object.keys(namespace)
        .sort(byCodeUnit)
        .map((name) => ({ name, kind: kindOf(namespace[name]) })),
    });
  }
  /** @type {DeepSurface} */
  const surface = { subpaths };
  // Before the memo, so no consumer can ever read a degenerate surface.
  assertNonDegenerate(surface);
  return surface;
}

/**
 * Every file under a directory whose name ends in one of `extensions`.
 *
 * @param {string} dir
 * @param {string[]} extensions
 * @returns {string[]} Absolute paths.
 */
function walkFiles(dir, extensions) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walkFiles(full, extensions));
    else if (extensions.some((extension) => name.endsWith(extension))) found.push(full);
  }
  return found;
}

/**
 * Every `.js` module the wildcard in `exports` publishes, as forward-slash paths relative to
 * `dist/` — the list nobody wrote and the build decides.
 *
 * @returns {string[]} Sorted module paths.
 */
export function listPublishedModules() {
  if (!existsSync(DIST_DIR)) {
    throw new Error(
      `${DIST_DIR} is missing — build the package before running this spec (pnpm test builds first; pnpm run unit does not)`
    );
  }
  return walkFiles(DIST_DIR, ['.js'])
    .map((full) => path.relative(DIST_DIR, full).split(path.sep).join('/'))
    .sort(byCodeUnit);
}

/**
 * Order by code units rather than by locale.
 *
 * `localeCompare` depends on the ICU data the platform ships, and a golden regenerated on Windows
 * and compared on Linux must be byte-identical. The file's order is fixed here and never inherited
 * from the platform.
 */
function byCodeUnit(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Order two golden entries totally, over both pinned fields. */
function byNameKind(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return byCodeUnit(a.kind, b.kind);
}

/**
 * Project a derivation onto the shape that gets committed.
 *
 * **What is in.** The subpath, because a path that stops resolving breaks a consumer while every
 * name it exports still exists somewhere. The reason, because the node this gate answers asked for
 * a recorded decision per path and a reason nobody can read is not one. Then `name` and `kind`,
 * for the same reasons the root barrel's golden pins them.
 *
 * **What is deliberately out.** `entry` is a machine-specific absolute path and has its own
 * assertion. `minExports` is a guard parameter rather than a property of the surface, and freezing
 * it into the reviewed expectation would invite tuning it down to clear a red.
 *
 * The reasons and the rule that decides everything else travel with the file rather than living
 * only in the spec, so the one artifact a reviewer opens on a red says both what is watched and
 * why the rest needs no watching.
 *
 * @param {DeepSurface} surface
 */
export function toGoldenDocument(surface) {
  return {
    $comment: GOLDEN_COMMENT,
    $reasons: GATE_REASONS,
    $gatedElsewhere: GATED_ELSEWHERE,
    $everythingElse: EXCLUSION_RULE,
    subpaths: surface.subpaths
      .map((entry) => ({
        subpath: entry.subpath,
        reason: entry.reason,
        exports: entry.exports.map((e) => ({ name: e.name, kind: e.kind })).sort(byNameKind),
      }))
      .sort((a, b) => byCodeUnit(a.subpath, b.subpath)),
  };
}

/** Read the committed golden. Throws with the regeneration command if it is not there at all. */
export function readGoldenDocument() {
  if (!existsSync(GOLDEN_PATH)) {
    throw new Error(`${GOLDEN_PATH} is missing — regenerate it with: ${REGENERATE_COMMAND}`);
  }
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
}

/** `name (kind)` — how one entry is named in a drift report. */
function label(entry) {
  return `${entry.name} (${entry.kind})`;
}

/** Index a golden document's subpath list by subpath. */
function indexBySubpath(document) {
  const index = new Map();
  for (const entry of document.subpaths ?? []) index.set(entry.subpath, entry);
  return index;
}

/** Index one subpath's export list by name. */
function indexByName(entry) {
  const index = new Map();
  for (const exported of entry?.exports ?? []) index.set(exported.name, exported);
  return index;
}

/**
 * Say, in words a reader can act on, how the gated deep subpaths differ from the committed golden
 * — or `null` when they do not.
 *
 * **Why this is not a bare deep-equality assertion:** the situations behind an equality failure
 * demand opposite responses, and `toEqual` renders them identically. Adding an export is ordinary
 * work whose only correct answer is to regenerate the golden. Losing one is the failure this pin
 * exists to catch. A whole SUBPATH disappearing is worse than either and has a cause neither of
 * them has — a narrowed `exports` map, or a module renamed into a directory — so it gets a branch
 * and a headline of its own rather than being reported as a pile of lost names.
 *
 * @param {ReturnType<typeof toGoldenDocument>} committed
 * @param {ReturnType<typeof toGoldenDocument>} current
 * @returns {string | null}
 */
export function describeDeepSurfaceDrift(committed, current) {
  const before = indexBySubpath(committed);
  const after = indexBySubpath(current);

  const subpathsGone = [];
  const subpathsAdded = [];
  const gone = [];
  const added = [];
  const changed = [];

  for (const subpath of [...new Set([...before.keys(), ...after.keys()])].sort(byCodeUnit)) {
    const was = before.get(subpath);
    const is = after.get(subpath);
    if (!is) {
      subpathsGone.push(subpath);
      continue;
    }
    if (!was) {
      subpathsAdded.push(subpath);
      continue;
    }
    const wasNames = indexByName(was);
    const isNames = indexByName(is);
    for (const name of [...new Set([...wasNames.keys(), ...isNames.keys()])].sort(byCodeUnit)) {
      const before1 = wasNames.get(name);
      const after1 = isNames.get(name);
      if (!after1) gone.push(`${subpath}: ${label(before1)}`);
      else if (!before1) added.push(`${subpath}: ${label(after1)}`);
      else if (before1.kind !== after1.kind) {
        changed.push(`${subpath}: ${name}: ${before1.kind} -> ${after1.kind}`);
      }
    }
  }

  const sections = [];
  if (subpathsGone.length > 0) {
    sections.push(`SUBPATHS NO LONGER GATED (${subpathsGone.length}): ${subpathsGone.join(', ')}`);
  }
  if (gone.length > 0) {
    sections.push(`GONE from the runtime surface (${gone.length}): ${gone.join('; ')}`);
  }
  if (changed.length > 0) {
    sections.push(`KIND CHANGED (${changed.length}): ${changed.join('; ')}`);
  }
  if (subpathsAdded.length > 0) {
    sections.push(`SUBPATHS NEWLY GATED (${subpathsAdded.length}): ${subpathsAdded.join(', ')}`);
  }
  if (added.length > 0) {
    sections.push(`ADDED to the runtime surface (${added.length}): ${added.join('; ')}`);
  }
  if (sections.length === 0) return null;

  let headline;
  /** @type {string[]} */
  let advice;
  if (subpathsGone.length > 0) {
    headline =
      'A gated deep SUBPATH is no longer part of the gated set. Investigate before you regenerate.';
    advice = [
      'This list is derived, so a subpath leaves it for one of two reasons, and they are not the',
      'same. A provider id removed from `availableDefaultConfigs` is a deliberate narrowing of',
      'what `gth init` offers, and regenerating is right once you have established that. A',
      'subpath that vanished for any other reason means a path a consumer or a computed specifier',
      'names no longer resolves — nothing else in this repository reds for that, because every',
      `module here is reachable by its own path. Establish which, then: ${REGENERATE_COMMAND}`,
    ];
  } else if (gone.length > 0) {
    headline =
      'A gated deep subpath LOST exports the committed golden lists. Investigate before you regenerate.';
    advice = [
      'These paths are gated precisely because no type checker watches them: the provider modules',
      'are reached from a computed specifier that `tsc` cannot follow, and config.js is imported',
      'by a consumer repository that builds against the published package. An export vanishing',
      'from one of them breaks a real caller at runtime with nothing else going red. Rule out a',
      `STALE dist/ first (this probe reads the built package as-is: ${BUILD_COMMAND}), then`,
      'establish the removal is intended, and only then regenerate the golden and commit it:',
      REGENERATE_COMMAND,
    ];
  } else if (changed.length > 0) {
    headline =
      'A gated deep subpath kept every name but BOUND one or more to a different KIND. That is neither a loss nor an addition, so neither of the usual answers fits it.';
    advice = [
      'A function replaced by a constant, or a class demoted to a plain object, breaks every',
      'caller that invokes or constructs it while leaving the name importable — which is why the',
      'name set alone cannot see this. Establish that the new kind is what you meant, then',
      `regenerate the golden and commit it: ${REGENERATE_COMMAND}`,
    ];
  } else {
    headline =
      'The gated deep subpaths no longer match the committed golden, and nothing was lost.';
    advice = [
      'That is what a deliberate addition looks like from here — a new export, or a new provider',
      'joining `availableDefaultConfigs` and bringing its module into the gate. Regenerate the',
      `golden and commit it alongside the change: ${REGENERATE_COMMAND}`,
    ];
  }

  return [headline, '', ...sections, '', advice.join('\n')].join('\n');
}
