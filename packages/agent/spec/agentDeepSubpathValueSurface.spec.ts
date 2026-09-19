import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  assertNonDegenerate,
  CONSUMER_SUBPATH,
  CONSUMER_SUBPATH_CONTRACT,
  deriveDeepSubpathSurface,
  describeDeepSurfaceDrift,
  DIST_DIR,
  GOLDEN_PATH,
  listLiterallyImportedModules,
  listPublishedModules,
  listUnwatchedModules,
  PACKAGE_NAME,
  readBuiltInToolModules,
  readGoldenDocument,
  REGENERATE_COMMAND,
  TOOL_CONTRACT,
  toGoldenDocument,
} from '../scripts/deep-subpath-surface.mjs';

/**
 * The public RUNTIME (value) surface of the agent package's GATED DEEP SUBPATHS — the paths a
 * caller reaches as `@gaunt-sloth/agent/<something>.js` rather than through the root barrel.
 *
 * `agentBarrelValueSurface.spec.ts` pins the root barrel and is this file's twin; read its
 * docblock for why a value surface needs a pin of its own at all.
 *
 * ## The gap this closes, and its actual size
 *
 * `exports` in this package is `{".": "./dist/index.js", "./*.js": "./dist/*.js"}`. The second
 * entry is a WILDCARD, so the set of published paths is not a list anyone wrote down — it is
 * whatever the build emits, 46 modules today, and it grows by one every time a source file is
 * added. Nobody decided to publish `agent/modules/acp/acpStdio.js`; it is published because it
 * exists.
 *
 * The obvious reading is that all 46 should be watched here. Measured, almost none of them need
 * to be, and the measurement is the reason this file is small rather than 46 entries long:
 *
 * **40 of the 46 are named by a LITERAL import specifier in some package's production `src/`** —
 * `#src/…`, a relative path, or `@gaunt-sloth/agent/…` from a sibling. `tsc` resolves every one of
 * those edges and re-proves the names taken across them, on every build, on every cell of the
 * matrix. Pinning those in a golden would duplicate a gate that already runs earlier and says more.
 *
 * **Six are not**, and they are the whole of the gap:
 *
 * - `index.js`, the root barrel, which keeps its own golden next door.
 * - **The five built-in tool modules.** No literal import specifier in any package's production
 *   `src/` names one. What production code does instead is look the path up in a TABLE:
 *   `packages/agent/src/builtInToolsConfig.ts` holds `AVAILABLE_BUILT_IN_TOOLS`, a map from tool
 *   name to `#src/tools/<name>Tool.js`, and `getBuiltInTools` does
 *   ``await import(AVAILABLE_BUILT_IN_TOOLS[toolName])`` and then calls `tool.get(config)`. The
 *   specifier is never written down as a literal at the import site, so no type checker follows
 *   the edge.
 *
 * **And this package's version of that hole is quieter than core's.** That `await import` sits
 * inside a `try/catch` whose catch only calls `displayWarning`. A tool module that stops
 * resolving, or stops exporting `get`, therefore does not crash anything: the tool silently
 * disappears from the agent's toolset and the user gets one warning line in a stream of output.
 * Core's provider equivalent at least throws. Nothing else in this repository reds for either.
 *
 * To those this file adds one more, on different evidence: **the consumer-repo subpath**
 * `middleware/frontendImageInjectionMiddleware.js`, the only `@gaunt-sloth/agent/…` deep path
 * either consumer repository names — `pukeko-robot-controller`'s own middleware takes
 * `imageBlockFor` from it, deliberately sharing the per-provider block table instead of keeping a
 * second copy that would drift. That repository builds against the PUBLISHED package at a pinned
 * version, so a literal import here is not on its behalf and does not re-prove the path still
 * resolves for it.
 *
 * ## The gated set is derived, and that decides which assertions are worth making
 *
 * `deriveGatedSubpaths` takes the consumer subpath, every module named in
 * `AVAILABLE_BUILT_IN_TOOLS`, and every other published module no literal specifier names. Nothing
 * is written out, so a new unwatched module is gated the day it appears rather than the day
 * someone remembers.
 *
 * That rules out the tempting assertions, because against a derived list they could not fail:
 * "every built-in tool is gated" and "every published module is accounted for" are both true by
 * construction. What the cells below assert instead can fail — that each derived subpath still
 * RESOLVES through the `exports` map, that it hands out the contract its caller invokes, that the
 * COMMITTED golden (not the derived list) already gates everything unwatched, and that the
 * literal-import scan the exclusion rests on has not quietly started matching everything.
 *
 * ## What this pin does NOT catch — stated because the temptation is to overstate it
 *
 * - **A loss regenerated away.** This makes it loud, not impossible.
 * - **A deliberate narrowing of `exports`.** Narrowing the wildcard would remove paths from the
 *   published set and from this golden's next regeneration alike. What it cannot be is silent —
 *   the drift report gives a vanished SUBPATH its own headline for that reason.
 * - **Behaviour behind an unchanged name and kind.** A tool whose `get` still exists and returns
 *   a broken tool is every other spec's job.
 * - **The bin entries.** `cli.js` and `cli-acp.js` ship with this package and are not reachable
 *   through the `exports` map at all, so they are outside what this file is about.
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

describe('@gaunt-sloth/agent gated deep-subpath runtime surface', () => {
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

  it('hands out, from every built-in tool module, the contract the table-driven import calls', async () => {
    // The cell whose expectation does not come from the artifact under test. TOOL_CONTRACT is read
    // off the CALL SITE — `getBuiltInTools` calls `tool.get(config)` on whatever the table's
    // specifier loads — and that call site is invisible to a type checker because the specifier is
    // a table lookup. This is what fires, by name, when a tool module loses `get`; without it the
    // loss is a `displayWarning` line and a tool the user silently no longer has.
    const toolModules = await readBuiltInToolModules();
    // Without this the loop below would pass vacuously if the table ever came back empty.
    expect(
      toolModules.length,
      'AVAILABLE_BUILT_IN_TOOLS is empty — the tool list this gate derives from has collapsed and this cell is asserting nothing'
    ).toBeGreaterThan(0);

    const { subpaths } = await deriveDeepSubpathSurface();
    const bySubpath = new Map(subpaths.map((entry: { subpath: string }) => [entry.subpath, entry]));

    const missing: string[] = [];
    const notFunctions: string[] = [];
    for (const subpath of toolModules) {
      const entry = bySubpath.get(subpath);
      if (!entry) {
        missing.push(`${subpath} (not gated at all)`);
        continue;
      }
      const kinds = new Map(
        entry.exports.map((e: { name: string; kind: string }) => [e.name, e.kind])
      );
      for (const name of TOOL_CONTRACT) {
        if (!kinds.has(name)) missing.push(`${subpath}: ${name}`);
        else if (kinds.get(name) !== 'function') {
          notFunctions.push(`${subpath}: ${name} (${kinds.get(name)})`);
        }
      }
    }

    expect(
      missing,
      `these modules are named in AVAILABLE_BUILT_IN_TOOLS and loaded by a table-driven dynamic import, but no longer export what that import calls on them — ${TOOL_CONTRACT.join(' / ')}. Nothing else in this repository reds for this: no type checker can follow a table lookup, and getBuiltInTools catches the failure and turns it into one displayWarning line while the tool vanishes from the agent's toolset`
    ).toEqual([]);
    expect(
      notFunctions,
      'these built-in tool contract names still exist but are no longer callable'
    ).toEqual([]);
  });

  it('still hands out, from the consumer-repo subpath, what that repository imports', async () => {
    // The second expectation that comes from outside this repository: read off
    // `pukeko-robot-controller`'s own import statement rather than off this build. That repo pins
    // a published version, so nothing here rebuilds against it.
    expect(
      CONSUMER_SUBPATH_CONTRACT.length,
      'the consumer contract is empty and this cell is asserting nothing'
    ).toBeGreaterThan(0);

    const { subpaths } = await deriveDeepSubpathSurface();
    const entry = subpaths.find(
      (candidate: { subpath: string }) => candidate.subpath === CONSUMER_SUBPATH
    );
    expect(entry, `${CONSUMER_SUBPATH} is no longer gated at all`).toBeDefined();

    const names = new Set(entry.exports.map((e: { name: string }) => e.name));
    const missing = CONSUMER_SUBPATH_CONTRACT.filter((name: string) => !names.has(name));
    expect(
      missing,
      `pukeko-robot-controller imports these from ${PACKAGE_NAME}/${CONSUMER_SUBPATH} and they are gone. That repository shares this module rather than keeping a second copy of the per-provider image-block table precisely so a fix lands once — which also means a rename here reaches it as a runtime failure on its next bump, with nothing in this repository having gone red`
    ).toEqual([]);
  });

  it('leaves no published module that neither a type checker nor this golden watches', async () => {
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

  it('measures the literal-import scan the exclusion rests on, rather than assuming it', async () => {
    // The scan is what says 40 of the 46 published modules need no golden, so a scan that
    // over-matched would excuse every one of them and this whole file would shrink to nothing
    // while staying green. These are the two ways it can be wrong, and both can fail.
    const published = listPublishedModules();
    const literal = listLiterallyImportedModules();
    const named = published.filter((module: string) => literal.has(module));

    // It found real edges: a floor rather than a pin.
    expect(
      named.length,
      'the literal-import scan found almost nothing — it has stopped matching, and every module would then be treated as unwatched'
    ).toBeGreaterThan(25);
    expect(
      literal.has('modules/apiAgUiModule.js'),
      'the module src/index.ts re-exports and cli.js loads'
    ).toBe(true);

    // And it does NOT answer "named" for everything, which is the direction that would silently
    // empty the gate. The built-in tool modules are the population that must stay outside it: they
    // are reached only from a table-driven dynamic import, and the specs that import them directly
    // are not scanned precisely because a spec is not coverage for a computed edge.
    const toolModules = await readBuiltInToolModules();
    const scannedTools = toolModules.filter((subpath: string) => literal.has(subpath));
    expect(
      scannedTools,
      'these built-in tool modules are now named by a literal specifier in production source — if that is real the gate should shrink, and if it is not the scan is over-matching'
    ).toEqual([]);
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
        subpaths: real.subpaths.map((entry: object) => ({
          ...entry,
          entry: '/elsewhere/tool.js',
        })),
      })
    ).toThrow(/outside .* the probe is not reading the built package/s);
    expect(() =>
      assertNonDegenerate({
        subpaths: real.subpaths.map((entry: { exports: unknown[] }) => ({
          ...entry,
          exports: [],
        })),
      })
    ).toThrow(/runtime exports on .*, below its floor/);
  });
});
