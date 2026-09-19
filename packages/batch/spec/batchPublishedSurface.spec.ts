import { describe, expect, it } from 'vitest';
import {
  BIN_SUBPATH,
  GATED_ELSEWHERE,
  listBinDeclaredExports,
  listLiterallyImportedModules,
  listPublishedModules,
  listUnwatchedModules,
  PACKAGE_NAME,
  REMEDY,
} from '../scripts/published-surface.mjs';

/**
 * Every module the batch package's `"./*.js"` wildcard publishes is accounted for — by a type
 * checker, by the barrel golden, or by a checked exclusion. Nothing escapes all three.
 *
 * `batchBarrelValueSurface.spec.ts` is the companion to this file and pins the barrel itself.
 *
 * ## Why this package has no deep-subpath golden, and why that is a result rather than a gap
 *
 * `exports` here is `{".": "./dist/index.js", "./*.js": "./dist/*.js"}` — the same wildcard core
 * and agent publish, so the published set is not a list anyone wrote down but whatever the build
 * emits, 33 modules today. Sorted by what already watches them:
 *
 * - **31 are named by a LITERAL import specifier in some package's production `src/`**, so `tsc`
 *   resolves that edge and re-proves the names taken across it on every build, on every cell of
 *   the matrix. That is an earlier and louder gate than a golden.
 * - **`index.js`** is the root barrel, pinned next door.
 * - **`bin.js`** is the `gth-batch` executable — see the cell below.
 *
 * That leaves **nothing for a deep-subpath gate to pin**, and core's shared engine refuses an
 * empty gated set outright: *"a gate over an empty list compares clean against its own golden
 * forever."* Building one anyway would have produced exactly the artifact this whole line of work
 * exists to prevent — a golden that is regenerated and never red.
 *
 * **This is the opposite of what was predicted**, and the prediction is worth recording because it
 * is the reason the enumeration came before the fix. Batch is the eval runtime, so much of its
 * surface was expected to be reachable only from eval configs and fixtures — which are not
 * production `src/` and re-prove nothing — which would have made a 30-module golden, or an
 * argument for narrowing `exports`, the right answer. Measured, it is neither: batch's modules are
 * ordinary internals that production source imports by name.
 *
 * ## So the property, not the list, is what is asserted here
 *
 * The completeness cell below is the one that survives a misclassification by the static scanner,
 * and it is stated as a direct property rather than re-derived and compared against itself. **The
 * day a module appears here that nothing watches, it reds and names it**, and the remedy it prints
 * is to give this package the deep-subpath golden core and agent already have — the engine knows
 * how to build one, and only this package's descriptor is missing.
 *
 * It needs `dist/` to exist. `pnpm test` builds first — including both CI unit jobs — and a bare
 * `pnpm run unit` on a never-built tree fails here with a message naming the missing artifact.
 *
 * One local-only failure mode follows from that: `tsc` does not prune, so deleting a source file
 * leaves its `.js` behind in a warm `dist/`, and the completeness cell then reports a module
 * nobody can find a source for. CI never sees it — `dist/` is gitignored and every job builds from
 * a fresh checkout — so on a local red naming a module that no longer exists in `src/`, delete the
 * orphan and rebuild.
 */

describe('@gaunt-sloth/batch published module surface', () => {
  it('leaves no published module that neither a type checker nor a golden nor a checked exclusion watches', () => {
    // The completeness half, and the cell that answers the node directly. `listUnwatchedModules`
    // subtracts what the literal-import scan found and what GATED_ELSEWHERE accounts for, so what
    // is left is by definition the population nothing watches. Asserting it is empty is the
    // property stated directly — not a list re-derived and compared to itself, which is how this
    // kind of cell ends up unable to fail.
    const escaped = listUnwatchedModules();
    expect(
      escaped,
      `these modules are published by the "./*.js" wildcard in ${PACKAGE_NAME}'s package.json exports, are named by no literal import specifier in any package's production src/ — so no build in this repository re-proves anything about them — and nothing else accounts for them either. Nothing watches them at all. ${REMEDY}`
    ).toEqual([]);
  });

  it('publishes a bin entry that really does export nothing, which is what makes excluding it safe', () => {
    // The checked premise behind the one exclusion this package makes. `bin.js` is excluded
    // because it has no runtime surface to break — and an exclusion whose premise nothing checks
    // is exactly the silently-expiring exclusion this work exists to eliminate.
    //
    // Read from the emitted DECLARATIONS, never by importing the module: `dist/bin.js` is a
    // shebang CLI with top-level side effects, so importing it runs `runBatchCli`, prints the
    // usage block and can exit the process — taking the test run with it. Measured directly.
    expect(
      GATED_ELSEWHERE.map((entry: { module: string }) => entry.module),
      'the exclusion list no longer names the bin entry, so this cell is checking a premise nothing relies on'
    ).toContain(BIN_SUBPATH);

    expect(
      listBinDeclaredExports(),
      `${PACKAGE_NAME}/${BIN_SUBPATH} now publishes a runtime surface. It is excluded from every surface gate in this package on the sole ground that it exports nothing, and that is no longer true — so those names are reachable as ${PACKAGE_NAME}/${BIN_SUBPATH} with nothing watching them. Either gate them or stop exporting them. ${REMEDY}`
    ).toEqual([]);
  });

  it('measures the literal-import scan the exclusion rests on, rather than assuming it', () => {
    // The scan is what says 31 of the 33 published modules need no golden, so a scan that
    // over-matched would excuse every one of them and the completeness cell above would pass by
    // checking nothing. These are the two ways it can be wrong, and both can fail.
    const published = listPublishedModules();
    const literal = listLiterallyImportedModules();
    const named = published.filter((module: string) => literal.has(module));

    // It found real edges: a floor rather than a pin.
    expect(
      named.length,
      'the literal-import scan found almost nothing — it has stopped matching, and every module would then be treated as unwatched'
    ).toBeGreaterThan(20);
    expect(literal.has('pipelineCli.js'), 'the module bin.ts delegates the whole run to').toBe(
      true
    );

    // And it does NOT answer "named" for everything, which is the direction that would silently
    // empty the gate. The bin entry is the population that must stay outside it: nothing imports
    // it, which is precisely why it needs an exclusion with a reason rather than a scan result.
    expect(
      literal.has(BIN_SUBPATH),
      'the bin entry is now named by a literal import specifier in production source — if that is real the exclusion should go, and if it is not the scan is over-matching'
    ).toBe(false);
    expect(literal.has('a-module-that-does-not-exist.js')).toBe(false);
  });
});
