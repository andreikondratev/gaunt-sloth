import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  assertNonDegenerate,
  CONFIG_SEAM_EXPORT,
  CONFIG_SEAM_KIND,
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
 * The TeamCity reporter barrel's public RUNTIME (value) surface, pinned against the built barrel.
 *
 * `packages/core/spec/coreBarrelValueSurface.spec.ts` is the original of this pin and its docblock
 * carries the incident that produced the whole idea: one line of `src/index.ts` rewritten as
 * `export type *` silently dropped five runtime exports from core's built barrel while every
 * type-level cell stayed green, because declarations and emitted JavaScript are written by
 * different halves of the compiler into different files and **nothing that guards one guards the
 * other**.
 *
 * ## Why this barrel is the load-bearing one in the plugin family
 *
 * This package is optional and separately installed. A user registers it by bare package name —
 * `reporters: { teamcity: "@gaunt-sloth/eval-reporter-teamcity" }` — and
 * `packages/app/src/commands/evalCommand.ts` resolves that STRING against the user's own project,
 * imports whatever comes back, and requires its `default` export to be an `EvalReporterFactory`.
 *
 * Every part of that path is invisible to a type checker. The specifier is config data, not a
 * literal; the resolution happens in the user's `node_modules`, not this workspace; and — measured
 * — no literal import specifier in any package's production `src/` names this package at all, so
 * no build here re-proves anything about it. `dist/index.js` is the one module the wildcard
 * publishes that nothing watched before this golden existed.
 *
 * The sibling `@gaunt-sloth/eval-reporter-junit` is the contrasting case and the reason to state
 * this narrowly: it is bundled, `evalCommand.ts` names its barrel in a literal specifier, and the
 * compiler follows that edge.
 *
 * ## What the existing reporter spec covers, and what it cannot
 *
 * `teamcityReporter.spec.ts` already asserts that the default export is the factory and drives a
 * working reporter with it, so a change that removes `export default` reds there too — this file
 * does not claim to be the only thing that sees it. What that cell cannot see is the BUILT
 * package: it imports `@gaunt-sloth/eval-reporter-teamcity/index.js` from a spec, and Vitest's
 * workspace resolver rewrites that specifier onto `src/index.ts`. It therefore tests the source.
 *
 * Everything here resolves by self-reference through the package's own `exports` map with Node's
 * resolution, so what it reads is the file an installed user gets. A broken `exports` map, a
 * `dist/` that no longer carries what `src/` says, or an `export` emitted as a type-only
 * declaration all land here and nowhere else.
 *
 * ## What is NOT re-tested here, deliberately
 *
 * The drift reporter, the kind classifier and the degeneracy guard are **shared code** — one
 * implementation in `packages/core/scripts/surface/barrel-value-surface.mjs`, bound to this
 * package by `scripts/value-surface.mjs`. Their behaviour is exercised by core's spec, cell for
 * cell, and repeating those tables here would pin the same functions twice.
 *
 * `teamcityPublishedSurface.spec.ts` is the companion to this file: it accounts for the other
 * module the `"./*.js"` wildcard publishes, and explains why this package has no deep-subpath
 * golden.
 *
 * It needs `dist/` to exist. `pnpm test` builds first — including both CI unit jobs — and a bare
 * `pnpm run unit` on a never-built tree fails here with a message naming the missing artifact.
 */

describe('@gaunt-sloth/eval-reporter-teamcity root barrel runtime surface', () => {
  it('matches the committed golden, name for name and kind for kind', async () => {
    // The primary guard. `describeValueSurfaceDrift` is what turns the situations an equality
    // failure conflates — an export vanished, an export added, a name still here but bound to a
    // different kind — into different sentences with different advice.
    const derived = toGoldenDocument(await deriveValueSurface());
    const committed = readGoldenDocument();

    const drift = describeValueSurfaceDrift(committed, derived);
    expect(
      drift,
      `the committed golden ${GOLDEN_PATH} no longer describes the TeamCity reporter barrel's runtime surface`
    ).toBeNull();

    expect(
      committed,
      `${GOLDEN_PATH} is not what the generator writes: ${REGENERATE_COMMAND}`
    ).toEqual(derived);
  });

  it('reaches the barrel by resolving the package name through its own exports map', async () => {
    // Resolution by SELF-REFERENCE through the `exports` map — the same resolution the config seam
    // performs in the user's project, and the one thing that reds nothing else in this repository,
    // where every module is also reachable by its own relative path and where Vitest's resolver
    // rewrites `@gaunt-sloth/…` onto `src`. On a two-module package this cell is also what the
    // export floor cannot be: the thing that says the probe read the barrel rather than the
    // implementation module next to it.
    //
    // Compared through `path.relative`, never by string prefix: a prefix test on paths that
    // disagree about separators is the exact shape of the recurring win32-only false red.
    const { entry } = await deriveValueSurface();
    expect(
      path.relative(DIST_DIR, entry),
      `${PACKAGE_NAME} did not resolve to the built barrel: ${entry}`
    ).toBe('index.js');
  });

  it('still satisfies the reporters config seam, which requires a callable default export', async () => {
    // The cell whose expectation does not come from the artifact under test. It is read off the
    // LOADER — evalCommand.ts throws `must export a default function (an EvalReporterFactory)`
    // unless `typeof mod.default === 'function'` — and that loader reaches this package by a
    // specifier built from the user's config, which no type checker follows.
    //
    // It is not a subset of the declarations cross-check below. That one says a declared value is
    // present at run time; this one says the value is still CALLABLE. A `default` rebound to a
    // configuration object would satisfy presence, be regenerated into the golden without argument
    // on a loss-free drift report, and leave every user of `reporters: { teamcity: … }` with a
    // harness error on their next upgrade.
    const { exports } = await deriveValueSurface();
    const seam = exports.find((entry: { name: string }) => entry.name === CONFIG_SEAM_EXPORT);

    expect(
      seam,
      `${PACKAGE_NAME} no longer has a ${CONFIG_SEAM_EXPORT} export on its built barrel. The reporters config seam registers this package by bare name and takes its factory from mod.default; without it, a config that names this package fails at run time with a harness error and nothing in this repository went red first`
    ).toBeDefined();
    expect(
      seam.kind,
      `${PACKAGE_NAME}'s ${CONFIG_SEAM_EXPORT} export is no longer a ${CONFIG_SEAM_KIND}. evalCommand.ts rejects a config reporter whose default export is not callable, so this is the same failure as losing it`
    ).toBe(CONFIG_SEAM_KIND);
  });

  it('exports, as runtime values, every name its own declarations export in a value position', async () => {
    // The cross-check whose expectation is written by a different emitter into a different file,
    // and the cell that directly sees `export` rewritten as `export type`: the declarations go on
    // exporting the name, the emitted JavaScript hands out nothing.
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
    // THIS surface. Core's 60 and batch's 40 would both refuse a completely healthy four-name
    // barrel while saying "this is a broken probe, not a small API" — the one sentence guaranteed
    // to send a reader looking in the wrong place.
    const real = await deriveValueSurface();
    expect(
      real.exports.length,
      `the TeamCity reporter barrel is below its own floor of ${MIN_VALUE_EXPORTS} — either the probe is broken or the floor is wrong for this package`
    ).toBeGreaterThanOrEqual(MIN_VALUE_EXPORTS);

    expect(() => assertNonDegenerate({ ...real, entry: '/elsewhere/index.js' })).toThrow(
      /outside .* the probe is not reading the built barrel/s
    );
    // Zero, not three: on a barrel this size any non-empty slice copied from a larger package's
    // spec is still at or above the floor, so the guard would never throw and this half of the
    // cell would assert nothing.
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
