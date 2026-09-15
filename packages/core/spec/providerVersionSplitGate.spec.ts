import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * OPS-121 — a provider must resolve to exactly ONE version across the workspace.
 *
 * `packages/core` declares the LLM providers as **optional peer dependencies**, while
 * `packages/app` depends on them directly. When core's floor sits below the app's range, a bump
 * that raises only the app leaves core's resolution untouched and pnpm resolves two versions of
 * the same provider. That is not merely an untidy tree: `vertexaiUtils.spec.ts` lives in
 * `packages/core`, so it ran against `@langchain/google@0.2.3 -> google-auth-library@10.9.1` while
 * the CLI shipped `0.2.6 -> 11.0.2`. **A green spec pinning behaviour on a library the product
 * does not ship** — the same shape as a stub standing in for the component under test.
 *
 * The floors were raised so the split is currently absent. This gate is what makes it *loud* the
 * next time a bump reintroduces it, because a one-off reading expires the moment someone runs
 * `pnpm update`.
 *
 * ## The instrument: the lockfile, not the store
 *
 * **Counting directories in `node_modules/.pnpm` reports splits that do not exist.** The store
 * keeps history — a directory for a version nothing resolves to any more survives there — and it
 * also holds one directory per *peer variant*, so at the time of writing it carries **two**
 * directories for every one of the eight providers while the lockfile resolves exactly one
 * version of each. A directory count would therefore have reported eight splits, none of them
 * real. `pnpm-lock.yaml` is the authority: it records resolutions, not leftovers, and it is what
 * CI's `--frozen-lockfile` install builds `node_modules` from on every matrix cell.
 *
 * ## What this gate CANNOT see — every gate of this shape has a blind spot, so here is ours
 *
 * 1. **A same-version split into two physical copies.** Keyed on `name@version`, so pnpm's
 *    peer-variant copies are invisible, and there are eight of them right now: the published
 *    `@gaunt-sloth/core` under the `@gaunt-sloth/batch` subtree (see below) resolves its own
 *    `zod@4.5.4`-flavoured copy of each provider. That is tolerated on a measurement, not a hunch:
 *    `pnpm-lock.yaml`'s `packages:` block holds exactly one `google-auth-library@11.0.2`, so both
 *    copies of `@langchain/google@0.2.6` reach the same auth library and the defect above — a spec
 *    asserting on code the CLI does not ship — is not reproduced. The second test narrows this:
 *    two *workspace* packages must still reach one physical copy, which is the variant that breaks
 *    `instanceof` across a package boundary.
 * 2. **Anything outside the eight names.** `@langchain/langgraph` sits at 1.4.13 *and* 1.4.15 in
 *    this tree today (so do `@langchain/langgraph-sdk` and `@langchain/protocol`). Widening this
 *    gate to every `@langchain/*` would red the tree on day one; if you want that, it is a separate
 *    piece of work with its own remedy, not a one-line "improvement" here.
 * 3. **What a downstream consumer of the published `@gaunt-sloth/core` resolves.** Raising an
 *    optional peer floor is a public contract change and the lockfile is silent about its effect
 *    on anybody else's tree.
 *
 * ## The `@gaunt-sloth/batch` subtree is deliberately IN scope
 *
 * `packages/eval-reporter-junit` and `packages/eval-reporter-teamcity` devDepend on
 * `@gaunt-sloth/batch` **from the registry**, which drags a published `@gaunt-sloth/core` carrying
 * whatever peer floors it shipped with — today `@langchain/google: ^0.2.0`, i.e. the pre-fix
 * floors. It is luck, not design, that `^0.2.0` currently resolves to the same `0.2.6` the
 * workspace uses: the next minor bump of a provider is a range that old floor cannot follow, and
 * the tree grows a second version by that route. A gate that skipped the subtree would stay silent
 * on exactly the bump it exists to catch, so the sweep below reads the whole lockfile.
 */

const REPO_ROOT = new URL('../../../', import.meta.url);
const LOCKFILE = new URL('pnpm-lock.yaml', REPO_ROOT);

/**
 * The providers `packages/core` declares as optional peers and `packages/app` depends on directly.
 *
 * **All eight, including `@langchain/groq` and `@langchain/ollama`, which have never split.** They
 * were aligned only because core's `^1.3.0` happened to admit the app's `1.3.1` — the identical
 * latent defect, not yet fired. Trimming this list to "the six that actually broke" would remove
 * the guard from two providers for no reason other than that their luck has held so far.
 *
 * Hardcoded on purpose, and the third test asserts it equals core's `@langchain/*` peers. Deriving
 * the list from core's manifest instead would be the tempting simplification and it is wrong: it
 * makes the gate's subject depend on the very thing being guarded, so trimming core's peers to six
 * would silently shrink the gate rather than fail it.
 */
const PROVIDERS = [
  '@langchain/anthropic',
  '@langchain/deepseek',
  '@langchain/google',
  '@langchain/groq',
  '@langchain/ollama',
  '@langchain/openai',
  '@langchain/openrouter',
  '@langchain/xai',
] as const;

/**
 * Every `name -> versions` pair in `pnpm-lock.yaml`'s top-level `packages:` block.
 *
 * Deliberately NOT a YAML parser, for the reason `pnpmOverridesGate.spec.ts` gives: it understands
 * the shapes this file actually uses and **throws on anything else** rather than skipping it. A
 * skipped entry reads as "this version is not in the tree", which is the exact direction a gate
 * against silent duplication must never fail in.
 *
 * Keys arrive both quoted (`'@langchain/google@0.2.6':`, for scoped names) and bare
 * (`accepts@2.0.0:`), so the name/version boundary is the **last** `@`, never the first — splitting
 * on the first would map every scoped package to the empty name and quietly find no provider at
 * all.
 */
export function packageVersionsInLockfile(lockText: string): Map<string, string[]> {
  const lines = lockText.split(/\r?\n/);
  const start = lines.indexOf('packages:');
  if (start === -1) {
    throw new Error(
      'providerVersionSplitGate: pnpm-lock.yaml has no top-level "packages:" block, so nothing ' +
        'could be counted. The lockfile format changed; teach this parser the new shape rather ' +
        'than letting the sweep pass on an empty set.'
    );
  }

  const found = new Map<string, string[]>();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    // A dedent to column 0 ends the block (the next top-level key, e.g. `snapshots:`).
    if (!line.startsWith(' ')) break;
    // Entry bodies are indented further; only the two-space keys name a resolved package.
    if (line.startsWith('   ')) continue;
    if (/^ {2}#/.test(line)) continue;

    const match = /^ {2}(?:'([^']+)'|([^'"#\s][^:]*)):[ \t]*$/.exec(line);
    if (match === null) {
      throw new Error(
        'providerVersionSplitGate: cannot parse an entry of the "packages:" block, so it cannot ' +
          'be counted. Teach packageVersionsInLockfile() this shape rather than letting it be ' +
          `skipped: ${JSON.stringify(line)}`
      );
    }
    const key = match[1] ?? match[2];
    const at = key.lastIndexOf('@');
    if (at <= 0) {
      throw new Error(
        'providerVersionSplitGate: a "packages:" key carries no name@version boundary, so its ' +
          `version cannot be read: ${JSON.stringify(key)}`
      );
    }
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    const versions = found.get(name);
    if (versions === undefined) found.set(name, [version]);
    else if (!versions.includes(version)) versions.push(version);
  }
  return found;
}

/** The workspace packages that carry their own copy of `provider`, as `<pkg> -> <physical copy>`. */
function workspaceCopiesOf(provider: string): Record<string, string> {
  const packagesDir = join(fileURLToPath(REPO_ROOT), 'packages');
  const copies: Record<string, string> = {};
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = join(packagesDir, entry.name, 'node_modules', provider);
    let resolved: string;
    try {
      resolved = realpathSync(target);
    } catch {
      // Not every workspace package depends on every provider; only five of seven declare any.
      continue;
    }
    copies[entry.name] = physicalCopyId(resolved);
  }
  return copies;
}

/**
 * The `.pnpm` snapshot directory a resolved path sits in — the thing that identifies one physical
 * copy — or the whole path when there is no such segment (a hoisted node-linker).
 *
 * Compared instead of the full real path on purpose. The two inputs are spelled differently before
 * `realpathSync` sees them (`packages/core/...` vs `packages/app/...`), and this repo's recurring
 * Windows failure is an exact-equality comparison of path strings; one segment carries all the
 * discriminating power with no sensitivity to drive-letter case, `\\?\` prefixes or junction
 * spelling.
 *
 * **Truncation does not blunt it.** pnpm replaces the tail of a long snapshot name with a hash of
 * the full peer set, and it already does so here: both `@langchain/openai` copies are truncated at
 * 120 characters and their hashes still differ. Windows truncates sooner, so more names arrive
 * hashed — which is the same mechanism, not a weaker one.
 *
 * The fallback matters in one layout only. Under `node-linker=hoisted` there is no `.pnpm` segment
 * and every package owns a real directory, so this would compare paths that legitimately differ.
 * This repo ships no `.npmrc` and pnpm defaults to the isolated linker, so that layout does not
 * occur; the failure message below names it anyway, because a gate whose red cannot be read is a
 * gate that gets deleted.
 */
export function physicalCopyId(realPath: string): string {
  const match = /[\\/]\.pnpm[\\/]([^\\/]+)/.exec(realPath);
  return match === null ? realPath : match[1];
}

describe('OPS-121 each LLM provider resolves to exactly one version across the workspace', () => {
  const versionsByName = packageVersionsInLockfile(readFileSync(LOCKFILE, 'utf8'));

  it('finds every one of the eight providers in the lockfile', () => {
    // Non-vacuity, and the assertion that actually catches a broken parser. Every check below is
    // "this name has one version", which an empty map satisfies perfectly — so a name/version
    // split that silently matched nothing would leave a gate that cannot fail.
    const missing = PROVIDERS.filter((provider) => !versionsByName.has(provider));
    expect(
      missing,
      'these providers were not found in pnpm-lock.yaml\'s "packages:" block at all, so the ' +
        'one-version checks below assert nothing about them. Either the parser stopped matching ' +
        'the lockfile format, or the provider was genuinely dropped — in which case remove it ' +
        'from PROVIDERS deliberately rather than leaving a check that cannot fail.'
    ).toEqual([]);
  });

  it.each(PROVIDERS)('%s resolves to one version', (provider) => {
    const versions = versionsByName.get(provider) ?? [];
    expect(
      versions,
      `${provider} resolves to more than one version in pnpm-lock.yaml. packages/core declares ` +
        'the providers as OPTIONAL PEERS and packages/app depends on them directly; when those ' +
        'two ranges drift, pnpm resolves one version for each and a spec in packages/core then ' +
        'pins behaviour against a copy the CLI does not ship. ' +
        'REMEDY: raise the peerDependencies floor in packages/core/package.json to match ' +
        'packages/app/package.json, then reinstall. ' +
        'BUT if the extra version is pulled by the PUBLISHED @gaunt-sloth/* subtree instead — ' +
        'the eval-reporter packages devDepend on @gaunt-sloth/batch from the registry, which ' +
        'drags a published @gaunt-sloth/core carrying the floors it shipped with — then raising ' +
        'the workspace floors cannot fix it: bump that pin to a published version whose core ' +
        'has the raised floors, or release core first. ' +
        `Run \`grep -n "${provider}@" pnpm-lock.yaml\` to see which route brought the second one.`
    ).toHaveLength(1);
  });

  it('gives the workspace packages that carry a provider the same physical copy', () => {
    // The lockfile sweep above is keyed on name@version, so it cannot see two physical copies of
    // ONE version. This half can, for the case that matters: two workspace packages holding
    // different copies of the same provider class, where an `instanceof` across the boundary
    // silently returns false. It reads the installed tree rather than the lockfile, which is also
    // the only thing here that would notice a node_modules that has drifted from pnpm-lock.yaml —
    // local-dev drift only, since every CI cell installs with --frozen-lockfile.
    const disagreements: string[] = [];
    let packagesWithACopy = 0;
    for (const provider of PROVIDERS) {
      const copies = workspaceCopiesOf(provider);
      packagesWithACopy += Object.keys(copies).length;
      const distinct = [...new Set(Object.values(copies))];
      if (distinct.length > 1) {
        disagreements.push(
          `${provider}: ${Object.entries(copies)
            .map(([pkg, id]) => `${pkg} -> ${id}`)
            .join(', ')}`
        );
      }
    }

    // Control: if no workspace package resolved any provider, the loop above compared nothing.
    expect(
      packagesWithACopy,
      'no workspace package resolved any provider through its own node_modules, so this check ' +
        'compared nothing. Run `pnpm install` before trusting it.'
    ).toBeGreaterThan(1);

    expect(
      disagreements,
      'two workspace packages resolve the same provider to different physical copies. Even at ' +
        'one version this breaks identity across the package boundary: a class from one copy is ' +
        'not `instanceof` the class from the other. Reinstall; if it survives that, the two ' +
        'packages are pulling different peer sets and the ranges need reconciling. ' +
        'If the copies below are full paths rather than .pnpm snapshot directories, this is ' +
        'instead a hoisted node-linker, where a copy per package is normal and this check does ' +
        'not apply as written — read it before treating it as a defect.'
    ).toEqual([]);
  });

  it('carries a guard for every provider packages/core declares as a peer', () => {
    const corePkg = JSON.parse(
      readFileSync(new URL('packages/core/package.json', REPO_ROOT), 'utf8')
    ) as { peerDependencies?: Record<string, string> };
    const declared = Object.keys(corePkg.peerDependencies ?? {})
      .filter((name) => name.startsWith('@langchain/'))
      .sort();

    expect(
      declared,
      'the providers packages/core declares as optional peers and the list this gate guards have ' +
        'drifted apart. A provider added to core but missing from PROVIDERS is unguarded — the ' +
        'split this gate exists to catch would land silently on it. Add it to PROVIDERS; and if ' +
        'one was removed from core, remove it here deliberately rather than leaving a check on a ' +
        'dependency nothing declares.'
    ).toEqual([...PROVIDERS].sort());
  });

  describe('the detector can still find a split (the repo is clean, so the checks above pass either way)', () => {
    it('reports both versions when one package resolves twice', () => {
      const lock = [
        'packages:',
        '',
        "  '@langchain/google@0.2.3':",
        '    resolution: {integrity: sha512-aaa}',
        '',
        "  '@langchain/google@0.2.6':",
        '    resolution: {integrity: sha512-bbb}',
        '',
        'snapshots:',
        '',
      ].join('\n');
      expect(packageVersionsInLockfile(lock).get('@langchain/google')).toEqual(['0.2.3', '0.2.6']);
    });

    it('splits a scoped name at the version, not at the scope', () => {
      // Splitting on the FIRST `@` maps every scoped package to '' and finds no provider at all,
      // which would leave every one-version check above asserting about a name that never appears.
      const lock = ['packages:', "  '@langchain/openai@1.5.13':", '    x: y', ''].join('\n');
      const versions = packageVersionsInLockfile(lock);
      expect([...versions.keys()]).toEqual(['@langchain/openai']);
      expect(versions.get('@langchain/openai')).toEqual(['1.5.13']);
    });

    it('reads bare keys and stops at the next top-level block', () => {
      const lock = [
        'packages:',
        '  accepts@2.0.0:',
        '    resolution: {integrity: sha512-ccc}',
        '  # a comment inside the block',
        '',
        'snapshots:',
        '  should-not-be-counted@9.9.9:',
        '',
      ].join('\n');
      const versions = packageVersionsInLockfile(lock);
      expect([...versions.keys()]).toEqual(['accepts']);
    });

    it('refuses a key it cannot parse instead of skipping it', () => {
      const lock = ['packages:', '  "double quoted@1.0.0":', '    x: y', ''].join('\n');
      expect(() => packageVersionsInLockfile(lock)).toThrow(/cannot parse an entry/);
    });

    it('refuses a key with no version instead of counting it as one', () => {
      const lock = ['packages:', '  no-version-here:', '    x: y', ''].join('\n');
      expect(() => packageVersionsInLockfile(lock)).toThrow(/no name@version boundary/);
    });

    it('refuses a lockfile with no packages block rather than finding nothing in it', () => {
      expect(() => packageVersionsInLockfile('importers:\n  .: {}\n')).toThrow(
        /no top-level "packages:" block/
      );
    });

    it('identifies a physical copy by its .pnpm snapshot directory on either separator', () => {
      expect(
        physicalCopyId('/repo/node_modules/.pnpm/@langchain+google@0.2.6_abc/node_modules/x')
      ).toBe('@langchain+google@0.2.6_abc');
      expect(
        physicalCopyId(
          'C:\\repo\\node_modules\\.pnpm\\@langchain+google@0.2.6_abc\\node_modules\\x'
        )
      ).toBe('@langchain+google@0.2.6_abc');
      expect(physicalCopyId('/repo/node_modules/@langchain/google')).toBe(
        '/repo/node_modules/@langchain/google'
      );
    });
  });
});
