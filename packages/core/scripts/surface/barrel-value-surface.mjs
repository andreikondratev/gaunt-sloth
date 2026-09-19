/**
 * Derive a workspace package's public RUNTIME (value) surface from its built barrel, and compare
 * that derivation against a committed golden.
 *
 * This is the ENGINE. It carries no package of its own: {@link createBarrelValueSurface} takes a
 * descriptor and hands back the same bag of functions bound to that package, and each package
 * keeps a one-screen instance file beside its own spec —
 * `packages/core/scripts/value-surface.mjs`, `packages/agent/scripts/value-surface.mjs`,
 * `packages/batch/scripts/value-surface.mjs`. A spec's docblock is where the DESIGN for that
 * package is written down: what is pinned, and what the pin does and does not catch. This file is
 * the mechanism, and it is one implementation rather than three copies because three copies of
 * this logic is how the next package gets missed.
 *
 * It is the value-half twin of `type-surface.mjs`, and deliberately shares that file's shape:
 * a derivation, a degeneracy guard that runs before the memo, a projection onto a committed
 * document, and a drift reporter that says which KIND of change happened rather than only that
 * one did.
 *
 * **No shebang, and no top-level side effects.** Vitest inlines a non-`node_modules` `.mjs` and
 * evaluates it inside an AsyncFunction wrapper, where a surviving shebang is a hard `SyntaxError`
 * — and on the path Vitest takes for absolute Windows paths the shebang strip does not apply, so
 * it fails on the Windows cell alone (OPS-26). The executable half lives in each package's
 * `generate-value-surface.mjs`; this half is a library the specs can import on every platform.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const requireHere = createRequire(import.meta.url);

/**
 * The TypeScript devDependency, loaded as a library for the declared-class cross-check below.
 * Reached through `createRequire` rather than imported because no package here declares a
 * dependency on `typescript`: it is the repo's build tool, and neither this file nor any spec tree
 * is part of what a package ships. Anchored at THIS file, not at the described package, because it
 * is the compiler rather than anything about the surface under test.
 */
const ts = requireHere('typescript');

/**
 * Classify one exported value the way an embedder would care about it.
 *
 * **`class` is separated from `function` semantically, not by reading source text.** A class
 * constructor's own `prototype` property is non-writable; an ordinary function's is writable, and
 * an arrow function or concise method has no `prototype` at all. Sniffing `toString()` for a
 * leading `class` keyword would agree today and disagree the moment anything is minified or
 * re-emitted, and it reads a decompiled string where a property descriptor is the actual language
 * semantics.
 *
 * **Objects keep their internal tag** (`array`, `regexp`, `map`, …) rather than flattening to
 * `object`, because a public constant changing from an array to a plain object is a break for
 * every embedder that iterates it, and a pin that cannot see it is not worth the field.
 *
 * The kinds are what the emitted artifact IS, so they follow the build target: a build that
 * downlevelled classes to ES5 functions would move names from `class` to `function` and be
 * reported as a kind change. That is correct — it is a real change to what an embedder receives.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function kindOf(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'function') {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'prototype');
    return descriptor && descriptor.writable === false ? 'class' : 'function';
  }
  if (type !== 'object') return type;
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  return tag === 'Object' ? 'object' : tag.toLowerCase();
}

/**
 * Order by code units rather than by locale.
 *
 * `localeCompare` depends on the ICU data the platform ships, and a golden regenerated on Windows
 * and compared on Linux must be byte-identical. The file's order is fixed here and never inherited
 * from the platform.
 */
export function byCodeUnit(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Order two golden entries totally, over both pinned fields. */
export function byNameKind(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return byCodeUnit(a.kind, b.kind);
}

/** `name (kind)` — how one entry is named in a drift report. */
function label(entry) {
  return `${entry.name} (${entry.kind})`;
}

/** Index one golden document's export list by name. */
function indexByName(document) {
  const index = new Map();
  for (const entry of document.exports ?? []) index.set(entry.name, entry);
  return index;
}

/**
 * Every name a `.d.ts` declares as an export, and whether the declarations call it a class.
 *
 * Reading the DECLARATIONS rather than importing the module is what makes this usable on a module
 * that must not be executed — `@gaunt-sloth/batch`'s `bin.js` runs the `gth-batch` CLI on import,
 * prints its usage and can exit the process, so a probe that imported it would take the test run
 * with it. The emitted declarations answer "what does this module publish" without running a line
 * of it.
 *
 * `isValue` is the broader half of the same oracle: a name the declarations export in a VALUE
 * position must also exist at runtime. That is what an `export *` rewritten as `export type *`
 * breaks — it leaves the declarations exporting the names as types while the emitted JavaScript
 * hands out nothing — and it is checkable on a surface that declares no class at all, where the
 * class-only cross-check would assert nothing.
 *
 * @param {string} declarationFile Absolute path to an emitted `.d.ts`.
 * @returns {{name: string, isClass: boolean, isValue: boolean}[]} Sorted by name.
 */
export function listDeclaredExports(declarationFile) {
  if (!existsSync(declarationFile)) {
    throw new Error(
      `${declarationFile} is missing — build the package before running this spec (pnpm test builds first; pnpm run unit does not)`
    );
  }
  const program = ts.createProgram([declarationFile], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(declarationFile);
  if (!sourceFile) {
    throw new Error(`${declarationFile} exists but the compiler did not load it`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  // A declaration file with no exports at all has no module symbol. That is a real answer —
  // "this module publishes nothing" — and not a failure, so it is reported as the empty list.
  if (!moduleSymbol) return [];

  return checker
    .getExportsOfModule(moduleSymbol)
    .map((exported) => {
      const target =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      return {
        name: exported.name,
        isClass: Boolean(target.flags & ts.SymbolFlags.Class),
        isValue: Boolean(target.flags & ts.SymbolFlags.Value),
      };
    })
    .sort((a, b) => byCodeUnit(a.name, b.name));
}

/**
 * @typedef {object} BarrelDescriptor
 * @property {string} packageName The name an embedder writes, e.g. `@gaunt-sloth/agent`.
 * @property {string} packageDir Absolute path to `packages/<pkg>`.
 * @property {string} goldenPath Absolute path to the committed golden.
 * @property {string} buildCommand The command that refreshes `dist/`, named in failure messages.
 * @property {string} regenerateCommand The one command that rewrites the golden.
 * @property {string} goldenComment Header written into the golden, so the file says what it is.
 * @property {number} minValueExports Degeneracy floor — see {@link createBarrelValueSurface}.
 * @property {string[]} requiredKinds Kinds the classifier must distinguish on THIS surface.
 */

/**
 * Bind every part of the barrel probe to one package.
 *
 * **`minValueExports` and `requiredKinds` are per-package and must be measured, not inherited.**
 * They are degeneracy guards, and a guard copied from a bigger package is a guard that fires on a
 * healthy small one: core's floor of 60 is above `@gaunt-sloth/batch`'s real barrel, and core's
 * required kinds include `class`, which batch's barrel legitimately does not export at all. Either
 * mistake reads as a genuine failure for as long as it takes to find this sentence.
 *
 * **The memo is per instance.** It is a closure variable rather than module state precisely
 * because this module now serves several packages: a memo shared across instances would hand the
 * second package the first one's surface, and the generator would write that into the second
 * package's golden — which then compares clean against itself forever.
 *
 * @param {BarrelDescriptor} descriptor
 */
export function createBarrelValueSurface(descriptor) {
  const {
    packageName,
    packageDir,
    goldenPath,
    buildCommand,
    regenerateCommand,
    goldenComment,
    minValueExports,
    requiredKinds,
  } = descriptor;

  const distDir = path.join(packageDir, 'dist');
  const distBarrelJs = path.join(distDir, 'index.js');
  const distBarrelTypes = path.join(distDir, 'index.d.ts');

  /**
   * Resolution anchored at the DESCRIBED package's own manifest, so `packageName` resolves by
   * SELF-REFERENCE: Node walks up to that `package.json` and matches subpath `.` in its `exports`
   * map, and nothing in `node_modules` and no workspace link takes part. That is why the probe is
   * worth more than reading `dist/index.js` by path — a break in the `exports` map, or an
   * `exports` map pointed at something that is not the built barrel, is exactly the kind of
   * packaging regression that reds nothing inside this repository where every module is reachable
   * by its own path.
   */
  const requireFromPackage = createRequire(path.join(packageDir, 'package.json'));

  /**
   * Fail with the cause rather than with whatever a missing artifact makes the next call throw.
   *
   * Both halves of the built barrel are required: the emitted JavaScript is the runtime surface
   * this derives, and the emitted declarations are the independent oracle the class cross-check
   * reads.
   */
  function requireBuiltBarrel() {
    for (const artifact of [distBarrelJs, distBarrelTypes]) {
      if (!existsSync(artifact)) {
        throw new Error(
          `${artifact} is missing — build the package before running this spec (pnpm test builds first; pnpm run unit does not)`
        );
      }
    }
  }

  /** @returns {string} Absolute path to the resolved barrel. */
  function resolveBarrelEntry() {
    return requireFromPackage.resolve(packageName);
  }

  /**
   * Which names the barrel exports as CLASSES according to the emitted declarations.
   *
   * This is the independent oracle, and the reason it is worth the TypeScript dependency. A class
   * is both a type and a value, so a name the declarations call a class MUST also be importable as
   * a runtime value — an invariant whose two sides are written by different emitters into
   * different files. The expectation therefore does not come from the artifact under test, which
   * is what separates this cell from the golden's change-detection.
   *
   * Measured, and the reason this exists: rewriting one `export *` in `src/index.ts` as
   * `export type *` leaves the declarations byte-identical in surface while the emitted JavaScript
   * silently drops the runtime exports, class included. Every cell of a type-surface spec stays
   * green through that change.
   *
   * @returns {string[]} Sorted class names.
   */
  function deriveDeclaredClasses() {
    requireBuiltBarrel();
    const declared = listDeclaredExports(distBarrelTypes);
    if (declared.length === 0) {
      throw new Error(`${distBarrelTypes} declares no module — it exports nothing`);
    }
    return declared.filter((entry) => entry.isClass).map((entry) => entry.name);
  }

  /**
   * Refuse a derivation that is degenerate rather than merely small.
   *
   * Called by the derivation **before it memoises**, so every consumer inherits it — including the
   * generator, which must never write a collapsed probe into the golden and thereby launder the
   * collapse into the reviewed expectation.
   *
   * Its reach is exactly these three checks: they refuse a probe that imported the wrong thing or
   * a classifier that collapsed, not a surface that came back smaller than it should have. That
   * second case is the golden's job. Keeping both is not redundancy — they fail for different
   * reasons and say different sentences.
   */
  function assertNonDegenerate(surface) {
    const relative = path.relative(distDir, surface.entry);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `${packageName} resolved to ${surface.entry}, which is outside ${distDir} — the probe is not reading the built barrel, so it says nothing about what an embedder gets`
      );
    }
    if (surface.exports.length < minValueExports) {
      throw new Error(
        `the value-surface probe found only ${surface.exports.length} runtime exports, below the floor of ${minValueExports} — this is a broken probe, not a small API`
      );
    }
    const kinds = new Set(surface.exports.map((entry) => entry.kind));
    const missing = requiredKinds.filter((kind) => !kinds.has(kind));
    if (missing.length > 0) {
      throw new Error(
        `the value-surface probe classified no export as ${missing.join(', ')} — the kind classifier has collapsed, and a collapsed classifier compares clean against its own golden forever`
      );
    }
  }

  /** @type {Promise<object> | undefined} Per-instance, never module state. */
  let derived;

  /**
   * Import the built barrel the way a consumer does and answer what it hands out at runtime.
   *
   * The promise is memoised rather than the value, so a derivation that was refused stays refused:
   * no consumer can retry its way past {@link assertNonDegenerate} into a degenerate surface.
   */
  function deriveValueSurface() {
    derived ??= deriveValueSurfaceUncached();
    return derived;
  }

  async function deriveValueSurfaceUncached() {
    requireBuiltBarrel();
    const entry = resolveBarrelEntry();
    // `pathToFileURL` rather than the bare path: on win32 an absolute path is not a valid import
    // specifier, and the failure there looks like a missing module rather than a bad specifier.
    const namespace = await import(pathToFileURL(entry).href);

    const exports = Object.keys(namespace)
      .sort(byCodeUnit)
      .map((name) => ({ name, kind: kindOf(namespace[name]) }));

    const surface = { entry, exports, declaredClasses: deriveDeclaredClasses() };
    // Before the memo, so no consumer can ever read a degenerate surface.
    assertNonDegenerate(surface);
    return surface;
  }

  /**
   * Project a derivation onto the shape that gets committed.
   *
   * **What is in.** `name` is the point: an export that disappears breaks an embedder at runtime
   * and is invisible to every type-level check. `kind` catches the same name surviving as
   * something an embedder cannot use the same way — a class demoted to a plain object, a function
   * replaced by a string constant.
   *
   * **What is deliberately out.** `entry` is a machine-specific absolute path and has its own
   * assertion. `declaredClasses` is the expectation source for the cross-check, not a property of
   * the runtime surface, and freezing it would turn a live failure into an accepted state.
   * Function arity, object key sets and class member lists are SHAPE rather than surface: an
   * embedder's own compiler checks those against the shipped declarations, and pinning them here
   * would churn the golden on every internal refactor while adding nothing the type surface does
   * not already hold.
   */
  function toGoldenDocument(surface) {
    return {
      $comment: goldenComment,
      exports: surface.exports
        .map((entry) => ({ name: entry.name, kind: entry.kind }))
        .sort(byNameKind),
    };
  }

  /** Read the committed golden. Throws with the regeneration command if it is not there at all. */
  function readGoldenDocument() {
    if (!existsSync(goldenPath)) {
      throw new Error(`${goldenPath} is missing — regenerate it with: ${regenerateCommand}`);
    }
    return JSON.parse(readFileSync(goldenPath, 'utf8'));
  }

  /**
   * Say, in words a reader can act on, how the runtime surface differs from the committed golden —
   * or `null` when it does not.
   *
   * **Why this is not a bare deep-equality assertion:** the situations behind an equality failure
   * demand opposite responses, and `toEqual` renders them identically. Adding a public export is
   * ordinary work whose only correct answer is to regenerate the golden and commit it. Losing one
   * is the failure this pin exists to catch. A name that survived with a different KIND was
   * neither lost nor added, and told it is an addition a reader regenerates and ships the break.
   *
   * The loss branch names the cause that is hardest to see, because it is the one that leaves
   * every other check in this repository green.
   *
   * @returns {string | null}
   */
  function describeValueSurfaceDrift(committed, current) {
    const before = indexByName(committed);
    const after = indexByName(current);

    const gone = [];
    const added = [];
    const changed = [];

    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const was = before.get(name);
      const is = after.get(name);
      if (!is) gone.push(was);
      else if (!was) added.push(is);
      else if (was.kind !== is.kind) changed.push(`${name}: ${was.kind} -> ${is.kind}`);
    }

    const names = (entries) => entries.map(label).sort(byCodeUnit).join(', ');
    const sections = [];
    if (gone.length > 0) {
      sections.push(`GONE from the runtime surface (${gone.length}): ${names(gone)}`);
    }
    if (changed.length > 0) {
      sections.push(
        `KIND CHANGED (${changed.length}): ${[...changed].sort(byCodeUnit).join('; ')}`
      );
    }
    if (added.length > 0) {
      sections.push(`ADDED to the runtime surface (${added.length}): ${names(added)}`);
    }
    if (sections.length === 0) return null;

    let headline;
    /** @type {string[]} */
    let advice;
    if (gone.length > 0) {
      headline =
        'The public RUNTIME surface LOST exports the committed golden lists. Investigate before you regenerate.';
      advice = [
        'An export vanishing from the built barrel breaks an embedder at runtime, and no type-level',
        'check in this repository can see it. Three causes to rule out first — a STALE dist/ (this',
        `probe reads the built barrel as-is, so rebuild and run again: ${buildCommand}), a`,
        'deliberate narrowing of the public API, and the one that looks like neither: an `export *`',
        'in src/index.ts rewritten as `export type *`, which keeps every declaration and every type',
        'cell green while removing the values. Only once you have established which it is, and the',
        `removal is intended, regenerate the golden and commit it: ${regenerateCommand}`,
      ];
    } else if (changed.length > 0) {
      headline =
        'The public RUNTIME surface kept every name but BOUND one or more to a different KIND. That is neither a loss nor an addition, so neither of the usual answers fits it.';
      advice = [
        'A class demoted to a plain object, or a function replaced by a constant, breaks every',
        'embedder that constructs or calls it while leaving the name importable — which is why the',
        'name set alone cannot see this. Establish that the new kind is what you meant, then',
        `regenerate the golden and commit it: ${regenerateCommand}`,
      ];
    } else {
      headline =
        'The public runtime surface no longer matches the committed golden, and nothing was lost.';
      advice = [
        'That is what a deliberate API addition looks like from here. Regenerate the golden and',
        `commit it alongside the change: ${regenerateCommand}`,
      ];
    }

    return [headline, '', ...sections, '', advice.join('\n')].join('\n');
  }

  return {
    PACKAGE_NAME: packageName,
    PACKAGE_DIR: packageDir,
    DIST_DIR: distDir,
    DIST_BARREL_JS: distBarrelJs,
    DIST_BARREL_TYPES: distBarrelTypes,
    GOLDEN_PATH: goldenPath,
    BUILD_COMMAND: buildCommand,
    REGENERATE_COMMAND: regenerateCommand,
    GOLDEN_COMMENT: goldenComment,
    MIN_VALUE_EXPORTS: minValueExports,
    REQUIRED_KINDS: requiredKinds,
    requireBuiltBarrel,
    resolveBarrelEntry,
    deriveDeclaredClasses,
    assertNonDegenerate,
    deriveValueSurface,
    toGoldenDocument,
    readGoldenDocument,
    describeValueSurfaceDrift,
  };
}
