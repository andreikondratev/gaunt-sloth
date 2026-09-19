import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  assertNonDegenerate,
  deriveDeepSubpathSurface,
  describeDeepSurfaceDrift,
  DIST_DIR,
  GATED_ELSEWHERE,
  GOLDEN_PATH,
  listLiterallyImportedModules,
  listPublishedModules,
  listTypesOnlyDeclaredValues,
  listUnwatchedModules,
  MIN_SOURCE_EXPORTS,
  PACKAGE_NAME,
  readGoldenDocument,
  readSourceModules,
  REGENERATE_COMMAND,
  SOURCE_CONTRACT,
  SOURCE_TABLE_NAMES,
  SOURCE_TABLES_SUBPATH,
  toGoldenDocument,
  TYPES_ONLY_DECLARATIONS,
  TYPES_ONLY_SUBPATH,
} from '../scripts/deep-subpath-surface.mjs';
import { listDeclaredExports } from '../scripts/value-surface.mjs';

/**
 * The public RUNTIME (value) surface of the review package's GATED DEEP SUBPATHS — the paths a
 * caller reaches as `@gaunt-sloth/review/<something>.js` rather than through the root barrel.
 *
 * `reviewBarrelValueSurface.spec.ts` pins the root barrel and is this file's twin; read its
 * docblock for why a value surface needs a pin of its own at all.
 *
 * ## The gap this closes, and its actual size
 *
 * `exports` in this package is `{".": "./dist/index.js", "./*.js": "./dist/*.js"}`. The second
 * entry is a WILDCARD, so the set of published paths is not a list anyone wrote down — it is
 * whatever the build emits, 20 modules today, and it grows by one every time a source file is
 * added.
 *
 * Measured, most of them need no golden: **15 of the 20 are named by a LITERAL import specifier in
 * some package's production `src/`** — `#src/…`, a relative path, or `@gaunt-sloth/review/…` from
 * the app package. `tsc` resolves every one of those edges and re-proves the names taken across
 * them, on every build, on every cell of the matrix.
 *
 * **Five are not**: `index.js`, which keeps its own golden next door; `modules/types.js`, a
 * types-only module with no runtime surface at all (the cell below checks that premise rather than
 * assuming it); and three of the source modules.
 *
 * ## Why this gate pins seven source modules and not three
 *
 * The source modules are reached the way nothing else in this package is. Two call sites do the
 * same thing with the same two tables:
 *
 * - `packages/review/src/commands/commandUtils.ts` looks a file name up in `REQUIREMENTS_SOURCES`
 *   or `CONTENT_SOURCES` and builds the specifier by template into `#src/sources/`;
 * - `packages/app/src/commands/commandUtils.ts` keeps its own copy of both tables holding the
 *   PUBLISHED spellings and looks the whole specifier up.
 *
 * Both then destructure `get` from the result and call `get(config, id)`. A table lookup is not a
 * specifier, so no type checker follows either edge — and neither call site wraps the import or
 * the call in a `try`/`catch`, so the failure reaches the user as a thrown error rather than as a
 * silently missing feature.
 *
 * Four of the seven are nonetheless named by a literal specifier today, because
 * `packages/app/src/commands/prDiscovery.ts` imports the GitHub and Jira sources statically for
 * its own purposes. That import is nobody's coverage for the table lookup: an unrelated refactor
 * of `prDiscovery.ts` would move four modules out of the gate without anyone deciding to. The
 * evidence for gating is how a module is REACHED, and that is the same for all seven.
 *
 * ## The gated set is derived, and that decides which assertions are worth making
 *
 * `deriveGatedSubpaths` takes every module named in either table and every other published module
 * no literal specifier names. Nothing is written out, so a source added to a table, or a new
 * unwatched module, is gated the day it appears rather than the day someone remembers.
 *
 * That rules out the tempting assertions, because against a derived list they could not fail:
 * "every table entry is gated" and "every published module is accounted for" are both true by
 * construction. What the cells below assert instead can fail — that each derived subpath still
 * RESOLVES through the `exports` map, that it hands out the contract its caller invokes, that the
 * COMMITTED golden (not the derived list) already gates everything unwatched, that the one
 * excluded module really has no runtime surface, and that the literal-import scan the exclusion
 * rests on has not quietly started matching everything.
 *
 * ## The per-module floor is stood down here, on purpose
 *
 * Core's engine will refuse a gated module whose export count falls below a floor. Every module
 * this gate pins exports exactly one name, `get`, so a floor of one would fire on precisely the
 * loss the gate exists for and report it, out of the derivation itself, as "a broken probe, not a
 * small module" — failing every cell in this file with the one sentence that is false about it.
 * `MIN_SOURCE_EXPORTS` is therefore 0 and the contract cell below carries that load instead,
 * naming the module and the missing name. The degeneracy cell at the foot of this file exercises
 * the two shapes that remain live here rather than a floor that cannot fire.
 *
 * ## What this pin does NOT catch — stated because the temptation is to overstate it
 *
 * - **A loss regenerated away.** This makes it loud, not impossible.
 * - **A deliberate narrowing of `exports`.** Narrowing the wildcard would remove paths from the
 *   published set and from this golden's next regeneration alike. What it cannot be is silent —
 *   the drift report gives a vanished SUBPATH its own headline for that reason.
 * - **Behaviour behind an unchanged name and kind.** A source whose `get` still exists and returns
 *   the wrong content is every other spec's job.
 * - **The bin entry.** `cli.js` ships with this package and is not reachable through the `exports`
 *   map at all, so it is outside what this file is about.
 *
 * It needs `dist/` to exist. `pnpm test` builds first — including both CI unit jobs — and a bare
 * `pnpm run unit` on a never-built tree fails here with a message naming the missing artifact. It
 * reads whatever `dist/` holds: on a tree built before an edit to `src/`, this checks the older
 * build, which is the first thing to rule out when it reports a loss.
 *
 * One local-only failure mode follows from that: `tsc` does not prune, so deleting a source file
 * leaves its `.js` behind in a warm `dist/`, and the completeness cell then reports a module
 * nobody can find a source for. CI never sees it — `dist/` is gitignored and every job builds from
 * a fresh checkout — so on a local red naming a module that no longer exists in `src/`, delete the
 * orphan and rebuild.
 */

describe('@gaunt-sloth/review gated deep-subpath runtime surface', () => {
  it('matches the committed golden, subpath for subpath and kind for kind', async () => {
    const derived = toGoldenDocument(await deriveDeepSubpathSurface());
    const committed = readGoldenDocument();

    const drift = describeDeepSurfaceDrift(committed, derived);
    expect(
      drift,
      `the committed golden ${GOLDEN_PATH} no longer describes the gated deep subpaths`
    ).toBeNull();

    // The drift report reads the subpath lists. This says the file as a whole is what the
    // generator writes, so a hand-edit anywhere in it — including to the recorded exclusions,
    // which are the decision this gate exists to keep honest — is a failure rather than a silent
    // divergence.
    expect(
      committed,
      `${GOLDEN_PATH} is not what the generator writes: ${REGENERATE_COMMAND}`
    ).toEqual(derived);
  });

  it('reaches every gated subpath by resolving it through the package exports map', async () => {
    // Resolution by SELF-REFERENCE through the `exports` map: how an installed consumer and the
    // table-driven dynamic import both reach these modules, and the one thing that reds nothing
    // else in this repository, where every module is also reachable by its own relative path and
    // where Vitest's resolver rewrites `@gaunt-sloth/…` onto `src`.
    //
    // Compared through `path.relative`, never by string prefix: a prefix test on paths that
    // disagree about separators is the exact shape of the recurring win32-only false red.
    const { subpaths } = await deriveDeepSubpathSurface();
    expect(subpaths.length).toBeGreaterThan(0);

    for (const entry of subpaths) {
      expect(
        path.relative(DIST_DIR, entry.entry),
        `${PACKAGE_NAME}/${entry.subpath} did not resolve to the matching built module: ${entry.entry}`
      ).toBe(path.join(...entry.subpath.split('/')));
    }
  });

  it('hands out, from every source module, the contract the table-driven import calls', async () => {
    // The cell whose expectation does not come from the artifact under test. SOURCE_CONTRACT is
    // read off the CALL SITES — both `getFromSource` implementations destructure `get` from
    // whatever the table's specifier loads and call `get(config, id)` — and those call sites are
    // invisible to a type checker because the specifier is a table lookup. This is what fires, by
    // name, when a source module loses `get`, and it is what the stood-down floor would otherwise
    // have swallowed.
    const sourceModules = await readSourceModules();
    // Without this the loop below would pass vacuously if either table ever came back empty.
    expect(
      sourceModules.length,
      `${SOURCE_TABLE_NAMES.join(' / ')} in ${SOURCE_TABLES_SUBPATH} are empty — the source list this gate derives from has collapsed and this cell is asserting nothing`
    ).toBeGreaterThan(0);

    const { subpaths } = await deriveDeepSubpathSurface();
    const bySubpath = new Map(subpaths.map((entry: { subpath: string }) => [entry.subpath, entry]));

    const missing: string[] = [];
    const notFunctions: string[] = [];
    for (const subpath of sourceModules) {
      const entry = bySubpath.get(subpath);
      if (!entry) {
        missing.push(`${subpath} (not gated at all)`);
        continue;
      }
      const kinds = new Map(
        entry.exports.map((e: { name: string; kind: string }) => [e.name, e.kind])
      );
      for (const name of SOURCE_CONTRACT) {
        if (!kinds.has(name)) missing.push(`${subpath}: ${name}`);
        else if (kinds.get(name) !== 'function') {
          notFunctions.push(`${subpath}: ${name} (${kinds.get(name)})`);
        }
      }
    }

    expect(
      missing,
      `these modules are named in ${SOURCE_TABLE_NAMES.join(' or ')} and loaded by a table-driven dynamic import, but no longer export what that import calls on them — ${SOURCE_CONTRACT.join(' / ')}. Nothing else in this repository reds for this: no type checker can follow a table lookup, and the first thing that notices is a user whose --content-source or --requirements-source throws`
    ).toEqual([]);
    expect(
      notFunctions,
      'these source contract names still exist but are no longer callable'
    ).toEqual([]);
  });

  it('leaves no published module that neither a type checker nor this golden watches', () => {
    // The completeness half, and the one that answers the node directly. It is compared against
    // the COMMITTED file rather than against the derived list, which is what lets it fail: the
    // derivation gates every unwatched module by construction, so deriving both sides would assert
    // nothing. Against the committed golden, a new module that no literal specifier names and that
    // nobody has regenerated the golden for is reported here, by name.
    const unwatched = listUnwatchedModules();
    const committed = readGoldenDocument();
    const gatedInCommitted = new Set(
      committed.subpaths.map((entry: { subpath: string }) => entry.subpath)
    );

    const escaped = unwatched.filter((module: string) => !gatedInCommitted.has(module));
    expect(
      escaped,
      `these modules are published by the "./*.js" wildcard in package.json exports, are named by no literal import specifier in any package's production src/ — so no build here re-proves anything about them — and are not in the committed golden either. Nothing watches them at all. Gate them by regenerating (${REGENERATE_COMMAND}), or delete them if they are dead`
    ).toEqual([]);
  });

  it('excludes a types-only module whose emitted declarations really do publish no value', () => {
    // The checked premise behind the one exclusion this gate makes on its own account.
    // `modules/types.js` is excluded because it has no runtime surface to break — and an exclusion
    // whose premise nothing checks is exactly the silently-expiring exclusion this work exists to
    // eliminate. The day `src/modules/types.ts` grows a `const`, this cell reds and says to gate
    // it or stop exporting it.
    expect(
      GATED_ELSEWHERE.map((entry: { module: string }) => entry.module),
      'the exclusion list no longer names the types-only module, so this cell is checking a premise nothing relies on'
    ).toContain(TYPES_ONLY_SUBPATH);

    // The anti-vacuity half. The value filter below is empty both when the module publishes no
    // value and when the declarations were read from an empty or wrong file, and those are not the
    // same answer. A declaration file with no exports at all reads back as the empty list rather
    // than throwing, so the oracle has to be shown to be reading something.
    const declared = listDeclaredExports(TYPES_ONLY_DECLARATIONS);
    expect(
      declared.length,
      `${TYPES_ONLY_DECLARATIONS} declares nothing at all — the oracle is reading an empty file and the exclusion below is being confirmed by an absence of evidence`
    ).toBeGreaterThan(0);

    expect(
      listTypesOnlyDeclaredValues(),
      `${PACKAGE_NAME}/${TYPES_ONLY_SUBPATH} now publishes a runtime surface. It is excluded from every surface gate in this package on the sole ground that it publishes no value, and that is no longer true — so those names are reachable as ${PACKAGE_NAME}/${TYPES_ONLY_SUBPATH} with nothing watching them. Either gate them by regenerating (${REGENERATE_COMMAND}) or stop exporting them`
    ).toEqual([]);
  });

  it('measures the literal-import scan the exclusion rests on, rather than assuming it', () => {
    // The scan is what says 15 of the 20 published modules need no golden, so a scan that
    // over-matched would excuse every one of them and this whole file would shrink to nothing
    // while staying green. These are the ways it can be wrong, and each can fail.
    const published = listPublishedModules();
    const literal = listLiterallyImportedModules();
    const named = published.filter((module: string) => literal.has(module));

    // It found real edges: a floor rather than a pin.
    expect(
      named.length,
      'the literal-import scan found almost nothing — it has stopped matching, and every module would then be treated as unwatched'
    ).toBeGreaterThan(10);
    expect(
      literal.has('modules/reviewModule.js'),
      'the module src/index.ts re-exports and the app package imports by name'
    ).toBe(true);

    // And it does NOT answer "named" for everything, which is the direction that would silently
    // empty the gate: an over-matching scan moves modules OUT of it, which is the blind direction.
    expect(
      named.length,
      'the scan now names every published module, which is what an over-matching scan looks like from here — establish that every one of those edges is real before trusting it, because each one is a module this gate has stopped watching'
    ).toBeLessThan(published.length);
    expect(literal.has('a-module-that-does-not-exist.js')).toBe(false);
  });

  it('refuses a degenerate derivation, in the shapes that can occur here', async () => {
    // `deriveDeepSubpathSurface` has already run this on the real surface — reaching this line at
    // all is the positive half. The rest is the half that matters: a guard nothing ever fails is a
    // guard nobody can trust, so each degenerate shape is fed in by hand and must be named in the
    // throw.
    //
    // The engine's third shape, a module below its own export floor, is deliberately absent: this
    // package's floor is MIN_SOURCE_EXPORTS, and feeding a synthetic floor in would test the
    // engine rather than this package. Core's and agent's specs exercise that shape against floors
    // that are live for them. The docblock above says why it is 0 here and what took its place.
    const real = await deriveDeepSubpathSurface();
    expect(
      MIN_SOURCE_EXPORTS,
      'the per-module floor is no longer 0, so the shape this cell declines to exercise is live again and belongs back here'
    ).toBe(0);

    expect(() => assertNonDegenerate({ subpaths: [] })).toThrow(/gated no subpaths at all/);
    expect(() =>
      assertNonDegenerate({
        subpaths: real.subpaths.map((entry: object) => ({
          ...entry,
          entry: '/elsewhere/source.js',
        })),
      })
    ).toThrow(/outside .* the probe is not reading the built package/s);
  });
});
