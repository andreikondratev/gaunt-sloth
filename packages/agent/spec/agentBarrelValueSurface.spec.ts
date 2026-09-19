import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  assertNonDegenerate,
  CONSUMER_BARREL_NAMES,
  deriveDeclaredClasses,
  describeValueSurfaceDrift,
  deriveValueSurface,
  DIST_DIR,
  GOLDEN_PATH,
  MIN_VALUE_EXPORTS,
  PACKAGE_NAME,
  readGoldenDocument,
  REGENERATE_COMMAND,
  toGoldenDocument,
} from '../scripts/value-surface.mjs';

/**
 * The agent barrel's public RUNTIME (value) surface, pinned against the built barrel.
 *
 * `packages/core/spec/coreBarrelValueSurface.spec.ts` is the original of this pin and its docblock
 * carries the incident that produced the whole idea: one line of `src/index.ts` rewritten as
 * `export type *` silently dropped five runtime exports from core's built barrel — `HistoryStore`
 * among them — while every type-level cell stayed green, because declarations and emitted
 * JavaScript are written by different halves of the compiler into different files and **nothing
 * that guards one guards the other**.
 *
 * ## Why this package needs the pin at its own, and not by analogy
 *
 * Nothing about that failure mode was specific to core, and this barrel is the one with a real
 * external caller. `pukeko-robot-controller`'s `server/index.ts` does
 * `import { startAgUiServer } from '@gaunt-sloth/agent'` — a BARE barrel import from a repository
 * that builds against the published package at a pinned version. Almost nothing inside this
 * repository imports `@gaunt-sloth/agent` bare, so no build here type-checks that edge, and the
 * only people who would notice the name vanishing are the ones who cannot be told by a red build.
 *
 * That is also the answer to "does the deep-subpath golden subsume this one": it does not, and it
 * is the reverse of subsumption. `agentDeepSubpathValueSurface.spec.ts` pins the paths reachable
 * as `@gaunt-sloth/agent/<something>.js`; the bare barrel is a different published path with a
 * different, larger surface and a consumer of its own.
 *
 * ## What is NOT re-tested here, deliberately
 *
 * The drift reporter, the kind classifier and the degeneracy guard are **shared code** — one
 * implementation in `packages/core/scripts/surface/barrel-value-surface.mjs`, bound to this
 * package by `scripts/value-surface.mjs`. Their behaviour is exercised by core's spec, cell for
 * cell, and repeating those tables here would pin the same functions twice and churn both files on
 * every wording change. What is agent-specific is below: this package's own surface, its own
 * floors, and the name its consumer actually imports.
 *
 * It needs `dist/` to exist. `pnpm test` builds first — including both CI unit jobs — and a bare
 * `pnpm run unit` on a never-built tree fails here with a message naming the missing artifact.
 */

describe('@gaunt-sloth/agent root barrel runtime surface', () => {
  it('matches the committed golden, name for name and kind for kind', async () => {
    // The primary guard. `describeValueSurfaceDrift` is what turns the situations an equality
    // failure conflates — an export vanished, an export added, a name still here but bound to a
    // different kind — into different sentences with different advice.
    const derived = toGoldenDocument(await deriveValueSurface());
    const committed = readGoldenDocument();

    const drift = describeValueSurfaceDrift(committed, derived);
    expect(
      drift,
      `the committed golden ${GOLDEN_PATH} no longer describes the agent barrel's runtime surface`
    ).toBeNull();

    // The drift report reads the export list. This says the file as a whole is what the generator
    // writes, so a hand-edit anywhere in it is a failure rather than a silent divergence.
    expect(
      committed,
      `${GOLDEN_PATH} is not what the generator writes: ${REGENERATE_COMMAND}`
    ).toEqual(derived);
  });

  it('reaches the barrel by resolving the package name through its own exports map', async () => {
    // Resolution by SELF-REFERENCE through the `exports` map, which is the point twice over. It is
    // how an installed consumer reaches this package, and it is the one thing that reds nothing
    // else in this repository — where every module is also reachable by its own relative path, and
    // where Vitest's own resolver rewrites `@gaunt-sloth/…` onto `src`. A narrowed or broken
    // `exports` map fails here and nowhere else.
    //
    // Compared through `path.relative`, never by string prefix: the two sides are built by
    // different machinery and a prefix test on paths that disagree about separators is the exact
    // shape of the recurring win32-only false red.
    const { entry } = await deriveValueSurface();
    expect(
      path.relative(DIST_DIR, entry),
      `${PACKAGE_NAME} did not resolve to the built barrel: ${entry}`
    ).toBe('index.js');
  });

  it('still hands out every name the consumer repository imports off the bare barrel', async () => {
    // The cell whose expectation does not come from the artifact under test. CONSUMER_BARREL_NAMES
    // is read off `pukeko-robot-controller`'s own import statement, in a repository that builds
    // against the PUBLISHED package — so nothing in this repository re-proves this edge, and this
    // is the only thing that fires by name when one of these disappears.
    expect(
      CONSUMER_BARREL_NAMES.length,
      'the consumer-name list is empty and this cell is asserting nothing'
    ).toBeGreaterThan(0);

    const { exports } = await deriveValueSurface();
    const runtime = new Map(exports.map((entry) => [entry.name, entry.kind]));

    const missing = CONSUMER_BARREL_NAMES.filter((name: string) => !runtime.has(name));
    expect(
      missing,
      `pukeko-robot-controller imports these from "@gaunt-sloth/agent" directly and they are no longer runtime exports of the built barrel — that repository pins a published version, so nothing here rebuilds against it and nothing else in this repository reds for this`
    ).toEqual([]);

    const notCallable = CONSUMER_BARREL_NAMES.filter(
      (name: string) => runtime.get(name) !== 'function' && runtime.get(name) !== 'class'
    ).map((name: string) => `${name} (${runtime.get(name)})`);
    expect(
      notCallable,
      'these names the consumer imports still exist but are no longer callable or constructible'
    ).toEqual([]);
  });

  it('exports, as runtime values, every class its own declarations name', async () => {
    // The cross-check whose expectation is written by a different emitter into a different file. A
    // class is both a type and a value, so a name the declarations call a class MUST also be
    // importable as a runtime value. This is the cell that sees `export *` rewritten as
    // `export type *`: the declarations keep the class, the emitted JavaScript drops it.
    const declaredClasses = deriveDeclaredClasses();
    expect(
      declaredClasses.length,
      'the declarations name no classes at all — the cross-check oracle has collapsed and this cell is asserting nothing'
    ).toBeGreaterThan(0);

    const { exports } = await deriveValueSurface();
    const runtime = new Map(exports.map((entry) => [entry.name, entry.kind]));

    const missing = declaredClasses.filter((name: string) => !runtime.has(name));
    expect(
      missing,
      `these are classes in ${PACKAGE_NAME}'s declarations but are NOT runtime exports of its barrel, so an embedder can name the type and cannot construct it — the usual cause is an "export *" written as "export type *" in src/index.ts`
    ).toEqual([]);

    const demoted = declaredClasses
      .filter((name: string) => runtime.has(name))
      .filter((name: string) => runtime.get(name) !== 'class')
      .map((name: string) => `${name} (${runtime.get(name)})`);
    expect(
      demoted,
      'these are classes in the declarations but arrive at runtime as something else'
    ).toEqual([]);
  });

  it('refuses a degenerate derivation of THIS barrel, at this package’s own floors', async () => {
    // The guard is shared code and core's spec exercises each shape it can reject. What is
    // agent-specific, and what this cell is actually for, is that the floors are bound to THIS
    // surface: core's floor of 60 would refuse this healthy 24-export barrel outright, and reading
    // "this is a broken probe, not a small API" is what would send the next reader looking in the
    // wrong place entirely.
    const real = await deriveValueSurface();
    expect(
      real.exports.length,
      `the agent barrel is below its own floor of ${MIN_VALUE_EXPORTS} — either the probe is broken or the floor is wrong for this package`
    ).toBeGreaterThanOrEqual(MIN_VALUE_EXPORTS);

    expect(() => assertNonDegenerate({ ...real, entry: '/elsewhere/index.js' })).toThrow(
      /outside .* the probe is not reading the built barrel/s
    );
    expect(() => assertNonDegenerate({ ...real, exports: real.exports.slice(0, 3) })).toThrow(
      /found only 3 runtime exports, below the floor/
    );

    // The failure a name-set check cannot see: a `kindOf` that answered "object" for everything
    // would write a self-consistent golden and compare clean forever.
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
