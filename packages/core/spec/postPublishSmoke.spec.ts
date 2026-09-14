import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';

// Unit test for scripts/post-publish-smoke.mjs — the OPS-42 post-publish release alarm that
// installs what the registry actually serves and proves all three bins still work.
//
// That step runs only on a real release dispatch, so logic left inline in release.yml could be
// verified only by shipping a broken release; here the shipped logic is the tested logic. Every
// external call goes through one injected `run` seam, so all six outcomes are driven with no
// network and no registry — including the ones nobody wants to reproduce for real.
//
// The case that matters most is `discovers the version that was PUBLISHED, not the one on main`.
// The pipeline ships the version in packages/core/package.json and only then post-bumps `main`, so
// a post-publish check that reads `main` asks for a version that does not exist and is red on every
// successful release — a false alarm pointing the reassuring way, which is how a release check
// earns being muted. That test is the guard on the whole design.
//
// This spec sits in a package's spec/ dir only because that is where the vitest `include` glob
// looks, and in core/ because that is where the other "a CI gate stays wired and keeps working"
// specs live. The wiring half is postPublishSmokeWiredIntoRelease.spec.ts.

const HELPER = '../../../scripts/post-publish-smoke.mjs';

const REPO = 'pukeko-robotics/gaunt-sloth';
/** The commit a release run was dispatched from — what GITHUB_SHA holds. */
const RELEASE_SHA = '19e5d1dcc6e0b5bd5748c187e11a5099503dc30f';
/** The annotated tag OBJECT sha, which is not the commit until it is dereferenced. */
const TAG_OBJECT_SHA = 'c5fddfd944579b443a13fc889eaca68125be5188';
const PUBLISHED = '2.0.0-beta.10';
/** What `main` carries after the post-bump — published nowhere. */
const ON_MAIN = '2.0.0-beta.11';

type RunResult = { status: number | null; stdout: string; stderr: string };
type Handler = (command: string, args: string[]) => RunResult | undefined;

const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = 'boom', status = 1): RunResult => ({ status, stdout: '', stderr });

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A prefix directory holding a bin/ with the given executables present as files. */
function prefixWithBins(bins: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'post-publish-spec-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  for (const bin of bins) writeFileSync(join(dir, 'bin', bin), '#!/usr/bin/env node\n');
  return dir;
}

/** A recording runner that answers from the first handler that claims the call. */
function runner(...handlers: Handler[]) {
  const calls: { command: string; args: string[] }[] = [];
  const run = (command: string, args: string[]): RunResult => {
    calls.push({ command, args });
    for (const handler of handlers) {
      const answer = handler(command, args);
      if (answer) return answer;
    }
    return fail(`unhandled call: ${command} ${args.join(' ')}`);
  };
  return { run, calls };
}

/** `gh api … matching-refs/tags/gaunt-sloth@` — the TSV the script asks jq for. */
function ghTags(tags: { name: string; objectType: string; objectSha: string }[]): Handler {
  return (command, args) => {
    if (command !== 'gh' || !args.some((a) => a.includes('matching-refs'))) return undefined;
    return ok(
      tags.map((t) => `refs/tags/${t.name}\t${t.objectType}\t${t.objectSha}`).join('\n') + '\n'
    );
  };
}

/** `gh api … git/tags/<object sha>` — dereferencing an annotated tag to its commit. */
function ghDeref(map: Record<string, string>): Handler {
  return (command, args) => {
    if (command !== 'gh') return undefined;
    const path = args.find((a) => a.includes('git/tags/'));
    if (!path) return undefined;
    const objectSha = path.slice(path.lastIndexOf('/') + 1);
    return map[objectSha] ? ok(`${map[objectSha]}\n`) : fail('404');
  };
}

/** `npm view <pkg>@<version> version` — visible is the set of specs the registry serves. */
function npmView(visible: string[]): Handler {
  return (command, args) => {
    if (command !== 'npm' || args[0] !== 'view' || args[2] !== 'version') return undefined;
    const spec = args[1];
    if (!visible.includes(spec)) return fail(`npm error code E404\nnpm error 404 ${spec}`);
    return ok(`${spec.slice(spec.lastIndexOf('@') + 1)}\n`);
  };
}

/** `npm view <pkg> dist-tags --json`. */
function npmDistTags(tags: Record<string, string>): Handler {
  return (command, args) => {
    if (command !== 'npm' || args[0] !== 'view' || args[2] !== 'dist-tags') return undefined;
    return ok(JSON.stringify(tags));
  };
}

/** `npm install --global …`. */
function npmInstall(result: RunResult = ok('added 1 package\n')): Handler {
  return (command, args) => (command === 'npm' && args[0] === 'install' ? result : undefined);
}

/** A bin invoked by absolute path: `--version` prints `version`, `--help` prints a usage block. */
function bins(version: string, overrides: Record<string, RunResult> = {}): Handler {
  return (command, args) => {
    // Matched and split with `node:path`, not a `/` literal. The recurring Windows-only failure in
    // this repository is a spec that hardcodes a POSIX separator and compares it to a value
    // production builds with `join`/`resolve`: green everywhere, red on win32 alone.
    if (!command.includes(`${sep}bin${sep}`)) return undefined;
    const name = basename(command);
    const key = `${name} ${args[0]}`;
    if (overrides[key]) return overrides[key];
    if (args[0] === '--version') return ok(`${version}\n`);
    if (args[0] === '--help') return ok('reading STDIN.\nUsage: gth [options] [command]\n\n');
    return undefined;
  };
}

/** The tag layout of a normal release run: an annotated tag at the dispatched commit. */
const NORMAL_TAGS = [
  { name: `gaunt-sloth@${PUBLISHED}`, objectType: 'tag', objectSha: TAG_OBJECT_SHA },
  { name: 'gaunt-sloth@2.0.0-beta.9', objectType: 'tag', objectSha: 'aaa9' },
];
const NORMAL_DEREF = { [TAG_OBJECT_SHA]: RELEASE_SHA, aaa9: 'ea4572a8' };

/** Every locked package visible at one version, as a clean publish leaves the registry. */
async function allVisibleAt(version: string): Promise<string[]> {
  const { LOCKED_PACKAGES } = await import(HELPER);
  return LOCKED_PACKAGES.map((p: string) => `${p}@${version}`);
}

describe('scripts/post-publish-smoke.mjs', () => {
  // Guards this helper's entry in vitest.config.ts's `server.deps.external`. It is a Node CLI
  // script carrying a `#!` shebang; inlined by Vitest it is evaluated inside an AsyncFunction
  // wrapper where a surviving shebang is a hard SyntaxError — which is how every case of
  // distTag.spec.ts once failed on Windows and only on Windows. A real ESM namespace exposes a
  // non-configurable DATA property; Vitest's inlined exports object exposes a configurable GETTER.
  it('imports the helper natively (externalized, not inlined by Vitest)', async () => {
    const mod = await import(HELPER);
    const descriptor = Object.getOwnPropertyDescriptor(mod, 'smoke');
    expect(typeof descriptor?.value).toBe('function');
    expect(descriptor?.get).toBeUndefined();
    expect(descriptor?.configurable).toBe(false);
  });

  describe('parseArgs', () => {
    it('rejects an unknown flag instead of ignoring it', async () => {
      const { parseArgs } = await import(HELPER);
      expect(
        parseArgs(['--version', '1.2.3', '--prefix', '/p', '--schedule', '0,5'])
      ).toMatchObject({ version: '1.2.3', prefix: '/p', schedule: [0, 5] });
      // A mistyped flag must not look like a clean run of the default configuration — on a release
      // alarm, a silently ignored `--version` would smoke whatever the environment pointed at.
      expect(() => parseArgs(['--timeout-ms', '5'])).toThrow(/unknown argument/);
    });

    it('documents only flags it actually implements', async () => {
      const { parseArgs } = await import(HELPER);
      const source = readFileSync(new URL(HELPER, import.meta.url), 'utf8');
      const cli = source.slice(source.indexOf('// CLI'), source.indexOf('import {'));
      const flags = [...new Set([...cli.matchAll(/--[a-z-]+/g)].map((m) => m[0]))];
      // Control: a missed slice would leave nothing to check and pass for the wrong reason.
      expect(flags.length).toBeGreaterThanOrEqual(4);
      for (const flag of flags) {
        expect(
          () => parseArgs([flag, '1']),
          `the header documents ${flag} but parseArgs rejects it`
        ).not.toThrow();
      }
    });
  });

  describe('versionFromTagRef', () => {
    it('takes the version off the fat CLI tag', async () => {
      const { versionFromTagRef } = await import(HELPER);
      expect(versionFromTagRef('refs/tags/gaunt-sloth@2.0.0-beta.10')).toBe('2.0.0-beta.10');
      expect(versionFromTagRef('gaunt-sloth@1.5.5')).toBe('1.5.5');
    });

    it('ignores the scoped packages tagged in the same run', async () => {
      const { versionFromTagRef } = await import(HELPER);
      // tag-packages.sh tags all seven packages. `@gaunt-sloth/core@2.0.0-beta.10` must not be
      // mistaken for the fat CLI's tag, and the leading `@` must not be split on.
      expect(versionFromTagRef('refs/tags/@gaunt-sloth/core@2.0.0-beta.10')).toBeUndefined();
      expect(versionFromTagRef('refs/tags/v2.0.0-beta.10')).toBeUndefined();
      expect(versionFromTagRef('refs/tags/gaunt-sloth@')).toBeUndefined();
    });
  });

  describe('compareVersionsDesc', () => {
    it('orders prereleases numerically, not as text', async () => {
      const { compareVersionsDesc } = await import(HELPER);
      // The GitHub refs API returns tags in LEXICOGRAPHIC order, where beta.10 sorts before
      // beta.2. Sorting the candidates as text would dereference the wrong tag first on every
      // release past .9 — measured on the repository, which has 52 gaunt-sloth@* tags.
      const sorted = ['2.0.0-beta.2', '2.0.0-beta.10', '2.0.0-beta.9'].sort(compareVersionsDesc);
      expect(sorted).toEqual(['2.0.0-beta.10', '2.0.0-beta.9', '2.0.0-beta.2']);
    });

    it('ranks a stable version above its own prereleases', async () => {
      const { compareVersionsDesc } = await import(HELPER);
      expect(['2.0.0-rc.1', '2.0.0', '1.9.9'].sort(compareVersionsDesc)).toEqual([
        '2.0.0',
        '2.0.0-rc.1',
        '1.9.9',
      ]);
    });
  });

  describe('discoverPublishedVersion', () => {
    it('discovers the version that was PUBLISHED, not the one on main', async () => {
      const { discoverPublishedVersion } = await import(HELPER);
      const { run } = runner(ghTags(NORMAL_TAGS), ghDeref(NORMAL_DEREF));
      const found = discoverPublishedVersion({ run, repo: REPO, sha: RELEASE_SHA });
      expect(found.version).toBe(PUBLISHED);
      // The whole point: `main` carries the next version by the time this runs, and asking the
      // registry for it would be red on every successful release.
      expect(found.version).not.toBe(ON_MAIN);
      expect(found.commit).toBe(RELEASE_SHA);
    });

    it('dereferences the annotated tag object rather than trusting its sha', async () => {
      const { discoverPublishedVersion } = await import(HELPER);
      const { run, calls } = runner(ghTags(NORMAL_TAGS), ghDeref(NORMAL_DEREF));
      discoverPublishedVersion({ run, repo: REPO, sha: RELEASE_SHA });
      // tag-packages.sh creates ANNOTATED tags, whose ref object sha is the tag object, not the
      // commit. Comparing that sha to github.sha directly would never match.
      expect(calls.some((c) => c.args.some((a) => a.includes(`git/tags/${TAG_OBJECT_SHA}`)))).toBe(
        true
      );
    });

    it('accepts a lightweight tag, whose object already is the commit', async () => {
      const { discoverPublishedVersion } = await import(HELPER);
      const { run } = runner(
        ghTags([{ name: `gaunt-sloth@${PUBLISHED}`, objectType: 'commit', objectSha: RELEASE_SHA }])
      );
      expect(discoverPublishedVersion({ run, repo: REPO, sha: RELEASE_SHA }).version).toBe(
        PUBLISHED
      );
    });

    it('refuses to guess when no tag points at this run’s commit', async () => {
      const { discoverPublishedVersion, DiscoveryError } = await import(HELPER);
      const { run } = runner(ghTags(NORMAL_TAGS), ghDeref({ [TAG_OBJECT_SHA]: 'someothercommit' }));
      // A re-dispatch after `main` moved looks like this. Falling back to the newest tag, or to
      // `main`, would assert something about a version nobody asked about — the one failure mode
      // this check exists to prevent.
      expect(() => discoverPublishedVersion({ run, repo: REPO, sha: RELEASE_SHA })).toThrow(
        DiscoveryError
      );
    });

    it('bounds how many tags it dereferences', async () => {
      const { discoverPublishedVersion } = await import(HELPER);
      const many = Array.from({ length: 40 }, (_, i) => ({
        name: `gaunt-sloth@2.0.0-beta.${40 - i}`,
        objectType: 'tag',
        objectSha: `obj${40 - i}`,
      }));
      const { run, calls } = runner(ghTags(many), ghDeref({}));
      expect(() => discoverPublishedVersion({ run, repo: REPO, sha: RELEASE_SHA })).toThrow();
      const derefs = calls.filter((c) => c.args.some((a) => a.includes('git/tags/')));
      expect(derefs.length).toBeLessThanOrEqual(12);
      // Control: it did try, so the bound is what stopped it and not an empty candidate list.
      expect(derefs.length).toBeGreaterThan(0);
    });

    it('says so rather than throwing something unreadable when the env is missing', async () => {
      const { discoverPublishedVersion } = await import(HELPER);
      const { run } = runner();
      expect(() => discoverPublishedVersion({ run, repo: '', sha: RELEASE_SHA })).toThrow(
        /GITHUB_REPOSITORY/
      );
      expect(() => discoverPublishedVersion({ run, repo: REPO, sha: '' })).toThrow(/GITHUB_SHA/);
    });
  });

  describe('waitForVisibility', () => {
    const noSleep = async () => {};

    it('reports every locked package once the registry serves them all', async () => {
      const { waitForVisibility } = await import(HELPER);
      const { run } = runner(npmView(await allVisibleAt(PUBLISHED)));
      const seen = await waitForVisibility({ run, sleep: noSleep, version: PUBLISHED });
      expect(seen.missing).toEqual([]);
      expect(seen.attempts).toBe(1);
    });

    it('retries a version that is not visible yet, then reports it missing', async () => {
      const { waitForVisibility } = await import(HELPER);
      let attempt = 0;
      const lateArrival: Handler = (command, args) => {
        if (command !== 'npm' || args[0] !== 'view') return undefined;
        attempt++;
        return attempt < 3 ? fail('npm error code E404') : ok(`${PUBLISHED}\n`);
      };
      const { run } = runner(lateArrival);
      const seen = await waitForVisibility({
        run,
        sleep: noSleep,
        version: PUBLISHED,
        packages: ['gaunt-sloth'],
      });
      // Propagation is a real effect, not a flake — the retry is what stops it being reported as a
      // broken publish.
      expect(seen.missing).toEqual([]);
      expect(seen.attempts).toBeGreaterThan(1);
    });

    it('keeps "none of it arrived" and "some of it arrived" apart', async () => {
      const { waitForVisibility } = await import(HELPER);
      const { run } = runner(
        npmView([`gaunt-sloth@${PUBLISHED}`, `@gaunt-sloth/core@${PUBLISHED}`])
      );
      const seen = await waitForVisibility({
        run,
        sleep: noSleep,
        version: PUBLISHED,
        schedule: [0, 0],
      });
      expect(seen.visible).toEqual(['gaunt-sloth', '@gaunt-sloth/core']);
      expect(seen.missing).toEqual([
        '@gaunt-sloth/agent',
        '@gaunt-sloth/review',
        '@gaunt-sloth/batch',
      ]);
    });

    it('spends the schedule it was given and no more', async () => {
      const { waitForVisibility } = await import(HELPER);
      const slept: number[] = [];
      const { run } = runner(npmView([]));
      const seen = await waitForVisibility({
        run,
        sleep: async (ms: number) => {
          slept.push(ms);
        },
        version: PUBLISHED,
        schedule: [0, 5, 10],
      });
      // Tuned to REPORT FAST: every minute waited here is spent from npm's 72-hour unpublish
      // budget, so the schedule is a bound and not a patience setting.
      expect(slept).toEqual([5000, 10000]);
      expect(seen.attempts).toBe(3);
    });
  });

  describe('installGlobally', () => {
    it('never installs without an explicit prefix', async () => {
      const { installGlobally } = await import(HELPER);
      const { run } = runner(npmInstall());
      // A bare `npm i -g` on a developer machine overwrites the gth they actually use. There is no
      // code path here that can do it.
      expect(() => installGlobally({ run, prefix: undefined, version: PUBLISHED })).toThrow(
        /explicit prefix/
      );
    });

    it('installs the exact published version into the prefix it was given', async () => {
      const { installGlobally } = await import(HELPER);
      const { run, calls } = runner(npmInstall());
      installGlobally({ run, prefix: '/tmp/scratch-prefix', version: PUBLISHED });
      const args = calls[0].args;
      expect(args).toContain(`gaunt-sloth@${PUBLISHED}`);
      expect(args[args.indexOf('--prefix') + 1]).toBe('/tmp/scratch-prefix');
    });
  });

  describe('checkBins', () => {
    it('passes when all three report exactly the published version and print help', async () => {
      const { checkBins, BINS } = await import(HELPER);
      const prefix = prefixWithBins([...BINS]);
      const { run, calls } = runner(bins(PUBLISHED));
      expect(checkBins({ run, prefix, version: PUBLISHED })).toEqual([]);
      // All THREE are exercised: they share one cli.js, but they are what a user types and nothing
      // else in the repository proves all three survive packaging.
      for (const bin of BINS) {
        expect(calls.some((c) => c.command.endsWith(bin) && c.args[0] === '--version')).toBe(true);
      }
    });

    it('fails a bin that starts and reports the WRONG version', async () => {
      const { checkBins, BINS } = await import(HELPER);
      const prefix = prefixWithBins([...BINS]);
      // Exiting 0 is not the assertion: this is what a stale or mispacked dist looks like.
      const { run } = runner(bins(PUBLISHED, { 'gsloth --version': ok('2.0.0-beta.3\n') }));
      const problems = checkBins({ run, prefix, version: PUBLISHED });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('gsloth');
      expect(problems[0]).toContain('2.0.0-beta.3');
    });

    it('fails a bin the install did not create', async () => {
      const { checkBins, BINS } = await import(HELPER);
      const prefix = prefixWithBins(['gaunt-sloth', 'gth']);
      const { run } = runner(bins(PUBLISHED));
      const problems = checkBins({ run, prefix, version: PUBLISHED });
      expect(problems.some((p: string) => p.includes('gsloth'))).toBe(true);
      expect(BINS).toContain('gsloth');
    });

    it('fails a bin whose help does not render', async () => {
      const { checkBins, BINS } = await import(HELPER);
      const prefix = prefixWithBins([...BINS]);
      const { run } = runner(bins(PUBLISHED, { 'gth --help': fail('Cannot find module', 1) }));
      const problems = checkBins({ run, prefix, version: PUBLISHED });
      expect(problems.some((p: string) => p.includes('gth --help'))).toBe(true);
    });
  });

  describe('checkDistTag', () => {
    it('asserts the version holds the tag derived from its own version', async () => {
      const { checkDistTag } = await import(HELPER);
      const { run } = runner(npmDistTags({ latest: '2.0.0-beta.5', beta: PUBLISHED }));
      const verdict = checkDistTag({ run, version: PUBLISHED });
      expect(verdict.expectedTag).toBe('beta');
      expect(verdict.ok).toBe(true);
    });

    it('asserts nothing about `latest` when `latest` is not the derived tag', async () => {
      const { checkDistTag } = await import(HELPER);
      // `latest` is where the release policy says it is. Measured on the registry while building
      // this: latest was 2.0.0-beta.5 while beta was 2.0.0-beta.10 — a deliberate promotion, not
      // an incident. A check that called a prerelease on `latest` a failure would be asserting
      // something false.
      const { run } = runner(npmDistTags({ latest: '2.0.0-beta.5', beta: PUBLISHED }));
      expect(checkDistTag({ run, version: PUBLISHED }).ok).toBe(true);
    });

    it('fails when the channel tag was not moved to the published version', async () => {
      const { checkDistTag } = await import(HELPER);
      const { run } = runner(npmDistTags({ latest: '2.0.0-beta.5', beta: '2.0.0-beta.9' }));
      const verdict = checkDistTag({ run, version: PUBLISHED });
      expect(verdict.ok).toBe(false);
      expect(verdict.actual).toBe('2.0.0-beta.9');
    });

    it('requires `latest` for a stable version', async () => {
      const { checkDistTag } = await import(HELPER);
      const { run } = runner(npmDistTags({ latest: '2.0.0', beta: '2.0.0-beta.10' }));
      expect(checkDistTag({ run, version: '2.0.0' }).expectedTag).toBe('latest');
      expect(checkDistTag({ run, version: '2.0.0' }).ok).toBe(true);
    });
  });

  describe('smoke — the outcomes are distinct, and each names what to do', () => {
    const noSleep = async () => {};

    async function smokeWith(handlers: Handler[], overrides: Record<string, unknown> = {}) {
      const { smoke, BINS } = await import(HELPER);
      const prefix = (overrides.prefix as string) ?? prefixWithBins([...BINS]);
      const { run } = runner(...handlers);
      return smoke({
        run,
        sleep: noSleep,
        env: { GITHUB_REPOSITORY: REPO, GITHUB_SHA: RELEASE_SHA },
        options: { schedule: [0, 0], prefix, ...((overrides.options as object) ?? {}) },
      });
    }

    it('passes a clean release end to end', async () => {
      const result = await smokeWith([
        ghTags(NORMAL_TAGS),
        ghDeref(NORMAL_DEREF),
        npmView(await allVisibleAt(PUBLISHED)),
        npmInstall(),
        bins(PUBLISHED),
        npmDistTags({ latest: '2.0.0-beta.5', beta: PUBLISHED }),
      ]);
      expect(result.name).toBe('OK');
      expect(result.outcome).toBe(0);
      expect(result.version).toBe(PUBLISHED);
    });

    it('reports NOT_VISIBLE when the registry served none of it', async () => {
      const result = await smokeWith([
        ghTags(NORMAL_TAGS),
        ghDeref(NORMAL_DEREF),
        npmView([]),
        npmInstall(),
        bins(PUBLISHED),
      ]);
      expect(result.name).toBe('NOT_VISIBLE');
      expect(result.outcome).toBe(2);
    });

    it('reports PARTIAL when some of the locked set published and some did not', async () => {
      const result = await smokeWith([
        ghTags(NORMAL_TAGS),
        ghDeref(NORMAL_DEREF),
        npmView([`gaunt-sloth@${PUBLISHED}`]),
        npmInstall(),
        bins(PUBLISHED),
      ]);
      // The node's own point: five packages ship in one step, and a partial publish looks
      // identical to a clean one from inside CI.
      expect(result.name).toBe('PARTIAL');
      expect(result.outcome).toBe(6);
      expect(result.lines.join(' ')).toContain('@gaunt-sloth/core');
    });

    it('reports BROKEN when the registry served it and the bins do not work', async () => {
      const result = await smokeWith([
        ghTags(NORMAL_TAGS),
        ghDeref(NORMAL_DEREF),
        npmView(await allVisibleAt(PUBLISHED)),
        npmInstall(),
        bins(PUBLISHED, { 'gth --version': fail('Cannot find module dist/index.js', 1) }),
        npmDistTags({ beta: PUBLISHED }),
      ]);
      expect(result.name).toBe('BROKEN');
      expect(result.outcome).toBe(3);
    });

    it('reports BROKEN when the global install itself fails', async () => {
      const result = await smokeWith([
        ghTags(NORMAL_TAGS),
        ghDeref(NORMAL_DEREF),
        npmView(await allVisibleAt(PUBLISHED)),
        npmInstall(fail('ERESOLVE could not resolve', 1)),
      ]);
      expect(result.name).toBe('BROKEN');
      expect(result.outcome).toBe(3);
    });

    it('reports DIST_TAG when the bytes are sound but the channel tag is not', async () => {
      const result = await smokeWith([
        ghTags(NORMAL_TAGS),
        ghDeref(NORMAL_DEREF),
        npmView(await allVisibleAt(PUBLISHED)),
        npmInstall(),
        bins(PUBLISHED),
        npmDistTags({ latest: '2.0.0-beta.5', beta: '2.0.0-beta.9' }),
      ]);
      expect(result.name).toBe('DIST_TAG');
      expect(result.outcome).toBe(4);
    });

    it('reports DISCOVERY, and asserts nothing, when it cannot tell what shipped', async () => {
      const result = await smokeWith([
        ghTags(NORMAL_TAGS),
        ghDeref({ [TAG_OBJECT_SHA]: 'a-commit-this-run-was-not-dispatched-from' }),
      ]);
      expect(result.name).toBe('DISCOVERY');
      expect(result.outcome).toBe(5);
      expect(result.version).toBeUndefined();
    });

    it('smokes the version it was handed, skipping discovery', async () => {
      // How the deliberate-failure demonstration and these tests drive it — and the documented
      // remedy for a DISCOVERY run.
      const { smoke, BINS } = await import(HELPER);
      const { run, calls } = runner(
        npmView(await allVisibleAt('9.9.9')),
        npmInstall(),
        bins('9.9.9'),
        npmDistTags({ latest: '9.9.9' })
      );
      const result = await smoke({
        run,
        sleep: noSleep,
        env: {},
        options: { version: '9.9.9', schedule: [0], prefix: prefixWithBins([...BINS]) },
      });
      expect(result.name).toBe('OK');
      expect(calls.some((c) => c.command === 'gh')).toBe(false);
    });

    it('gives every outcome its own exit code, and leaves 1 to a thrown error', async () => {
      const { OUTCOME, RESPONSE } = await import(HELPER);
      const codes = Object.values(OUTCOME) as number[];
      expect(new Set(codes).size).toBe(codes.length);
      // node exits 1 when the script itself throws; a verdict about the release must never be
      // confusable with that.
      expect(codes).not.toContain(1);
      // Every failing outcome names its remedy, so a red run is not a recovery improvised live.
      for (const name of Object.keys(OUTCOME)) {
        if (name === 'OK') continue;
        expect(RESPONSE[name], `no documented response for ${name}`).toBeTruthy();
      }
    });
  });
});
