import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  assertNonDegenerate,
  describeValueSurfaceDrift,
  deriveValueSurface,
  DIST_BARREL_TYPES,
  DIST_DIR,
  GOLDEN_PATH,
  listDeclaredExports,
  MIN_VALUE_EXPORTS,
  PACKAGE_NAME,
  readGoldenDocument,
  REGENERATE_COMMAND,
  toGoldenDocument,
} from '../scripts/value-surface.mjs';

/**
 * The review barrel's public RUNTIME (value) surface, pinned against the built barrel.
 *
 * `packages/core/spec/coreBarrelValueSurface.spec.ts` is the original of this pin and its docblock
 * carries the incident that produced the whole idea: one line of `src/index.ts` rewritten as
 * `export type *` silently dropped five runtime exports from core's built barrel while every
 * type-level cell stayed green, because declarations and emitted JavaScript are written by
 * different halves of the compiler into different files and **nothing that guards one guards the
 * other**.
 *
 * ## Why this package needs the pin
 *
 * This barrel is the least-watched path the package publishes and the most publicly-named one,
 * which is exactly the shape that produced the original incident.
 *
 * Measured: neither consumer repository names `@gaunt-sloth/review` at all, and nothing inside
 * this repository imports the bare barrel either — `dist/index.js` is one of the five modules that
 * no literal import specifier in any package's production `src/` names. Everything that reaches
 * this package's internals reaches them through `@gaunt-sloth/review/<path>.js` or `#src/…`, which
 * `tsc` re-proves, and past that barrel the compiler has nothing to say. The caller this protects
 * is an embedder, present or future, taking `@gaunt-sloth/review` as its documented entry point.
 *
 * Most of the surface arrives through one line — `export * from '@gaunt-sloth/core/config.js'` —
 * which is the specific line the original incident was a rewrite of.
 *
 * ## What is NOT re-tested here, deliberately
 *
 * The drift reporter, the kind classifier and the degeneracy guard are **shared code** — one
 * implementation in `packages/core/scripts/surface/barrel-value-surface.mjs`, bound to this
 * package by `scripts/value-surface.mjs`. Their behaviour is exercised by core's spec, cell for
 * cell, and repeating those tables here would pin the same functions twice.
 *
 * `reviewDeepSubpathValueSurface.spec.ts` is the companion to this file: it pins the source
 * modules reached by a computed specifier, and accounts for every other module the `"./*.js"`
 * wildcard publishes.
 *
 * It needs `dist/` to exist. `pnpm test` builds first — including both CI unit jobs — and a bare
 * `pnpm run unit` on a never-built tree fails here with a message naming the missing artifact.
 */

describe('@gaunt-sloth/review root barrel runtime surface', () => {
  it('matches the committed golden, name for name and kind for kind', async () => {
    // The primary guard. `describeValueSurfaceDrift` is what turns the situations an equality
    // failure conflates — an export vanished, an export added, a name still here but bound to a
    // different kind — into different sentences with different advice.
    const derived = toGoldenDocument(await deriveValueSurface());
    const committed = readGoldenDocument();

    const drift = describeValueSurfaceDrift(committed, derived);
    expect(
      drift,
      `the committed golden ${GOLDEN_PATH} no longer describes the review barrel's runtime surface`
    ).toBeNull();

    expect(
      committed,
      `${GOLDEN_PATH} is not what the generator writes: ${REGENERATE_COMMAND}`
    ).toEqual(derived);
  });

  it('reaches the barrel by resolving the package name through its own exports map', async () => {
    // Resolution by SELF-REFERENCE through the `exports` map: how an installed embedder reaches
    // this package, and the one thing that reds nothing else in this repository, where every
    // module is also reachable by its own relative path and where Vitest's resolver rewrites
    // `@gaunt-sloth/…` onto `src`. A narrowed or broken `exports` map fails here and nowhere else.
    //
    // Compared through `path.relative`, never by string prefix: a prefix test on paths that
    // disagree about separators is the exact shape of the recurring win32-only false red.
    const { entry } = await deriveValueSurface();
    expect(
      path.relative(DIST_DIR, entry),
      `${PACKAGE_NAME} did not resolve to the built barrel: ${entry}`
    ).toBe('index.js');
  });

  it('exports, as runtime values, every name its own declarations export in a value position', async () => {
    // The cross-check whose expectation is written by a different emitter into a different file,
    // and the cell that directly sees `export *` rewritten as `export type *`: the declarations go
    // on exporting the names, the emitted JavaScript hands out nothing.
    //
    // The value-position form rather than core's class-only form: this barrel declares three
    // classes and ninety-seven values, so the narrower filter would leave ninety-four names
    // unchecked by the one oracle that does not come from the artifact under test.
    const declaredValues = listDeclaredExports(DIST_BARREL_TYPES)
      .filter((entry: { isValue: boolean }) => entry.isValue)
      .map((entry: { name: string }) => entry.name);
    expect(
      declaredValues.length,
      'the declarations export no values at all — the cross-check oracle has collapsed and this cell is asserting nothing'
    ).toBeGreaterThan(MIN_VALUE_EXPORTS);

    const { exports } = await deriveValueSurface();
    const runtime = new Set(exports.map((entry: { name: string }) => entry.name));

    const missing = declaredValues.filter((name: string) => !runtime.has(name));
    expect(
      missing,
      `these names are exported in a VALUE position by ${PACKAGE_NAME}'s declarations but are NOT runtime exports of its barrel, so an embedder's compiler accepts the import and the import fails at run time — the usual cause is an "export *" written as "export type *" in src/index.ts`
    ).toEqual([]);
  });

  it('refuses a degenerate derivation, at this package’s own floors', async () => {
    // The guard is shared code and core's spec exercises each shape it can reject. What is
    // review-specific, and what this cell is actually for, is that the floors are bound to THIS
    // surface: 40 against a barrel of 97, clear of the 18 exports of the largest module the probe
    // could resolve to by mistake, and four required kinds this barrel really carries rather than
    // core's list.
    const real = await deriveValueSurface();
    expect(
      real.exports.length,
      `the review barrel is below its own floor of ${MIN_VALUE_EXPORTS} — either the probe is broken or the floor is wrong for this package`
    ).toBeGreaterThanOrEqual(MIN_VALUE_EXPORTS);

    expect(() => assertNonDegenerate({ ...real, entry: '/elsewhere/index.js' })).toThrow(
      /outside .* the probe is not reading the built barrel/s
    );
    expect(() => assertNonDegenerate({ ...real, exports: real.exports.slice(0, 3) })).toThrow(
      /found only 3 runtime exports, below the floor/
    );

    // The failure a name-set check cannot see: a `kindOf` that answered "object" for everything
    // would write a self-consistent golden and compare clean forever. The kinds named here are the
    // ones this surface really has, which is what keeps the guard able to fire on it.
    const collapsed = real.exports.map((entry: { name: string; kind: string }) => ({
      ...entry,
      kind: 'object',
    }));
    expect(collapsed.length).toBeGreaterThanOrEqual(MIN_VALUE_EXPORTS);
    expect(() => assertNonDegenerate({ ...real, exports: collapsed })).toThrow(
      /classified no export as class, function, string/
    );
  });
});
