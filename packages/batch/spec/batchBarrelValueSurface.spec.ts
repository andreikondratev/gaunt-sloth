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
 * The batch barrel's public RUNTIME (value) surface, pinned against the built barrel.
 *
 * `packages/core/spec/coreBarrelValueSurface.spec.ts` is the original of this pin and its docblock
 * carries the incident that produced the whole idea: one line of `src/index.ts` rewritten as
 * `export type *` silently dropped five runtime exports from core's built barrel while every
 * type-level cell stayed green, because declarations and emitted JavaScript are written by
 * different halves of the compiler into different files and **nothing that guards one guards the
 * other**.
 *
 * ## Why this package needs the pin, given it has no external consumer
 *
 * Neither consumer repository names `@gaunt-sloth/batch` at all — measured, not assumed. That
 * makes the argument for this pin different from the agent package's, and weaker in one specific
 * way and stronger in another.
 *
 * Weaker: there is no repository outside this one whose build would be the thing that breaks. The
 * package is published to npm and its barrel is its documented entry point, so the caller this
 * protects is a future embedder rather than a present one.
 *
 * Stronger: **almost nothing inside this repository imports the bare barrel either.** Production
 * source reaches batch's internals through `#src/…` and `@gaunt-sloth/batch/<path>.js`, which is
 * why 31 of the 33 published modules are re-proved by `tsc` on every build — and why the barrel,
 * the one path an embedder actually writes, is in the 2 that are not. It is the least-watched path
 * in the package and the most publicly-named one, which is exactly the shape that produced the
 * original incident.
 *
 * ## What is NOT re-tested here, deliberately
 *
 * The drift reporter, the kind classifier and the degeneracy guard are **shared code** — one
 * implementation in `packages/core/scripts/surface/barrel-value-surface.mjs`, bound to this
 * package by `scripts/value-surface.mjs`. Their behaviour is exercised by core's spec, cell for
 * cell, and repeating those tables here would pin the same functions twice.
 *
 * `batchPublishedSurface.spec.ts` is the companion to this file: it accounts for the modules the
 * `"./*.js"` wildcard publishes that this barrel does not reach, and explains why this package has
 * no deep-subpath golden.
 *
 * It needs `dist/` to exist. `pnpm test` builds first — including both CI unit jobs — and a bare
 * `pnpm run unit` on a never-built tree fails here with a message naming the missing artifact.
 */

describe('@gaunt-sloth/batch root barrel runtime surface', () => {
  it('matches the committed golden, name for name and kind for kind', async () => {
    // The primary guard. `describeValueSurfaceDrift` is what turns the situations an equality
    // failure conflates — an export vanished, an export added, a name still here but bound to a
    // different kind — into different sentences with different advice.
    const derived = toGoldenDocument(await deriveValueSurface());
    const committed = readGoldenDocument();

    const drift = describeValueSurfaceDrift(committed, derived);
    expect(
      drift,
      `the committed golden ${GOLDEN_PATH} no longer describes the batch barrel's runtime surface`
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
    // Core's spec spells this cross-check as "every class in the declarations is a runtime value".
    // That form would assert NOTHING here — measured, this barrel declares no class at all, so the
    // filtered list would be empty and the loop would pass over it. The value-position form is the
    // same oracle widened to a population this surface actually has.
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
    // batch-specific, and what this cell is actually for, is that the floors are bound to THIS
    // surface. Two of them would be wrong if inherited from core, and both would fail in the
    // reassuring direction of looking like a real defect:
    //   - core's floor is 60 and this barrel exports 59, one short;
    //   - core's required kinds include `class`, and this barrel exports none.
    const real = await deriveValueSurface();
    expect(
      real.exports.length,
      `the batch barrel is below its own floor of ${MIN_VALUE_EXPORTS} — either the probe is broken or the floor is wrong for this package`
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
      /classified no export as function, number, string/
    );
  });
});
