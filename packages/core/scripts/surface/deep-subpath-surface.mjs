/**
 * Derive the public RUNTIME (value) surface of a package's GATED DEEP SUBPATHS — the paths a
 * caller reaches as `@gaunt-sloth/<pkg>/<something>.js` rather than through the root barrel — and
 * compare that derivation against a committed golden.
 *
 * This is the ENGINE, and `barrel-value-surface.mjs` is its twin for the root barrel. It carries
 * no package of its own: each package keeps a one-screen instance file that supplies a descriptor
 * and re-exports the result, and that instance file plus the package's spec is where the DESIGN
 * for that package is written down — which paths are gated, which are left to the compiler, and on
 * what evidence. This file is the mechanism, and it is one implementation rather than three copies
 * because three copies of this logic is how the next package gets missed.
 *
 * **Why a package gates only a few paths when its wildcard publishes many.** `exports` in each of
 * these packages is `{".": "./dist/index.js", "./*.js": "./dist/*.js"}`. The second entry is a
 * WILDCARD, so the published subpath set is not a list anyone wrote down but whatever the build
 * emits. Gating all of it would pin every internal module, and would be largely redundant: most
 * modules are named by a LITERAL import specifier in some package's production `src/`, so `tsc`
 * resolves that edge and re-proves the names taken across it on every build, on every cell of the
 * matrix. That is an earlier and louder gate than a golden. What is left over are the shapes a
 * type checker cannot see:
 *
 * - a path reached by a COMPUTED specifier,
 * - a path imported only from outside this repository, and
 * - a path nothing in this repository imports at all.
 *
 * **No shebang, and no top-level side effects.** Vitest inlines a non-`node_modules` `.mjs` and
 * evaluates it inside an AsyncFunction wrapper, where a surviving shebang is a hard `SyntaxError`
 * — and on the path Vitest takes for absolute Windows paths the shebang strip does not apply, so
 * it fails on the Windows cell alone (OPS-26). The executable half lives in each package's
 * `generate-value-surface.mjs`; this half is a library the specs can import on every platform.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { byCodeUnit, byNameKind, kindOf } from './barrel-value-surface.mjs';

/**
 * The packages whose `src/` trees are scanned for literal import specifiers — production source
 * only.
 *
 * **`spec/` is deliberately not scanned, and that is the whole point of the boundary.** A spec
 * importing `#src/providers/openai.js` does not stop a consumer's `gth init openai` from
 * exploding: the specs that do exactly that mock the LangChain peer away and assert on
 * `processJsonConfig` alone, which is why `init` could be deleted with every suite green. Counting
 * a spec as coverage would move every provider module out of the gate and leave the gap exactly
 * where it was found. The same holds for `@gaunt-sloth/agent`'s built-in tool modules.
 */
export const PRODUCTION_SRC_GLOBS = ['src'];

/**
 * Strip comments before scanning for import specifiers.
 *
 * **Measured, and the reason this exists:** widening the scan below from single quotes to single,
 * double and template quotes made it match six more specifiers in core, every one of them a path
 * quoted in ordinary docblock prose — `Re-exported from \`./promote.js\``, `one line from
 * \`.gitignore\``. One of those, `./promote.js`, names a module that really is published. Without
 * this strip a SENTENCE IN A COMMENT would count as evidence that `tsc` re-proves a module, which
 * moves it OUT of the gate: the blind direction, and the one failure this whole file exists to
 * prevent. The narrow single-quote scan was only accidentally safe from it.
 *
 * A stripper that removes too much is harmless here: a real import lost to it moves a module INTO
 * the gate, which is noise rather than blindness.
 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Escape a literal for embedding in a regular expression. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A specifier body: anything that is not a quote, not a newline, and does not begin an
 * interpolation. Excluding `${` is what keeps a COMPUTED specifier invisible to this scan exactly
 * as it is invisible to the compiler — which is the hole the gate exists for, so a template that
 * interpolates must never be mistaken for a literal.
 */
const SPECIFIER_BODY = String.raw`(?:(?!\$\{)[^'"\`\n])+`;

/**
 * Match `from <quote><prefix><body><quote>` and `import(<quote><prefix><body><quote>)` for all
 * three quotings TypeScript accepts. Prettier enforces single quotes in this repository, so the
 * other two are belt-and-braces — but a scan that silently stops matching is the one failure mode
 * that makes the whole exclusion rule a lie, and a formatter is not a gate.
 *
 * The closing quote is a BACKREFERENCE, so `'…"` cannot match across a mismatched pair.
 */
function quotedSpecifier(prefix) {
  return new RegExp(
    String.raw`from\s+(['"\`])${prefix}(${SPECIFIER_BODY})\1|import\(\s*(['"\`])${prefix}(${SPECIFIER_BODY})\3\s*\)`,
    'g'
  );
}

/** Which capture groups {@link quotedSpecifier} fills. */
const pickBody = (match) => match[2] ?? match[4];

/**
 * Every file under a directory whose name ends in one of `extensions`.
 *
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
 * @typedef {object} ScanDescriptor
 * @property {string} packageName The name an embedder writes, e.g. `@gaunt-sloth/agent`.
 * @property {string} packageDir Absolute path to `packages/<pkg>`.
 * @property {{module: string, why: string}[]} gatedElsewhere Published modules accounted for by
 *   something other than this gate, so the completeness check reports them as covered rather than
 *   as an escape. Each one needs a cell somewhere that actually holds it — an entry here is a
 *   claim, and a claim with nothing behind it is the exclusion this gate exists to eliminate.
 */

/**
 * The half of the gate that only READS — what the wildcard publishes, what a literal specifier
 * names, and the difference between them. A package with nothing worth gating still needs this,
 * because the completeness property is the one that survives a misclassification here.
 *
 * @param {ScanDescriptor} descriptor
 */
export function createPublishedModuleScan(descriptor) {
  const { packageName, packageDir, gatedElsewhere } = descriptor;
  const distDir = path.join(packageDir, 'dist');
  const packagesDir = path.join(packageDir, '..');
  const scopedPattern = quotedSpecifier(`${escapeRegExp(packageName)}/`);
  const hashPattern = quotedSpecifier('#src/');
  const relativePattern = quotedSpecifier('\\.');

  /** The directory name under `packages/`, which is how a `#src/` self-import is attributed. */
  const ownPackageDirName = path.basename(packageDir);

  /**
   * Every `.js` module the wildcard in `exports` publishes, as forward-slash paths relative to
   * `dist/` — the list nobody wrote and the build decides.
   *
   * @returns {string[]} Sorted module paths.
   */
  function listPublishedModules() {
    if (!existsSync(distDir)) {
      throw new Error(
        `${distDir} is missing — build the package before running this spec (pnpm test builds first; pnpm run unit does not)`
      );
    }
    return walkFiles(distDir, ['.js'])
      .map((full) => path.relative(distDir, full).split(path.sep).join('/'))
      .sort(byCodeUnit);
  }

  /**
   * Which of this package's published modules some package's production source names with a
   * LITERAL specifier.
   *
   * This is the measurement the exclusion rests on, and it is read off the source rather than
   * assumed. Three spellings reach a module in this repository and all three are resolved by
   * `tsc`: `<packageName>/<path>` from any package, `#src/<path>` from within the package itself,
   * and a relative path from within the package itself. The last two are attributed only to the
   * owning package, because `#src/` and `./` mean a different package's module in every other
   * package's source.
   *
   * A dynamic `import()` with a literal argument counts — `tsc` checks those too. A dynamic
   * `import()` built from a TEMPLATE does not, and cannot, which is the hole this whole file
   * exists for; {@link SPECIFIER_BODY} refuses an interpolation, so a computed specifier is
   * invisible here exactly as it is invisible to the compiler.
   *
   * @returns {Set<string>} Module paths relative to `dist/`, forward slashes.
   */
  function listLiterallyImportedModules() {
    const found = new Set();
    for (const pkg of readdirSync(packagesDir)) {
      for (const globName of PRODUCTION_SRC_GLOBS) {
        const srcDir = path.join(packagesDir, pkg, globName);
        if (!existsSync(srcDir)) continue;
        for (const file of walkFiles(srcDir, ['.ts', '.tsx'])) {
          const code = stripComments(readFileSync(file, 'utf8'));
          for (const match of code.matchAll(scopedPattern)) found.add(pickBody(match));
          if (pkg !== ownPackageDirName) continue;
          for (const match of code.matchAll(hashPattern)) found.add(pickBody(match));
          for (const match of code.matchAll(relativePattern)) {
            // The pattern's prefix consumed the leading dot, so put it back before resolving.
            const relative = `.${pickBody(match)}`;
            const fromDir = path.dirname(path.relative(srcDir, file));
            found.add(path.normalize(path.join(fromDir, relative)).split(path.sep).join('/'));
          }
        }
      }
    }
    return found;
  }

  /**
   * Published modules that NO literal specifier in production source names, minus those something
   * else accounts for — the population `tsc` cannot speak for, and therefore the population this
   * gate must cover.
   *
   * @returns {string[]} Sorted module paths.
   */
  function listUnwatchedModules() {
    const literal = listLiterallyImportedModules();
    const accountedFor = new Set(gatedElsewhere.map((entry) => entry.module));
    return listPublishedModules()
      .filter((module) => !literal.has(module) && !accountedFor.has(module))
      .sort(byCodeUnit);
  }

  return {
    PACKAGE_NAME: packageName,
    PACKAGE_DIR: packageDir,
    DIST_DIR: distDir,
    GATED_ELSEWHERE: gatedElsewhere,
    listPublishedModules,
    listLiterallyImportedModules,
    listUnwatchedModules,
  };
}

/**
 * @typedef {object} DeepSubpathDescriptor
 * @property {string} packageName
 * @property {string} packageDir
 * @property {{module: string, why: string}[]} gatedElsewhere
 * @property {string} goldenPath
 * @property {string} buildCommand
 * @property {string} regenerateCommand
 * @property {string} goldenComment
 * @property {Record<string, string>} gateReasons How a gated subpath earned its place, written
 *   into the golden beside each entry.
 * @property {string} exclusionRule Why everything NOT gated needs no gating, written into the
 *   golden so the one file a reviewer opens says both halves.
 * @property {() => Promise<{subpath: string, reason: string, minExports: number}[]>} deriveSeedSubpaths
 *   The paths this package gates on evidence other than "nothing names it" — a consumer
 *   repository's import, or a computed specifier whose target list is itself derived. Everything
 *   unwatched is added to whatever this returns.
 * @property {(module: string) => string} reasonForUnwatched
 * @property {number} minExportsForUnwatched
 */

/**
 * Bind the full deep-subpath gate to one package.
 *
 * **The memo is per instance**, for the same reason as the barrel engine's: a memo shared across
 * packages hands the second one the first one's surface, and the generator writes that into the
 * second package's golden, which then compares clean against itself forever.
 *
 * @param {DeepSubpathDescriptor} descriptor
 */
export function createDeepSubpathSurface(descriptor) {
  const {
    packageName,
    packageDir,
    goldenPath,
    buildCommand,
    regenerateCommand,
    goldenComment,
    gateReasons,
    exclusionRule,
    deriveSeedSubpaths,
    reasonForUnwatched,
    minExportsForUnwatched,
  } = descriptor;

  const scan = createPublishedModuleScan(descriptor);
  const distDir = scan.DIST_DIR;

  /**
   * Resolution anchored at the described package's own manifest, so a subpath resolves by
   * SELF-REFERENCE through that package's `exports` map — nothing in `node_modules`, no workspace
   * link, and, importantly, not the Vitest alias that rewrites `@gaunt-sloth/…` onto `src` inside
   * this repository's specs. What comes back is the file a consumer gets.
   */
  const requireFromPackage = createRequire(path.join(packageDir, 'package.json'));

  /** @param {string} subpath @returns {string} Absolute path to the resolved module. */
  function resolveSubpath(subpath) {
    return requireFromPackage.resolve(`${packageName}/${subpath}`);
  }

  /**
   * The subpaths this gate pins. Every part of it is DERIVED, so nothing here has to be
   * remembered: the seeds come from the package's own declared lists, and **every other published
   * module that no literal specifier names** is added, because that is precisely the population
   * `tsc` cannot speak for.
   *
   * That last clause is what makes the gate self-maintaining, and it is deliberately a rule and
   * not a list: a new module that nothing type-checks joins the gate the day it appears, and the
   * golden cell reds naming it as a newly gated subpath rather than letting it slip into the
   * published surface unwatched.
   */
  async function deriveGatedSubpaths() {
    const gated = new Map();
    for (const seed of await deriveSeedSubpaths()) gated.set(seed.subpath, seed);
    for (const module of scan.listUnwatchedModules()) {
      if (gated.has(module)) continue;
      gated.set(module, {
        subpath: module,
        reason: reasonForUnwatched(module),
        minExports: minExportsForUnwatched,
      });
    }
    return [...gated.values()].sort((a, b) => byCodeUnit(a.subpath, b.subpath));
  }

  /**
   * Refuse a derivation that is degenerate rather than merely small.
   *
   * Its reach is exactly these three checks: no gated subpaths at all, a subpath that resolved
   * outside `dist/`, and a subpath that came back under its own floor. A surface that merely
   * shrank is the golden's job, and keeping both is not redundancy — they fail for different
   * reasons and say different sentences.
   */
  function assertNonDegenerate(surface) {
    if (surface.subpaths.length === 0) {
      throw new Error(
        'the deep-subpath probe gated no subpaths at all — a gate over an empty list compares clean against its own golden forever'
      );
    }
    for (const entry of surface.subpaths) {
      const relative = path.relative(distDir, entry.entry);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(
          `${packageName}/${entry.subpath} resolved to ${entry.entry}, which is outside ${distDir} — the probe is not reading the built package, so it says nothing about what a consumer gets`
        );
      }
      if (entry.exports.length < entry.minExports) {
        throw new Error(
          `the deep-subpath probe found only ${entry.exports.length} runtime exports on ${packageName}/${entry.subpath}, below its floor of ${entry.minExports} — this is a broken probe, not a small module`
        );
      }
    }
  }

  /** @type {Promise<object> | undefined} Per-instance, never module state. */
  let derived;

  /**
   * Import each gated subpath the way a consumer does and answer what it hands out at runtime.
   *
   * The promise is memoised rather than the value, so a derivation that was refused stays refused:
   * no consumer can retry its way past {@link assertNonDegenerate} into a degenerate surface.
   */
  function deriveDeepSubpathSurface() {
    derived ??= deriveDeepSubpathSurfaceUncached();
    return derived;
  }

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
    const surface = { subpaths };
    // Before the memo, so no consumer can ever read a degenerate surface.
    assertNonDegenerate(surface);
    return surface;
  }

  /**
   * Project a derivation onto the shape that gets committed.
   *
   * **What is in.** The subpath, because a path that stops resolving breaks a consumer while every
   * name it exports still exists somewhere. The reason, because a recorded decision per path is
   * the point and a reason nobody can read is not one. Then `name` and `kind`, for the same
   * reasons the root barrel's golden pins them.
   *
   * **What is deliberately out.** `entry` is a machine-specific absolute path and has its own
   * assertion. `minExports` is a guard parameter rather than a property of the surface, and
   * freezing it into the reviewed expectation would invite tuning it down to clear a red.
   *
   * The reasons and the rule that decides everything else travel with the file rather than living
   * only in the spec, so the one artifact a reviewer opens on a red says both what is watched and
   * why the rest needs no watching.
   */
  function toGoldenDocument(surface) {
    return {
      $comment: goldenComment,
      $reasons: gateReasons,
      $gatedElsewhere: scan.GATED_ELSEWHERE,
      $everythingElse: exclusionRule,
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
  function readGoldenDocument() {
    if (!existsSync(goldenPath)) {
      throw new Error(`${goldenPath} is missing — regenerate it with: ${regenerateCommand}`);
    }
    return JSON.parse(readFileSync(goldenPath, 'utf8'));
  }

  return {
    ...scan,
    GOLDEN_PATH: goldenPath,
    BUILD_COMMAND: buildCommand,
    REGENERATE_COMMAND: regenerateCommand,
    GOLDEN_COMMENT: goldenComment,
    GATE_REASONS: gateReasons,
    EXCLUSION_RULE: exclusionRule,
    resolveSubpath,
    deriveGatedSubpaths,
    assertNonDegenerate,
    deriveDeepSubpathSurface,
    toGoldenDocument,
    readGoldenDocument,
    describeDeepSurfaceDrift: (committed, current) =>
      describeDeepSurfaceDrift(committed, current, { buildCommand, regenerateCommand }),
  };
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
 * @returns {string | null}
 */
export function describeDeepSurfaceDrift(committed, current, commands = {}) {
  const buildCommand = commands.buildCommand ?? 'the package build';
  const regenerateCommand = commands.regenerateCommand ?? 'the golden regeneration command';
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
      'same. An id removed from the package’s own declared list — a provider dropped from',
      '`availableDefaultConfigs`, a tool dropped from `AVAILABLE_BUILT_IN_TOOLS` — is a deliberate',
      'narrowing of what the package offers, and regenerating is right once you have established',
      'that. A subpath that vanished for any other reason means a path a consumer or a computed',
      'specifier names no longer resolves — nothing else in this repository reds for that, because',
      `every module here is reachable by its own path. Establish which, then: ${regenerateCommand}`,
    ];
  } else if (gone.length > 0) {
    headline =
      'A gated deep subpath LOST exports the committed golden lists. Investigate before you regenerate.';
    advice = [
      'These paths are gated precisely because no type checker watches them: they are reached from',
      'a computed specifier that `tsc` cannot follow, or imported only by a consumer repository',
      'that builds against the published package. An export vanishing from one of them breaks a',
      'real caller at runtime with nothing else going red. Rule out a STALE dist/ first (this',
      `probe reads the built package as-is: ${buildCommand}), then establish the removal is`,
      `intended, and only then regenerate the golden and commit it: ${regenerateCommand}`,
    ];
  } else if (changed.length > 0) {
    headline =
      'A gated deep subpath kept every name but BOUND one or more to a different KIND. That is neither a loss nor an addition, so neither of the usual answers fits it.';
    advice = [
      'A function replaced by a constant, or a class demoted to a plain object, breaks every',
      'caller that invokes or constructs it while leaving the name importable — which is why the',
      'name set alone cannot see this. Establish that the new kind is what you meant, then',
      `regenerate the golden and commit it: ${regenerateCommand}`,
    ];
  } else {
    headline =
      'The gated deep subpaths no longer match the committed golden, and nothing was lost.';
    advice = [
      'That is what a deliberate addition looks like from here — a new export, or a new id joining',
      'the package’s declared list and bringing its module into the gate. Regenerate the',
      `golden and commit it alongside the change: ${regenerateCommand}`,
    ];
  }

  return [headline, '', ...sections, '', advice.join('\n')].join('\n');
}
