#!/usr/bin/env node
// OPS-42 — post-publish smoke: install what the registry actually serves and prove all three bins
// still work, for the `post-publish-smoke` job of .github/workflows/release.yml.
//
// WHAT THIS IS FOR. Until this existed, nothing in either pipeline ever installed what was
// published, so the first party to discover a broken release was a user. Five packages ship in one
// step, and from inside CI a partial publish looks identical to a clean one. This runs after the
// publish, on a runner that holds no built workspace, and exercises the exact bytes a user receives.
//
// IT BLOCKS NOTHING — IT DETECTS AND SHOUTS. The publish has already happened by the time this
// runs, so a red here is not a gate that stopped something; it is the alarm that starts a
// withdrawal. The intended response is written out under RESPONSE TO A RED RUN below and printed
// into the job summary on every failure, so whoever reads the red is not improvising a recovery
// they have never rehearsed.
//
// NOT THE PRE-PUBLISH CLEAN ROOM (OPS-14), AND THE LINE IS DELIBERATE. OPS-14 builds its clean room
// from `pnpm pack` tarballs and owns pack-content assertions, publint, are-the-types-wrong, the
// Windows shim matrix and consumer interop. A locally packed tarball proves the artifact we were
// about to publish was sound; it cannot prove the publish succeeded, that the dist-tag landed where
// the release policy says, or that the inter-package `^` ranges resolve FROM THE REGISTRY rather
// than from a scratch tree we populated by hand. Those are the only things this file tests.
//
// ---------------------------------------------------------------------------------------------
// THE POST-BUMP TRAP — the one way to make this check worse than useless
// ---------------------------------------------------------------------------------------------
// gaunt-sloth releases with model B: the pipeline publishes the version currently in
// packages/core/package.json and ONLY THEN writes the following one into `main`. So by the time
// this job runs, `main` carries version N+1 while the registry has N.
//
// A post-publish job that reads `main` therefore asks the registry for a version that does not
// exist, and is red on EVERY SUCCESSFUL RELEASE. That failure points the reassuring way — it looks
// exactly like a broken publish — and a release alarm that cries wolf gets muted, which is precisely
// how this work would be wasted. Measured on the repository while building this: at the commit
// tagged gaunt-sloth@2.0.0-beta.10, packages/core/package.json read 2.0.0-beta.10 (the version on
// npm); at `main` it read 2.0.0-beta.11, which had been published nowhere.
//
// So: assert the version that was PUBLISHED, never the version on `main`.
//
// ---------------------------------------------------------------------------------------------
// HOW THE PUBLISHED VERSION IS DISCOVERED, AND WHY THIS ROUTE
// ---------------------------------------------------------------------------------------------
// The release job pushes an annotated `<package>@<version>` git tag, at the version it is about to
// publish, from the commit it built. This reads the `gaunt-sloth@<version>` tag that points at
// GITHUB_SHA and takes the version from its name. Two GitHub API calls in the normal case (list the
// refs, dereference the newest), no checkout of the workspace, and nothing inferred.
//
// Why GITHUB_SHA is the right anchor: for a workflow_dispatch it is frozen at the commit the run
// was dispatched from, so the post-bump — which moves the `main` REF — cannot move it. Measured
// across the three most recent releases while building this: the release run's head SHA, the commit
// the `gaunt-sloth@<version>` tag dereferences to, and the commit whose packages/core/package.json
// holds the published version were the same commit every time (beta.8 2ba96d20, beta.9 ea4572a8,
// beta.10 19e5d1dc).
//
// Why not the obvious alternatives:
//   - `needs: release` outputs — the release job declares no job-level `outputs:` block, so it
//     exposes nothing. Adding one means editing the release job, which this work is not permitted
//     to do: the grant covers adding this job and nothing else.
//   - Reading packages/core/package.json at GITHUB_SHA through the contents API — same answer in
//     the normal case, but it is the release job's INPUT rather than its RESULT. The tag is written
//     by the release job itself from the tree it built, which is one inference fewer.
//   - The `v<version>` GitHub Release — its target_commitish is the branch name `main`, not a
//     commit, so it cannot be tied back to this run's SHA.
//   - Whatever the registry currently serves — circular. That is the thing under test.
//
// When no tag points at GITHUB_SHA this exits DISCOVERY rather than guessing. The benign
// explanation is a re-dispatch after `main` moved: the release job checks out the `main` ref, so it
// can tag a commit later than the one this run was dispatched from. A post-publish alarm that is
// unsure which version shipped has to say so — passing on a version nobody asked about is the one
// failure mode this whole file exists to prevent.
//
// ---------------------------------------------------------------------------------------------
// THE TWO FAILURE MODES ARE REPORTED SEPARATELY, AND SPEED IS THE POINT
// ---------------------------------------------------------------------------------------------
// A just-published version is not instantly installable everywhere. That is a real effect, not a
// flake, so visibility is a bounded retry. The bound is a trade against a fixed budget: every
// minute between a bad publish and its detection is spent from npm's unpublish window, so the
// schedule is front-loaded and a healthy release still reports in seconds.
//
// THE BOUND IS TEN MINUTES, NOT TWO, AND THAT IS DELIBERATE. A two-minute bound was measured too
// short on two consecutive releases: both reported PARTIAL with @gaunt-sloth/core still missing,
// and both were clean on a re-run minutes later with nothing republished. Ten minutes is 0.2% of
// the 72-hour budget below. Weigh any proposal to shorten it against that ratio and against the
// failure this file names further down — a release check that goes red for reasons unrelated to
// packaging GETS MUTED, and a muted alarm has no budget at all.
//
// npm's unpublish policy (docs.npmjs.com/policies/unpublish, read 2026-09-15) allows an
// unconditional unpublish only within 72 hours of publishing, and after that only if no other
// package in the registry depends on it, it had under 300 downloads in the last week, and it has a
// single maintainer. `gaunt-sloth` and @gaunt-sloth/{agent,review,batch} all depend on
// @gaunt-sloth/core, so for the locked set the 72-hour window is the whole budget.
//
// The outcomes are therefore distinct, each with its own exit code and its own remedy:
//   NOT_VISIBLE — the registry served none of it inside the window. Either the publish never
//                 landed, or propagation is unusually slow. Look at npmjs.com before acting.
//   PARTIAL     — some of the locked set is there and some is not. This is the partial publish that
//                 looks clean from inside CI; the fix is to finish the publish, not to withdraw.
//   BROKEN      — the registry served it and it does not work. This is the one that costs users.
//   DIST_TAG    — the bytes are fine but the channel tag is not where the release policy says.
//
// ---------------------------------------------------------------------------------------------
// RESPONSE TO A RED RUN
// ---------------------------------------------------------------------------------------------
// BROKEN, inside npm's 72-hour window: unpublish the version. That is the plan rather than the last
// resort — after GA everything publishes straight to `latest`, and a broken version is withdrawn
// rather than prevented.
// BROKEN, outside the window: `npm deprecate` the version with a message pointing at the working
// one, and move the channel dist-tag back to the last good version. Then ship the fix.
// DIST_TAG: move the tag with `npm dist-tag add`. Nothing needs withdrawing.
// PARTIAL: re-dispatch the release. It ships the same version — the post-bump only runs after a
// successful publish, so the version on `main` has not moved — and publishing the packages that
// are already there is what fails, not the ones that are missing.
// NOT_VISIBLE: check npmjs.com. If the version is there, this was propagation and the run can be
// re-run; if it is not, the publish failed and the release must be re-dispatched.
//
// ---------------------------------------------------------------------------------------------
// WHAT IS ASSERTED
// ---------------------------------------------------------------------------------------------
// All three bins — `gaunt-sloth`, `gsloth` and `gth`. They all point at the same cli.js, but a
// global install is where a bin gets exercised for real (shebang, executable bit, PATH shim), they
// are what a user types, and nothing else in the repository proves all three survive packaging.
// Each must report EXACTLY the published version, not merely exit 0, and print help.
//
// The bins are looked for at `<prefix>/bin/<name>`, which is where npm puts them on Linux and
// macOS. On Windows npm writes `.cmd` / `.ps1` shims beside the prefix instead, so this would not
// find them — deliberately, because the Windows shim matrix is OPS-14's and duplicating it here
// would blur a line the two nodes keep on purpose. The job runs on ubuntu only.
//
// The locked five are checked for presence at the published version before the install. Four of
// them are dependencies of the fat CLI, so a missing one would already break `npm i -g` — but as an
// opaque resolution error rather than a named package. The independently-versioned
// @gaunt-sloth/eval-reporter-* tier is deliberately absent: it does not share the locked version,
// so there is nothing here to assert it against.
//
// `latest` is where the release policy says it is. The published version is asserted to hold the
// dist-tag DERIVED FROM ITS OWN VERSION by scripts/dist-tag.mjs — the same rule the publish uses —
// and nothing is asserted about `latest` unless `latest` is that derived tag. Promoting `latest`
// onto an older version than the channel head is a deliberate policy move, not an incident:
// measured while building this, `latest` was 2.0.0-beta.5 while `beta` was 2.0.0-beta.10.
//
// KEY-FREE by construction. No provider secrets, and nothing here needs any. A post-publish alarm
// that requires provider keys goes red for reasons unrelated to packaging, and gets muted.
//
// NEVER TOUCHES AN AMBIENT GLOBAL PREFIX. The install always goes to an explicit `--prefix`,
// defaulting to a fresh temp directory, and the bins are invoked by absolute path out of it. That
// is what makes this safe to run on a developer machine, where a bare `npm i -g` would overwrite
// the `gth` they actually use. There is no code path that installs without a prefix.
//
// NO dependencies beyond node: builtins and scripts/dist-tag.mjs — this runs from a sparse checkout
// that holds scripts/ and nothing else, with nothing installed.
//
// CLI — these four flags and no others; an unknown one is a hard error rather than a silent no-op:
//   node scripts/post-publish-smoke.mjs [--version <v>] [--prefix <dir>] [--registry <url>]
//                                       [--schedule <comma-separated seconds>]
// With no --version it discovers the published version from the tag at GITHUB_SHA, using
// GITHUB_REPOSITORY and the `gh` CLI. With --version it smokes exactly that version and skips
// discovery, which is how the deliberate-failure demonstration and the unit tests drive it.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveDistTag } from './dist-tag.mjs';

/** The npm package whose tag names the published version, and whose bins are under test. */
export const CLI_PACKAGE = 'gaunt-sloth';

/** The three bins packages/app publishes. All point at cli.js; all three are asserted. */
export const BINS = Object.freeze(['gaunt-sloth', 'gsloth', 'gth']);

/**
 * The version-locked set that ships at one version. The eval-reporter-* tier is independently
 * versioned and is deliberately not here (see the header).
 */
export const LOCKED_PACKAGES = Object.freeze([
  'gaunt-sloth',
  '@gaunt-sloth/core',
  '@gaunt-sloth/agent',
  '@gaunt-sloth/review',
  '@gaunt-sloth/batch',
]);

/**
 * Outcomes, each with its own process exit code so a red run says WHICH failure it was without
 * anyone reading the log. 1 is left unused: it is what node exits with when the script itself
 * throws, and that must not be confusable with a verdict about the release.
 */
export const OUTCOME = Object.freeze({
  OK: 0,
  NOT_VISIBLE: 2,
  BROKEN: 3,
  DIST_TAG: 4,
  DISCOVERY: 5,
  PARTIAL: 6,
});

/** Default registry. Explicit on every npm call so an ambient .npmrc cannot redirect the check. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * Visibility retry schedule, in seconds BEFORE each attempt. Front-loaded on purpose: the common
 * case is that the version is already there, so the first attempt waits not at all and a healthy
 * release still reports in seconds. The tail is what the front-loading buys room for — ten minutes
 * in total, then report.
 *
 * The tail is sized against the case that is NOT the common one. Measured on two consecutive
 * releases, `2.0.0-beta.13` and `2.0.0-beta.14`, a two-minute bound reported PARTIAL with
 * `@gaunt-sloth/core` still missing, and a re-run two to three minutes later found the whole set
 * with nothing republished in between. Ten minutes is not a measurement of npm's propagation — it
 * is that observation with room over it, because one sample of a race tells you almost nothing
 * about its tail.
 */
export const VISIBILITY_SCHEDULE_S = Object.freeze([
  0, 5, 10, 15, 30, 30, 30, 60, 60, 60, 60, 60, 60, 60, 60,
]);

/** How many candidate tags to dereference when looking for the one at GITHUB_SHA. */
export const MAX_TAG_DEREFS = 12;

/** Thrown when the published version cannot be established. Carries the OUTCOME.DISCOVERY code. */
export class DiscoveryError extends Error {
  constructor(message, examined = []) {
    super(message);
    this.name = 'DiscoveryError';
    this.examined = examined;
  }
}

/**
 * Run a command and capture it. The single seam every external call goes through, so the unit
 * suite can drive every outcome without a network or a registry.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number}} [options]
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    // stdin is ignored, never inherited: `gth --help` reads stdin, and a bin left waiting on an
    // open pipe would hang the job instead of failing it.
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 180_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : ''),
  };
}

/** Sleep, injectable so the unit suite does not wait out the retry schedule. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The version part of a `<package>@<version>` tag ref, or undefined when the ref is not one.
 * Splits on the LAST `@` so a scoped package name keeps its leading one.
 * @param {string} ref e.g. "refs/tags/gaunt-sloth@2.0.0-beta.10"
 * @param {string} [pkg]
 * @returns {string|undefined}
 */
export function versionFromTagRef(ref, pkg = CLI_PACKAGE) {
  const name = String(ref ?? '').replace(/^refs\/tags\//, '');
  const at = name.lastIndexOf('@');
  if (at <= 0) return undefined;
  if (name.slice(0, at) !== pkg) return undefined;
  const version = name.slice(at + 1);
  return version.length > 0 ? version : undefined;
}

/**
 * Semver precedence, descending — newest first. No `semver` dependency, for the same reason
 * scripts/dist-tag.mjs has none: this runs from a checkout with nothing installed.
 *
 * Only used to decide which candidate tags to dereference first, so an exotic version string
 * costs an extra API call at worst, never a wrong answer: the answer is decided by the SHA match.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersionsDesc(a, b) {
  const parse = (value) => {
    const text = String(value ?? '');
    const dash = text.indexOf('-');
    const core = (dash === -1 ? text : text.slice(0, dash)).split('.').map((n) => Number(n) || 0);
    const pre = dash === -1 ? [] : text.slice(dash + 1).split('.');
    return { core, pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (right.core[i] ?? 0) - (left.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A version with no prerelease outranks one that has it (2.0.0 is newer than 2.0.0-beta.1).
  if (left.pre.length === 0 && right.pre.length > 0) return -1;
  if (right.pre.length === 0 && left.pre.length > 0) return 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNum = /^[0-9]+$/.test(l);
    const rNum = /^[0-9]+$/.test(r);
    if (lNum && rNum) {
      const diff = Number(r) - Number(l);
      if (diff !== 0) return diff;
    } else if (l !== r) {
      return l < r ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Every `gaunt-sloth@*` tag ref in the repository, newest first.
 * @returns {{ref: string, version: string, objectType: string, objectSha: string}[]}
 */
export function listCliTags({ run, repo }) {
  const result = run('gh', [
    'api',
    '--paginate',
    `repos/${repo}/git/matching-refs/tags/${CLI_PACKAGE}@`,
    '--jq',
    '.[] | [.ref, .object.type, .object.sha] | @tsv',
  ]);
  if (result.status !== 0) {
    throw new DiscoveryError(
      `could not list ${CLI_PACKAGE}@* tags for ${repo}: ${result.stderr.trim() || 'gh api failed'}`
    );
  }
  const tags = [];
  for (const line of result.stdout.split('\n')) {
    const [ref, objectType, objectSha] = line.trim().split('\t');
    const version = versionFromTagRef(ref);
    if (!version || !objectSha) continue;
    tags.push({ ref, version, objectType, objectSha });
  }
  return tags.sort((x, y) => compareVersionsDesc(x.version, y.version));
}

/** The commit a tag ref points at, dereferencing an annotated tag object. */
export function commitOfTag({ run, repo, tag }) {
  if (tag.objectType === 'commit') return tag.objectSha;
  const result = run('gh', [
    'api',
    `repos/${repo}/git/tags/${tag.objectSha}`,
    '--jq',
    '.object.sha',
  ]);
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

/**
 * The version this run published, from the `gaunt-sloth@<version>` tag that points at `sha`.
 * Throws DiscoveryError when no tag does — see the header for why that is a failure and not a
 * fallback to reading `main`.
 * @returns {{version: string, ref: string, commit: string}}
 */
export function discoverPublishedVersion({ run, repo, sha, maxDerefs = MAX_TAG_DEREFS }) {
  if (!repo) throw new DiscoveryError('GITHUB_REPOSITORY is not set');
  if (!sha) throw new DiscoveryError('GITHUB_SHA is not set');
  const tags = listCliTags({ run, repo });
  const examined = [];
  for (const tag of tags.slice(0, maxDerefs)) {
    const commit = commitOfTag({ run, repo, tag });
    examined.push(`${tag.ref} -> ${commit ?? '(could not dereference)'}`);
    if (commit === sha) return { version: tag.version, ref: tag.ref, commit };
  }
  throw new DiscoveryError(
    `no ${CLI_PACKAGE}@* tag points at ${sha}, so the version this run published is unknown. ` +
      'The release job tags the commit it checks out from the `main` ref, which can be later than ' +
      'the commit this run was dispatched from — a re-dispatch after `main` moved looks like this. ' +
      'Re-run this check with --version <the version that was published>.',
    examined
  );
}

/** Whether the registry serves this exact version of a package. */
export function isVersionVisible({ run, pkg, version, registry }) {
  const result = run('npm', [
    'view',
    `${pkg}@${version}`,
    'version',
    '--registry',
    registry,
    '--no-workspaces',
  ]);
  return result.status === 0 && result.stdout.trim() === version;
}

/**
 * Wait, on a bounded front-loaded schedule, until the registry serves every locked package at the
 * published version. Reports which ones arrived, so "none of it" and "some of it" stay distinct.
 * @returns {Promise<{visible: string[], missing: string[], attempts: number, waitedMs: number}>}
 */
export async function waitForVisibility({
  run,
  sleep: sleepFn = sleep,
  packages = LOCKED_PACKAGES,
  version,
  registry = DEFAULT_REGISTRY,
  schedule = VISIBILITY_SCHEDULE_S,
}) {
  const visible = new Set();
  let attempts = 0;
  let waitedMs = 0;
  for (const delayS of schedule) {
    if (delayS > 0) {
      await sleepFn(delayS * 1000);
      waitedMs += delayS * 1000;
    }
    attempts++;
    for (const pkg of packages) {
      if (visible.has(pkg)) continue;
      if (isVersionVisible({ run, pkg, version, registry })) visible.add(pkg);
    }
    if (visible.size === packages.length) break;
  }
  return {
    visible: packages.filter((p) => visible.has(p)),
    missing: packages.filter((p) => !visible.has(p)),
    attempts,
    waitedMs,
  };
}

/**
 * Install the published CLI globally into an EXPLICIT prefix. There is no path through this that
 * installs into an ambient global prefix; see the header.
 */
export function installGlobally({ run, prefix, version, registry = DEFAULT_REGISTRY }) {
  if (!prefix) throw new Error('installGlobally requires an explicit prefix');
  return run('npm', [
    'install',
    '--global',
    `${CLI_PACKAGE}@${version}`,
    '--prefix',
    prefix,
    '--registry',
    registry,
    '--no-fund',
    '--no-audit',
  ]);
}

/**
 * Run each bin out of the install prefix and assert it reports EXACTLY the published version and
 * prints help. Returns one problem string per failing assertion; empty means all three are sound.
 * @returns {string[]}
 */
export function checkBins({ run, prefix, version, bins = BINS }) {
  const problems = [];
  for (const bin of bins) {
    const binPath = join(prefix, 'bin', bin);
    if (!existsSync(binPath)) {
      problems.push(`${bin}: no executable at ${binPath} after a global install`);
      continue;
    }
    const shown = run(binPath, ['--version'], { cwd: prefix });
    if (shown.status !== 0) {
      problems.push(
        `${bin} --version exited ${shown.status}: ${(shown.stderr || shown.stdout).trim().slice(0, 300)}`
      );
    } else if (shown.stdout.trim() !== version) {
      // Equality, not "exits 0": a bin that starts and reports the wrong version is a packaging
      // failure that exiting 0 would hide.
      problems.push(`${bin} --version reported "${shown.stdout.trim()}", expected "${version}"`);
    }
    const help = run(binPath, ['--help'], { cwd: prefix });
    if (help.status !== 0) {
      problems.push(
        `${bin} --help exited ${help.status}: ${(help.stderr || help.stdout).trim().slice(0, 300)}`
      );
    } else if (!help.stdout.includes('Usage:')) {
      problems.push(`${bin} --help printed no usage block`);
    }
  }
  return problems;
}

/**
 * Check the published version holds the dist-tag derived from its OWN version, by the same rule
 * the publish uses. Asserts nothing about `latest` unless `latest` is that derived tag — `latest`
 * is where the release policy says it is, and it is deliberately promoted independently.
 * @returns {{ok: boolean, expectedTag: string, actual: string|undefined, tags: object}}
 */
export function checkDistTag({ run, version, pkg = CLI_PACKAGE, registry = DEFAULT_REGISTRY }) {
  const expectedTag = deriveDistTag(version);
  const result = run('npm', [
    'view',
    pkg,
    'dist-tags',
    '--json',
    '--registry',
    registry,
    '--no-workspaces',
  ]);
  if (result.status !== 0) {
    return { ok: false, expectedTag, actual: undefined, tags: {}, error: result.stderr.trim() };
  }
  let tags;
  try {
    const parsed = JSON.parse(result.stdout);
    tags = Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed;
  } catch {
    return { ok: false, expectedTag, actual: undefined, tags: {}, error: 'dist-tags was not JSON' };
  }
  return { ok: tags[expectedTag] === version, expectedTag, actual: tags[expectedTag], tags };
}

/** The remedy for each outcome, printed on every red run so nobody has to improvise one. */
export const RESPONSE = Object.freeze({
  NOT_VISIBLE:
    'Check npmjs.com for the version. If it is there, this was propagation and the job can be ' +
    're-run. If it is not, the publish did not land and the release must be re-dispatched — the ' +
    'post-bump only runs after a successful publish, so the version on main has not moved.',
  PARTIAL:
    'Part of the locked set published and part did not, which looks clean from inside CI. ' +
    'Re-dispatch the release to finish it; the packages already published are what the re-run ' +
    'has to skip, not the missing ones.',
  BROKEN:
    "Inside npm's 72-hour window, unpublish the version — after GA a broken version is withdrawn " +
    'rather than prevented, so that is the plan and not the last resort. Outside it, `npm ' +
    'deprecate` the version with a message naming the working one and move the channel dist-tag ' +
    'back to the last good version, then ship the fix.',
  DIST_TAG:
    'Move the tag with `npm dist-tag add`. The published bytes are sound, so nothing needs ' +
    'withdrawing.',
  DISCOVERY:
    'This run could not establish which version was published, so it asserted nothing. Read the ' +
    'release job log for the version it shipped and re-run this check with --version <that ' +
    'version>.',
});

/** Emit a GitHub Actions annotation and append to the job summary when running in Actions. */
function report(outcomeName, lines) {
  const body = lines.join('\n');
  if (outcomeName === 'OK') {
    process.stdout.write(`${body}\n`);
  } else {
    process.stdout.write(`${body}\n`);
    process.stdout.write(
      `::error title=Post-publish smoke: ${outcomeName}::${lines[0].replace(/\r?\n/g, ' ')}\n`
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const heading =
      outcomeName === 'OK' ? 'Post-publish smoke passed' : `Post-publish smoke: ${outcomeName}`;
    const remedy = RESPONSE[outcomeName] ? `\n\n**What to do:** ${RESPONSE[outcomeName]}\n` : '\n';
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## ${heading}\n\n${lines.map((l) => `- ${l}`).join('\n')}${remedy}`
    );
  }
}

/** Parse the CLI arguments. */
export function parseArgs(argv) {
  const options = {
    version: undefined,
    prefix: undefined,
    registry: DEFAULT_REGISTRY,
    schedule: VISIBILITY_SCHEDULE_S,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version') options.version = argv[++i];
    else if (arg === '--prefix') options.prefix = argv[++i];
    else if (arg === '--registry') options.registry = argv[++i];
    else if (arg === '--schedule')
      options.schedule = String(argv[++i])
        .split(',')
        .map((n) => Number(n) || 0);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/**
 * The whole check. Returns the outcome rather than exiting, so the unit suite can drive every
 * branch. Stages are ordered by how much they cost a user: nothing is asserted until the version
 * is known, and the dist-tag is judged last because a misplaced tag with sound bytes is the
 * cheapest failure here.
 * @returns {Promise<{outcome: number, name: string, lines: string[], version?: string}>}
 */
export async function smoke({
  run = runCommand,
  sleep: sleepFn = sleep,
  env = process.env,
  options = {},
  makePrefix = () => mkdtempSync(join(tmpdir(), 'gth-post-publish-')),
}) {
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const schedule = options.schedule ?? VISIBILITY_SCHEDULE_S;

  let version = options.version;
  let source = `--version ${version}`;
  if (!version) {
    try {
      const discovered = discoverPublishedVersion({
        run,
        repo: env.GITHUB_REPOSITORY,
        sha: env.GITHUB_SHA,
      });
      version = discovered.version;
      source = `${discovered.ref} at ${discovered.commit}`;
    } catch (error) {
      const examined = error.examined?.length ? [`examined: ${error.examined.join(', ')}`] : [];
      return {
        outcome: OUTCOME.DISCOVERY,
        name: 'DISCOVERY',
        lines: [String(error.message), ...examined],
      };
    }
  }

  const visibility = await waitForVisibility({ run, sleep: sleepFn, version, registry, schedule });
  if (visibility.missing.length === LOCKED_PACKAGES.length) {
    return {
      outcome: OUTCOME.NOT_VISIBLE,
      name: 'NOT_VISIBLE',
      version,
      lines: [
        `the registry served no part of ${version} after ${visibility.attempts} attempts over ` +
          `${Math.round(visibility.waitedMs / 1000)}s (version from ${source})`,
        `missing: ${visibility.missing.join(', ')}`,
      ],
    };
  }
  if (visibility.missing.length > 0) {
    return {
      outcome: OUTCOME.PARTIAL,
      name: 'PARTIAL',
      version,
      lines: [
        `only part of the locked set is on the registry at ${version} (version from ${source})`,
        `published: ${visibility.visible.join(', ')}`,
        `missing: ${visibility.missing.join(', ')}`,
      ],
    };
  }

  const prefix = options.prefix ?? makePrefix();
  const installed = installGlobally({ run, prefix, version, registry });
  if (installed.status !== 0) {
    return {
      outcome: OUTCOME.BROKEN,
      name: 'BROKEN',
      version,
      lines: [
        `npm install --global ${CLI_PACKAGE}@${version} failed with status ${installed.status}`,
        (installed.stderr || installed.stdout).trim().slice(0, 1000),
      ],
    };
  }

  const problems = checkBins({ run, prefix, version });
  if (problems.length > 0) {
    return {
      outcome: OUTCOME.BROKEN,
      name: 'BROKEN',
      version,
      lines: [`${version} installed from the registry but its bins do not work`, ...problems],
    };
  }

  const distTag = checkDistTag({ run, version, registry });
  if (!distTag.ok) {
    return {
      outcome: OUTCOME.DIST_TAG,
      name: 'DIST_TAG',
      version,
      lines: [
        `${version} works, but dist-tag "${distTag.expectedTag}" points at ` +
          `"${distTag.actual ?? '(nothing)'}"${distTag.error ? ` (${distTag.error})` : ''}`,
        `dist-tags now: ${JSON.stringify(distTag.tags)}`,
      ],
    };
  }

  return {
    outcome: OUTCOME.OK,
    name: 'OK',
    version,
    lines: [
      `${CLI_PACKAGE}@${version} installed from ${registry} (version from ${source})`,
      `all three bins reported ${version} and printed help: ${BINS.join(', ')}`,
      `the whole locked set is on the registry at ${version}`,
      `dist-tag "${distTag.expectedTag}" points at ${version}`,
    ],
  };
}

// Guarded so importing this module from the unit suite never runs the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const result = await smoke({ options });
  report(result.name, result.lines);
  process.exit(result.outcome);
}
