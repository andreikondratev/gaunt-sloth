import { describe, expect, it } from 'vitest';
import {
  GATED_ELSEWHERE,
  listLiterallyImportedModules,
  listPublishedModules,
  listUnwatchedModules,
  PACKAGE_NAME,
  REMEDY,
  REPORTER_SUBPATH,
} from '../scripts/published-surface.mjs';

/**
 * Every module the JUnit reporter package's `"./*.js"` wildcard publishes is accounted for — by a
 * type checker, by the barrel golden, or by a checked exclusion. Nothing escapes all three.
 *
 * `junitBarrelValueSurface.spec.ts` is the companion to this file and pins the barrel itself.
 *
 * ## Why this package has no deep-subpath golden, and why that is a result rather than a gap
 *
 * `exports` here is `{".": "./dist/index.js", "./*.js": "./dist/*.js"}` — the same wildcard core,
 * agent, batch and review publish, so the published set is not a list anyone wrote down but
 * whatever the build emits. It emits two modules:
 *
 * - **`index.js`**, the root barrel, pinned next door.
 * - **`junitReporter.js`**, named by a LITERAL import specifier in production source: `src/index.ts`
 *   re-exports it as `#src/junitReporter.js`, so `tsc` resolves that edge and re-proves the name
 *   taken across it on every build, on every cell of the matrix.
 *
 * That leaves **nothing for a deep-subpath gate to pin**, and core's shared engine refuses an
 * empty gated set outright: *"a gate over an empty list compares clean against its own golden
 * forever."* Building one anyway would have produced exactly the artifact this whole line of work
 * exists to prevent — a golden that is regenerated and never red.
 *
 * ## So the property, not the list, is what is asserted here
 *
 * The completeness cell below is the one that survives a misclassification by the static scanner,
 * and it is stated as a direct property rather than re-derived and compared against itself. **The
 * day a module appears here that nothing watches, it reds and names it** — which for a package
 * this small is the realistic failure: one new file under `src/` that the barrel does not
 * re-export is published by the wildcard the moment it is built, and nothing else in this
 * repository would say so.
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

describe('@gaunt-sloth/eval-reporter-junit published module surface', () => {
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

  it('measures the literal-import scan the empty gate rests on, rather than assuming it', () => {
    // The whole case for having no deep-subpath golden is one scan result: that `junitReporter.js`
    // is named by a literal specifier. If the scan stopped matching, that module would be
    // unwatched and the cell above would red — so this one states the positive claim directly, by
    // name, rather than leaving it implicit in an empty list.
    const published = listPublishedModules();
    const literal = listLiterallyImportedModules();

    expect(
      published,
      'this package no longer publishes exactly the barrel and the reporter module, so the two-module reasoning in the docblock above is stale'
    ).toEqual(['index.js', REPORTER_SUBPATH]);

    expect(
      literal.has(REPORTER_SUBPATH),
      `${REPORTER_SUBPATH} is no longer named by a literal import specifier in production source. That is the single measurement this package's lack of a deep-subpath golden rests on: if the barrel now reaches it some other way, it needs gating; if the scan has stopped matching, every exclusion in this repository is weaker than it reads`
    ).toBe(true);

    // And it does NOT answer "named" for everything, which is the direction that would silently
    // excuse a module from every gate.
    expect(literal.has('a-module-that-does-not-exist.js')).toBe(false);
  });

  it('names the barrel in its exclusion list, so the completeness cell is not silently covering it', () => {
    // GATED_ELSEWHERE is what makes the barrel a recorded decision rather than an absence to be
    // inferred. Dropping the entry would not red the completeness cell today — the app package's
    // literal import already covers `index.js` — so without this the exclusion could quietly stop
    // meaning anything while everything stayed green.
    expect(
      GATED_ELSEWHERE.map((entry: { module: string }) => entry.module),
      'the exclusion list no longer names the barrel, so nothing in this package records that the barrel golden is what watches it'
    ).toContain('index.js');
  });
});
