import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * OPS-120 — an override must be declared somewhere pnpm actually reads, and must arrive.
 *
 * pnpm takes dependency overrides from `overrides:` in pnpm-workspace.yaml and from
 * `pnpm.overrides` in the ROOT package.json. A **top-level** `overrides` key is npm's syntax, and
 * pnpm neither reads nor rejects it: the install exits 0 and the lockfile simply never mentions
 * the pin. So the block looks live, reads as live in review, and holds nothing down — which is how
 * three pins (`rimraf`, `minimatch`, `uuid`) sat in the root manifest doing nothing.
 *
 * That is the same defect class as `minimumReleaseAgeExclude`'s silently-dropped second entry: an
 * operation that cannot fail loudly gets trusted on its exit code. The only thing that would have
 * caught it is comparing the two representations that are supposed to agree, which is what the
 * second test here does.
 *
 * Both halves are needed and neither subsumes the other. The lockfile comparison cannot see a pin
 * written in npm syntax — an ignored key is absent from BOTH sides, so the sets still agree. The
 * manifest sweep is what catches that one, and it generalises to manifests this repo does not have
 * yet.
 *
 * `pnpm.overrides` is honoured only in the root manifest; in a workspace package pnpm ignores it
 * exactly as silently, so the sweep treats it as the same defect below the root.
 */

const REPO_ROOT = new URL('../../../', import.meta.url);
const WORKSPACE_YAML = new URL('pnpm-workspace.yaml', REPO_ROOT);
const LOCKFILE = new URL('pnpm-lock.yaml', REPO_ROOT);

/** Directories that hold no authored manifest of ours, only installed or generated ones. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.pnpm-store', 'artifacts']);

interface Manifest {
  /** For messages only — never compared, so no POSIX path literal can decide a Windows cell. */
  label: string;
  isRoot: boolean;
  pkg: Record<string, unknown>;
}

/**
 * Every authored package.json, found by walking the tree rather than by asking git.
 * `git ls-files` returns nothing in a `git archive` extraction, which would turn this gate into a
 * vacuous pass in exactly the environment that has no history to consult.
 */
function manifestsInRepo(): Manifest[] {
  const found: Manifest[] = [];
  const walk = (dir: string, label: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(
          join(dir, entry.name),
          label === '' ? entry.name : `${label}/${entry.name}`,
          depth + 1
        );
      } else if (entry.name === 'package.json') {
        const text = readFileSync(join(dir, entry.name), 'utf8');
        found.push({
          label: label === '' ? 'package.json' : `${label}/package.json`,
          isRoot: depth === 0,
          pkg: JSON.parse(text) as Record<string, unknown>,
        });
      }
    }
  };
  walk(fileURLToPath(REPO_ROOT), '', 0);
  return found;
}

/**
 * The override declarations in one manifest that pnpm will silently ignore.
 *
 * Split out from the file walk so the tests below can run it over a synthetic manifest and prove
 * it still finds something. A detector only ever exercised against a repo that is currently clean
 * is an assertion that cannot fail.
 */
function ignoredOverrideKeys(pkg: Record<string, unknown>, isRoot: boolean): string[] {
  const findings: string[] = [];
  if (pkg.overrides !== undefined) {
    findings.push('overrides');
  }
  const pnpmSection = pkg.pnpm as Record<string, unknown> | undefined;
  if (!isRoot && pnpmSection?.overrides !== undefined) {
    findings.push('pnpm.overrides');
  }
  return findings;
}

/**
 * One top-level block of a simple YAML mapping, as `{ key: value }`.
 *
 * Deliberately NOT a YAML parser. It understands the handful of shapes these two files actually
 * use and **throws on anything else** rather than skipping it. Skipping is what would give this
 * gate a blind spot of its own — an override written in a form the scanner did not recognise would
 * read as "not declared" and the comparison would pass. A throw fails the suite loudly and names
 * the line, which is the safe direction for a gate whose whole purpose is that silence is the bug.
 *
 * Returns null when the block is absent entirely.
 */
function topLevelBlock(text: string, key: string): Record<string, string> | null {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`${key}:`);
  if (start === -1) return null;

  const entries: Record<string, string> = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    // A dedent ends the block: the next top-level key, or a comment introducing it.
    if (!line.startsWith('  ')) break;
    // An indented comment belongs to the block.
    if (/^ {2}#/.test(line)) continue;

    const match = /^ {2}(?:'([^']+)'|"([^"]+)"|([^'"#\s][^:]*)):[ \t]+(\S.*?)[ \t]*$/.exec(line);
    if (match === null) {
      throw new Error(
        `pnpmOverridesGate: cannot parse an entry of the "${key}:" block, so it cannot be ` +
          `compared. Teach topLevelBlock() this shape rather than letting it be skipped: ` +
          JSON.stringify(line)
      );
    }
    entries[match[1] ?? match[2] ?? match[3]] = match[4];
  }
  return entries;
}

/** Every override this repo declares in a place pnpm honours. */
function declaredOverrides(): Record<string, string> {
  const fromWorkspace = topLevelBlock(readFileSync(WORKSPACE_YAML, 'utf8'), 'overrides') ?? {};
  const root = manifestsInRepo().find((m) => m.isRoot);
  const fromRootManifest = ((root?.pkg.pnpm as Record<string, unknown> | undefined)?.overrides ??
    {}) as Record<string, string>;
  return { ...fromWorkspace, ...fromRootManifest };
}

describe('OPS-120 dependency overrides are declared where pnpm reads them, and arrive', () => {
  it('has no manifest declaring overrides in a form pnpm silently ignores', () => {
    const manifests = manifestsInRepo();
    // Control: a walk that found nothing would satisfy every assertion below for the wrong reason.
    expect(
      manifests.length,
      'the manifest walk found no package.json at all, so the sweep below proved nothing'
    ).toBeGreaterThan(1);
    expect(
      manifests.some((m) => m.isRoot),
      'the manifest walk never reached the root package.json, which is the one that carried the ' +
        'ignored block OPS-120 removed'
    ).toBe(true);

    const offenders = manifests.flatMap((m) =>
      ignoredOverrideKeys(m.pkg, m.isRoot).map((key) => `${m.label} → "${key}"`)
    );
    expect(
      offenders,
      'pnpm reads overrides from pnpm-workspace.yaml and from `pnpm.overrides` in the ROOT ' +
        'package.json only. A top-level `overrides` key is npm syntax: pnpm ignores it without a ' +
        'warning, the install still exits 0, and the pin holds nothing down. Move these into ' +
        "pnpm-workspace.yaml's `overrides:` block."
    ).toEqual([]);
  });

  it.each([
    { what: 'a top-level `overrides` key', pkg: { overrides: { left: '^1' } }, isRoot: true },
    {
      what: '`pnpm.overrides` below the root',
      pkg: { pnpm: { overrides: { p: '^2' } } },
      isRoot: false,
    },
  ])('detects $what in a synthetic manifest', ({ pkg, isRoot }) => {
    // The repo is clean, so the sweep above passes whether or not the detector works. This is the
    // control that proves it can still find one.
    expect(ignoredOverrideKeys(pkg as Record<string, unknown>, isRoot)).not.toEqual([]);
  });

  it('does not flag the two forms pnpm does honour', () => {
    expect(ignoredOverrideKeys({ pnpm: { overrides: { p: '^2' } } }, true)).toEqual([]);
    expect(ignoredOverrideKeys({ dependencies: { minimatch: '^10' } }, true)).toEqual([]);
  });

  it('carries every declared override through to pnpm-lock.yaml', () => {
    const declared = declaredOverrides();
    // Non-vacuity: an empty set would make the loop below assert nothing at all, which is the
    // failure shape this whole gate exists to prevent. If every override is ever legitimately
    // removed, delete this gate deliberately rather than letting it pass on an empty set.
    expect(
      Object.keys(declared),
      'no override was parsed out of pnpm-workspace.yaml, so the comparison below is vacuous'
    ).not.toEqual([]);

    const locked = topLevelBlock(readFileSync(LOCKFILE, 'utf8'), 'overrides') ?? {};
    expect(
      locked,
      'pnpm-lock.yaml must record every override that was applied. An override present in the ' +
        'config and absent here was never applied — read this section, never the install exit code.'
    ).toMatchObject(declared);
  });

  it('refuses a block entry it cannot parse instead of skipping it', () => {
    // A scanner that skipped this line would report the override as undeclared, and the
    // comparison above would then pass by finding nothing to compare.
    const yaml = ['overrides:', "  'ok>dep': ^1.0.0", '  broken-no-value:', ''].join('\n');
    expect(() => topLevelBlock(yaml, 'overrides')).toThrow(/cannot parse an entry/);
  });

  it('reads the shapes both files actually use, and stops at the next top-level key', () => {
    const yaml = [
      'overrides:',
      "  '@scope/pkg': ^1.2.3",
      '  # an indented comment inside the block',
      '  bare>child: ^6.0.0',
      '',
      '# a comment introducing the next key',
      'allowBuilds:',
      "  '@swc/core': true",
      '',
    ].join('\n');
    expect(topLevelBlock(yaml, 'overrides')).toEqual({
      '@scope/pkg': '^1.2.3',
      'bare>child': '^6.0.0',
    });
  });
});
