import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  assertNonDegenerate,
  deriveDeepSubpathSurface,
  describeDeepSurfaceDrift,
  DIST_DIR,
  GOLDEN_PATH,
  listLiterallyImportedModules,
  listPublishedModules,
  listUnwatchedModules,
  PACKAGE_NAME,
  PROVIDER_CONTRACT,
  readAvailableDefaultConfigs,
  readGoldenDocument,
  REGENERATE_COMMAND,
  toGoldenDocument,
} from '../scripts/deep-subpath-surface.mjs';

/**
 * The public RUNTIME (value) surface of the core package's GATED DEEP SUBPATHS — the paths a
 * caller reaches as `@gaunt-sloth/core/<something>.js` rather than through the root barrel.
 *
 * `coreBarrelValueSurface.spec.ts` pins the root barrel and is this file's twin; read its docblock
 * for why a value surface needs a pin of its own at all, and for the incident that produced it —
 * one line of `src/index.ts` rewritten as `export type *`, five runtime exports silently gone,
 * every type-level cell green.
 *
 * ## The gap this closes, and its actual size
 *
 * `exports` in this package is `{".": "./dist/index.js", "./*.js": "./dist/*.js"}`. The second
 * entry is a WILDCARD, so the set of published paths is not a list anyone wrote down — it is
 * whatever the build emits, 128 modules today, and it grows by one every time a source file is
 * added. Nobody decided to publish `core/shell/raterHealth.js`; it is published because it exists.
 * The barrel golden watches one of those 128 paths.
 *
 * The obvious reading is that the other 127 should be watched here too. Measured, almost none of
 * them need to be, and the measurement is the reason this file is small rather than 128 entries
 * long:
 *
 * **116 of the 128 are named by a LITERAL import specifier in some package's production `src/`** —
 * `#src/…`, a relative path, or `@gaunt-sloth/core/…` from a sibling. `tsc` resolves every one of
 * those edges and re-proves the names taken across them, on every build, on every cell of the
 * matrix. An export that disappears from `utils/systemUtils.js` does not go quietly: it reds a
 * hundred import sites before anything is published. Pinning those in a golden would duplicate a
 * gate that already runs earlier and says more.
 *
 * **Twelve are not**, and they are the whole of the gap:
 *
 * - `index.js`, the root barrel. Almost nothing in this repository imports `@gaunt-sloth/core`
 *   bare, so nothing here type-checks it and the only callers who notice a loss are embedders.
 *   That is why it needed a golden first, and it keeps its own.
 * - **The eleven provider modules.** No literal import specifier in any package's production
 *   `src/` names one; what production code does instead is build the specifier at runtime.
 *   `packages/app/src/commands/configSetup.ts` runs
 *   ``await import(`@gaunt-sloth/core/providers/${configType}.js`)`` and calls `.init(...)`;
 *   `packages/core/src/config/loader.ts` runs ``await import(`#src/providers/${llmType}.js`)`` and
 *   calls `.processJsonConfig(...)`. Neither specifier is a literal, so no type checker follows
 *   either edge. The one spec that exercises the first call site,
 *   `packages/app/spec/configSetup.spec.ts`, mocks `@gaunt-sloth/core/providers/vertexai.js` away,
 *   so it asserts on a stub and stays green whatever the real module does. Measured: deleting
 *   `export` from `init` in `providers/openai.ts` leaves `pnpm run build` and every suite green
 *   while `gth init openai` crashes for every user.
 *
 * To those this file adds one more, on different evidence: **`config.js`**, the only
 * `@gaunt-sloth/core/…` deep path either consumer repository names —
 * `pukeko-robot-controller`'s `server/index.ts` takes `DEFAULT_CONFIG` and the `GthConfig` type
 * from it. Those repos build against the PUBLISHED package at a pinned version, so a literal
 * import here is not on their behalf and does not re-prove the path still resolves for them.
 *
 * ## The gated set is derived, and that decides which assertions are worth making
 *
 * `deriveGatedSubpaths` takes `config.js`, every `providers/<id>.js` in `availableDefaultConfigs`,
 * and every other published module no literal specifier names. Nothing is written out, so a new
 * unwatched module is gated the day it appears rather than the day someone remembers.
 *
 * That rules out the tempting assertions, because against a derived list they could not fail:
 * "every provider id is gated" and "every published module is accounted for" are both true by
 * construction. What the cells below assert instead can fail — that each derived subpath still
 * RESOLVES through the `exports` map, that it hands out the contract the call sites invoke, that
 * the COMMITTED golden (not the derived list) already gates everything unwatched, and that the
 * literal-import scan the exclusion rests on has not quietly started matching everything.
 *
 * ## What this pin does NOT catch — stated because the temptation is to overstate it
 *
 * - **A loss regenerated away.** As with the barrel golden: this makes it loud, not impossible.
 * - **A deliberate narrowing of `exports`.** Narrowing the wildcard would remove paths from the
 *   published set and from this golden's next regeneration alike. What it cannot be is silent —
 *   the drift report gives a vanished SUBPATH its own headline for that reason.
 * - **Behaviour behind an unchanged name and kind.** A provider whose `init` still exists and
 *   writes the wrong file is every other spec's job.
 * - **The other packages' wildcards.** `@gaunt-sloth/agent` publishes the same way, and the robot
 *   consumer imports `agent/middleware/frontendImageInjectionMiddleware.js` through it. This pins
 *   `@gaunt-sloth/core` only.
 *
 * It needs `dist/` to exist. `pnpm test` builds first — including both CI unit jobs — and a bare
 * `pnpm run unit` on a never-built tree fails here with a message naming the missing artifact. It
 * reads whatever `dist/` holds: on a tree built before an edit to `src/`, this checks the older
 * build, which is the first thing to rule out when it reports a loss.
 *
 * One local-only failure mode follows from that, and it is worth knowing before you investigate
 * the wrong thing: `tsc` does not prune, so deleting a source file leaves its `.js` behind in a
 * warm `dist/`, and the completeness cell then reports a module nobody can find a source for. CI
 * never sees it — `dist/` is gitignored and every job builds from a fresh checkout — so on a local
 * red naming a module that no longer exists in `src/`, delete the orphan and rebuild.
 */

describe('@gaunt-sloth/core gated deep-subpath runtime surface', () => {
  it('matches the committed golden, subpath for subpath and kind for kind', async () => {
    // The primary guard. `describeDeepSurfaceDrift` is what turns the situations an equality
    // failure conflates — a subpath that stopped resolving, an export vanished, an export added, a
    // name still here but a different kind — into different sentences with different advice.
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
    // Resolution by SELF-REFERENCE through the package `exports` map, which is the point twice
    // over. It is how an installed consumer and the computed specifier in configSetup.ts both
    // reach these modules, and it is the one thing that reds nothing else in this repository —
    // where every module is also reachable by its own relative path, and where Vitest's own
    // resolver rewrites `@gaunt-sloth/…` onto `src`. A narrowed or broken `exports` map fails
    // here and nowhere else.
    //
    // Compared through `path.relative`, never by string prefix: the two sides are built by
    // different machinery and a prefix test on paths that disagree about separators is the exact
    // shape of the recurring win32-only false red.
    const { subpaths } = await deriveDeepSubpathSurface();
    expect(subpaths.length).toBeGreaterThan(0);

    for (const entry of subpaths) {
      expect(
        path.relative(DIST_DIR, entry.entry),
        `${PACKAGE_NAME}/${entry.subpath} did not resolve to the matching built module: ${entry.entry}`
      ).toBe(path.join(...entry.subpath.split('/')));
    }
  });

  it('hands out, from every provider module, the contract the computed specifiers call', async () => {
    // The cell whose expectation does not come from the artifact under test. PROVIDER_CONTRACT is
    // read off the two CALL SITES — `configSetup.ts` calls `init(...)`, `loader.ts` calls
    // `processJsonConfig(...)` — and neither call site is visible to a type checker, because
    // neither specifier is a literal. This is what fires, by name, when a provider module loses
    // one of them.
    const ids = await readAvailableDefaultConfigs();
    // Without this the loop below would pass vacuously if the id list ever came back empty.
    expect(
      ids.length,
      'availableDefaultConfigs is empty — the provider list this gate derives from has collapsed and this cell is asserting nothing'
    ).toBeGreaterThan(0);

    const { subpaths } = await deriveDeepSubpathSurface();
    const bySubpath = new Map(subpaths.map((entry) => [entry.subpath, entry]));

    const missing: string[] = [];
    const notFunctions: string[] = [];
    for (const id of ids) {
      const subpath = `providers/${id}.js`;
      const entry = bySubpath.get(subpath);
      if (!entry) {
        missing.push(`${subpath} (not gated at all)`);
        continue;
      }
      const kinds = new Map(entry.exports.map((e) => [e.name, e.kind]));
      for (const name of PROVIDER_CONTRACT) {
        if (!kinds.has(name)) missing.push(`${subpath}: ${name}`);
        else if (kinds.get(name) !== 'function') {
          notFunctions.push(`${subpath}: ${name} (${kinds.get(name)})`);
        }
      }
    }

    expect(
      missing,
      `these provider modules are offered by "gth init <provider>" or reachable from an llm.type in a user config, but no longer export what the computed import calls on them — ${PROVIDER_CONTRACT.join(' / ')}. Nothing else in this repository reds for this, because no type checker can follow a computed specifier`
    ).toEqual([]);
    expect(
      notFunctions,
      'these provider contract names still exist but are no longer callable'
    ).toEqual([]);
  });

  it('leaves no published module that neither a type checker nor this golden watches', async () => {
    // The completeness half, and the one that answers the node directly. It is compared against
    // the COMMITTED file rather than against the derived list, which is what lets it fail: the
    // derivation gates every unwatched module by construction, so deriving both sides would
    // assert nothing. Against the committed golden, a new module that no literal specifier names
    // and that nobody has regenerated the golden for is reported here, by name, with the reason.
    const unwatched = listUnwatchedModules();
    const committed = readGoldenDocument();
    const gatedInCommitted = new Set(
      committed.subpaths.map((entry: { subpath: string }) => entry.subpath)
    );

    const escaped = unwatched.filter((module) => !gatedInCommitted.has(module));
    expect(
      escaped,
      `these modules are published by the "./*.js" wildcard in package.json exports, are named by no literal import specifier in any package's production src/ — so no build here re-proves anything about them — and are not in the committed golden either. Nothing watches them at all. Gate them by regenerating (${REGENERATE_COMMAND}), or delete them if they are dead`
    ).toEqual([]);
  });

  it('measures the literal-import scan the exclusion rests on, rather than assuming it', async () => {
    // The scan is what says 116 of the 128 published modules need no golden, so a scan that
    // over-matched would excuse every one of them and this whole file would shrink to nothing
    // while staying green. These are the two ways it can be wrong, and both can fail.
    const published = listPublishedModules();
    const literal = listLiterallyImportedModules();
    const named = published.filter((module) => literal.has(module));

    // It found real edges: a floor rather than a pin, in the spirit of the barrel probe's.
    expect(
      named.length,
      'the literal-import scan found almost nothing — it has stopped matching, and every module would then be treated as unwatched'
    ).toBeGreaterThan(60);
    expect(literal.has('utils/systemUtils.js'), 'the most-imported module in the package').toBe(
      true
    );

    // And it does NOT answer "named" for everything, which is the direction that would silently
    // empty the gate. The provider factories are the population that must stay outside it: they
    // are reached only from a computed specifier, and the specs that import them are not scanned
    // precisely because a mocked spec is not coverage.
    const ids = await readAvailableDefaultConfigs();
    const scannedProviders = ids.filter((id) => literal.has(`providers/${id}.js`));
    expect(
      scannedProviders.length,
      'every provider factory is now named by a literal specifier in production source — if that is real the gate should shrink, and if it is not the scan is over-matching'
    ).toBeLessThan(ids.length);
    expect(literal.has('a-module-that-does-not-exist.js')).toBe(false);
  });

  it('refuses a degenerate derivation, and rejects each shape one can take', async () => {
    // `deriveDeepSubpathSurface` has already run this on the real surface — reaching this line at
    // all is the positive half. The rest is the half that matters: a guard nothing ever fails is a
    // guard nobody can trust, so each degenerate shape is fed in by hand and must be named in the
    // throw.
    const real = await deriveDeepSubpathSurface();

    expect(() => assertNonDegenerate({ subpaths: [] })).toThrow(/gated no subpaths at all/);
    expect(() =>
      assertNonDegenerate({
        subpaths: real.subpaths.map((entry) => ({ ...entry, entry: '/elsewhere/config.js' })),
      })
    ).toThrow(/outside .* the probe is not reading the built package/s);
    expect(() =>
      assertNonDegenerate({
        subpaths: real.subpaths.map((entry) => ({ ...entry, exports: entry.exports.slice(0, 1) })),
      })
    ).toThrow(/runtime exports on .*, below its floor/);
  });

  it('reports a vanished subpath, a loss, a kind change and an addition as different events', () => {
    const document = (
      subpaths: { subpath: string; reason: string; exports: { name: string; kind: string }[] }[]
    ) => ({
      $comment: 'irrelevant to the comparison',
      $reasons: {},
      $gatedElsewhere: [],
      $excluded: [],
      subpaths,
    });
    const base = document([
      {
        subpath: 'config.js',
        reason: 'consumer-repo',
        exports: [{ name: 'DEFAULT_CONFIG', kind: 'object' }],
      },
      {
        subpath: 'providers/openai.js',
        reason: 'computed-specifier',
        exports: [
          { name: 'init', kind: 'function' },
          { name: 'processJsonConfig', kind: 'function' },
        ],
      },
    ]);

    expect(describeDeepSurfaceDrift(base, base)).toBeNull();

    const subpathGone = describeDeepSurfaceDrift(base, document([base.subpaths[0]]));
    expect(subpathGone).toContain('gated deep SUBPATH is no longer part of the gated set');
    expect(subpathGone).toContain('SUBPATHS NO LONGER GATED (1): providers/openai.js');
    expect(subpathGone).not.toContain('LOST exports');

    const lost = describeDeepSurfaceDrift(
      base,
      document([
        base.subpaths[0],
        {
          ...base.subpaths[1],
          exports: [{ name: 'processJsonConfig', kind: 'function' }],
        },
      ])
    );
    expect(lost).toContain('LOST exports');
    expect(lost).toContain(
      'GONE from the runtime surface (1): providers/openai.js: init (function)'
    );
    // The reason this file exists has to be named where the reader is, or they will spend the
    // investigation looking for the type error that does not exist.
    expect(lost).toContain('computed specifier');
    expect(lost).not.toContain('SUBPATHS NO LONGER GATED');

    const rebound = describeDeepSurfaceDrift(
      base,
      document([
        base.subpaths[0],
        {
          ...base.subpaths[1],
          exports: [
            { name: 'init', kind: 'string' },
            { name: 'processJsonConfig', kind: 'function' },
          ],
        },
      ])
    );
    expect(rebound).toContain('BOUND one or more to a different KIND');
    expect(rebound).toContain('KIND CHANGED (1): providers/openai.js: init: function -> string');
    expect(rebound).not.toContain('LOST exports');

    const added = describeDeepSurfaceDrift(
      base,
      document([
        base.subpaths[0],
        {
          ...base.subpaths[1],
          exports: [...base.subpaths[1].exports, { name: 'brandNew', kind: 'function' }],
        },
      ])
    );
    expect(added).toContain('nothing was lost');
    expect(added).toContain(
      'ADDED to the runtime surface (1): providers/openai.js: brandNew (function)'
    );

    const newSubpath = describeDeepSurfaceDrift(
      base,
      document([
        ...base.subpaths,
        {
          subpath: 'providers/newvendor.js',
          reason: 'computed-specifier',
          exports: [{ name: 'init', kind: 'function' }],
        },
      ])
    );
    expect(newSubpath).toContain('nothing was lost');
    expect(newSubpath).toContain('SUBPATHS NEWLY GATED (1): providers/newvendor.js');

    // A loss arriving alongside an addition must still lead with the loss: the careful branch is
    // the one that has to win, or a reader regenerates and blesses the removal. A vanished subpath
    // outranks both.
    const everything = describeDeepSurfaceDrift(
      base,
      document([
        {
          ...base.subpaths[0],
          exports: [{ name: 'brandNew', kind: 'function' }],
        },
      ])
    );
    expect(everything).toContain('gated deep SUBPATH is no longer part of the gated set');
    expect(everything).toContain('SUBPATHS NO LONGER GATED (1): providers/openai.js');
    expect(everything).toContain('GONE from the runtime surface (1): config.js: DEFAULT_CONFIG');
    expect(everything).toContain('ADDED to the runtime surface (1): config.js: brandNew');
  });
});
