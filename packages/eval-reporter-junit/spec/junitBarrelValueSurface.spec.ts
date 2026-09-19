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
 * The JUnit reporter barrel's public RUNTIME (value) surface, pinned against the built barrel.
 *
 * `packages/core/spec/coreBarrelValueSurface.spec.ts` is the original of this pin and its docblock
 * carries the incident that produced the whole idea: one line of `src/index.ts` rewritten as
 * `export type *` silently dropped five runtime exports from core's built barrel while every
 * type-level cell stayed green, because declarations and emitted JavaScript are written by
 * different halves of the compiler into different files and **nothing that guards one guards the
 * other**.
 *
 * ## What this pin adds here, stated narrowly because the honest answer is narrow
 *
 * This is the BUNDLED reporter, and its barrel is the one path in the plugin family that a type
 * checker already watches: `packages/app/src/commands/evalCommand.ts` registers it through the
 * public `custom` seam with a literal `await import('@gaunt-sloth/eval-reporter-junit/index.js')`
 * and destructures `createJUnitReporter` and `JUNIT_REPORTER_NAME` from it, so `tsc` follows the
 * edge and a name removed from the declarations fails the build. That is a louder gate than a
 * golden and this file does not pretend to replace it.
 *
 * What it adds is the two things that edge cannot see:
 *
 * - **The emitted JavaScript rather than the declarations.** `export` rewritten as `export type`
 *   keeps the declarations exporting the name — so the app's build stays green — while the runtime
 *   surface hands out nothing. The cell below that compares declared value-position exports
 *   against the runtime namespace is what sees exactly that.
 * - **Resolution through the published `exports` map**, by self-reference from this package's own
 *   manifest. Inside this repository every module is also reachable by its own path, and Vitest's
 *   resolver rewrites `@gaunt-sloth/…` onto `src`, so a narrowed or broken `exports` map reds
 *   nothing else here.
 *
 * `@gaunt-sloth/eval-reporter-teamcity`'s barrel is the contrasting case and carries the stronger
 * argument: nothing in production source names it, because it is reached only through a user's
 * `reporters` config by a specifier built at runtime.
 *
 * ## What is NOT re-tested here, deliberately
 *
 * The drift reporter, the kind classifier and the degeneracy guard are **shared code** — one
 * implementation in `packages/core/scripts/surface/barrel-value-surface.mjs`, bound to this
 * package by `scripts/value-surface.mjs`. Their behaviour is exercised by core's spec, cell for
 * cell, and repeating those tables here would pin the same functions twice.
 *
 * `junitPublishedSurface.spec.ts` is the companion to this file: it accounts for the other module
 * the `"./*.js"` wildcard publishes, and explains why this package has no deep-subpath golden.
 *
 * It needs `dist/` to exist. `pnpm test` builds first — including both CI unit jobs — and a bare
 * `pnpm run unit` on a never-built tree fails here with a message naming the missing artifact.
 */

describe('@gaunt-sloth/eval-reporter-junit root barrel runtime surface', () => {
  it('matches the committed golden, name for name and kind for kind', async () => {
    // The primary guard. `describeValueSurfaceDrift` is what turns the situations an equality
    // failure conflates — an export vanished, an export added, a name still here but bound to a
    // different kind — into different sentences with different advice.
    const derived = toGoldenDocument(await deriveValueSurface());
    const committed = readGoldenDocument();

    const drift = describeValueSurfaceDrift(committed, derived);
    expect(
      drift,
      `the committed golden ${GOLDEN_PATH} no longer describes the JUnit reporter barrel's runtime surface`
    ).toBeNull();

    expect(
      committed,
      `${GOLDEN_PATH} is not what the generator writes: ${REGENERATE_COMMAND}`
    ).toEqual(derived);
  });

  it('reaches the barrel by resolving the package name through its own exports map', async () => {
    // Resolution by SELF-REFERENCE through the `exports` map, and on a two-module package this
    // cell is also what the export floor cannot be: it is the thing that says the probe read the
    // barrel rather than the implementation module next to it. A narrowed or broken `exports` map
    // fails here and nowhere else.
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
    // and the cell that directly sees `export` rewritten as `export type`: the declarations go on
    // exporting the name, the emitted JavaScript hands out nothing. This is the half of the pin
    // the app package's literal import cannot stand in for.
    //
    // Core's spec spells this cross-check as "every class in the declarations is a runtime value".
    // That form would assert NOTHING here — this barrel declares no class at all, so the filtered
    // list would be empty and the loop would pass over it.
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
      `these names are exported in a VALUE position by ${PACKAGE_NAME}'s declarations but are NOT runtime exports of its barrel, so an embedder's compiler accepts the import and the import fails at run time — the usual cause is an "export" written as "export type" in src/index.ts`
    ).toEqual([]);
  });

  it('refuses a degenerate derivation, at this package’s own floor', async () => {
    // The guard is shared code and core's spec exercises each shape it can reject. What is
    // specific to this package, and what this cell is actually for, is that the floor is bound to
    // THIS surface. Core's 60 and batch's 40 would both refuse a completely healthy two-name
    // barrel while saying "this is a broken probe, not a small API" — the one sentence guaranteed
    // to send a reader looking in the wrong place.
    const real = await deriveValueSurface();
    expect(
      real.exports.length,
      `the JUnit reporter barrel is below its own floor of ${MIN_VALUE_EXPORTS} — either the probe is broken or the floor is wrong for this package`
    ).toBeGreaterThanOrEqual(MIN_VALUE_EXPORTS);

    expect(() => assertNonDegenerate({ ...real, entry: '/elsewhere/index.js' })).toThrow(
      /outside .* the probe is not reading the built barrel/s
    );
    // Zero, not three: on a barrel this size any non-empty slice is still at or above the floor,
    // so a slice copied from a larger package's spec would never make the guard throw and this
    // half of the cell would assert nothing.
    expect(() => assertNonDegenerate({ ...real, exports: [] })).toThrow(
      /found only 0 runtime exports, below the floor/
    );

    // The failure a name-set check cannot see: a `kindOf` that answered "object" for everything
    // would write a self-consistent golden and compare clean forever. The kinds named here are the
    // ones this surface really has, which is what keeps the guard able to fire on it — and the
    // length assertion is what stops the floor, rather than the kind check, being what throws.
    const collapsed = real.exports.map((entry: { name: string; kind: string }) => ({
      ...entry,
      kind: 'object',
    }));
    expect(collapsed.length).toBeGreaterThanOrEqual(MIN_VALUE_EXPORTS);
    expect(() => assertNonDegenerate({ ...real, exports: collapsed })).toThrow(
      /classified no export as function, string/
    );
  });
});
