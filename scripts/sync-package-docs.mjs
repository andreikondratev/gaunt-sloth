#!/usr/bin/env node
/**
 * Generates the repository docs' statements about the workspace packages, and fails when what is in
 * the docs disagrees with what the manifests and the release scripts say.
 *
 * OPS-70 — `README.md`, `AGENTS.md` and `CONTRIBUTING.md` each restated facts that
 * every `packages` manifest, `bump.mjs` and `publish-all.sh` already own: how many packages there
 * are, which of them are version-locked, what depends on what, and in which order they publish.
 * Every one of those sentences was correct when it was written, and three of them were wrong by the
 * time this script was. They go wrong the same way every time — a package is added and the prose is
 * not — so the remedy is not to correct the sentences but to stop them being sentences anyone
 * maintains.
 *
 * Three treatments, because the claims are not all the same kind of claim:
 *
 * - **Generated.** The package set, the version-locked split and the dependency edges are facts the
 *   manifests state. They live between markers in `README.md` and `AGENTS.md` and are written from
 *   here. `--write` injects them; the default checks them and exits non-zero on a disagreement.
 * - **Pointed at.** The publish order is declared exactly once, by `publish-all.sh`'s `ORDER` array,
 *   and the version-locked set by `bump.mjs`. A runbook sentence that re-states either can disagree
 *   with it; one that points at it cannot. `CONTRIBUTING.md` points, and {@link checkPointers}
 *   fails if the pointed-at declarations stop existing or stop covering every package — a pointer is
 *   only as good as the target still owning the fact.
 * - **Neither.** Prose that is not a manifest fact stays prose. This script does not police it.
 *
 * **Why the locked set is read out of `bump.mjs` and only corroborated against the versions.**
 * Carrying core's version is a *consequence* of being version-locked, not the definition: two
 * packages can match by coincidence, and a coincidence would silently flip the docs. `bump.mjs`'s
 * `SYNCED` + `APP_DIR` are the code that *makes* a package locked, so they are the source, and
 * "every package that code syncs really does carry core's version" is then a check that can fail —
 * after a hand-edited `package.json`, which is exactly the case worth catching.
 *
 * `bump.mjs` is read as text rather than imported: it is a script, not a module — importing it runs
 * an argv parse, a `process.exit` path and a rewrite of every locked `package.json`. Lifting the two
 * constants into a shared module would be cleaner and is deliberately not done here: it edits the
 * release path for a docs gate's convenience. The regexes therefore throw when they fail to match,
 * because a silent parse failure would leave this script deriving a locked set from nothing.
 *
 * **What this does not cover**, so the boundary is written down rather than assumed:
 *
 * - the Description column's *text*. Descriptions are editorial, so they live in
 *   {@link DESCRIPTIONS} rather than being derived. They are checked only in the ways that can
 *   actually fail: a package with no entry and an entry naming no package are both errors. Keeping
 *   them here instead of round-tripping them out of the README is the point — a generator that read
 *   the descriptions back out of the file it writes would be comparing those cells against
 *   themselves, an assertion that cannot fail, and would be idempotent by construction even when
 *   broken.
 * - whether `ORDER` is in a *valid* topological order. This checks that it covers every package;
 *   the ordering within it is the release scripts' business.
 * - any other file. `maintenance/RELEASE-HOWTO.md` restates several of these same facts and is
 *   wrong about them today; it is outside OPS-70's scope and is reported rather than edited. Adding
 *   it later is an entry in {@link TARGETS} plus markers in the file.
 * - a claim in one of the covered files that sits *outside* a marked block. The blocks are what is
 *   generated; prose around them is prose.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

/**
 * The Description column, and the order the packages are listed in — both editorial, both owned
 * here. A package in `packages/` with no entry is an error, and so is an entry naming no package,
 * so adding the eighth package cannot quietly produce a table that omits it.
 */
const DESCRIPTIONS = [
  [
    'gaunt-sloth',
    'Main CLI application (`packages/app`). Installs the `gsloth`/`gth` binaries. Most users only need this.',
  ],
  [
    '@gaunt-sloth/agent',
    'Agent runtime (`packages/agent`): AG-UI server, A2A client, MCP utilities, filesystem and custom tools, middleware registry.',
  ],
  [
    '@gaunt-sloth/review',
    'Review and Q&A modules (`packages/review`) with content sources (GitHub, Jira). Ships the `gaunt-sloth-review` binary for lightweight CI — no dependency on `commander`, MCP, or A2A.',
  ],
  [
    '@gaunt-sloth/core',
    'Config system, agent infrastructure, LLM provider wrappers, and shared utilities (`packages/core`).',
  ],
  [
    '@gaunt-sloth/batch',
    'Batch matrix runtime (`packages/batch`) behind `gth batch` and `gth eval`: runs a prompt-executable over a matrix of models and/or content-bound inputs. Ships the `gth-batch` binary and the `EvalReporter` contract reporters implement.',
  ],
  [
    '@gaunt-sloth/eval-reporter-junit',
    'JUnit XML (Ant-JUnit flavour) reporter for `gth eval` (`packages/eval-reporter-junit`). Ships with the CLI as the built-in `junit` reporter.',
  ],
  [
    '@gaunt-sloth/eval-reporter-teamcity',
    'Live TeamCity service-message reporter for `gth eval` (`packages/eval-reporter-teamcity`). Not bundled — install it and register it under [`reporters`](docs/configuration/output.md#custom-eval-reporters-reporters).',
  ],
];

/** Which generated block goes in which file, and how wide that file wraps its prose. */
const TARGETS = [
  { file: 'README.md', id: 'workspace-packages', width: 100, render: renderReadmeBlock },
  { file: 'AGENTS.md', id: 'locked-packages', width: 80, render: renderAgentsBlock },
];

const NUMBER_WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

/** A count as a word where English wants one — the stale count word is the defect this replaces. */
function numberWord(n) {
  return NUMBER_WORDS[n] ?? String(n);
}

function beginMarker(id) {
  return `<!-- BEGIN GENERATED ${id} -->`;
}

function endMarker(id) {
  return `<!-- END GENERATED ${id} -->`;
}

/**
 * The first thing inside every generated block, and part of what is compared — an editor who
 * removes the notice and edits the block by hand gets the same red as any other drift, rather than
 * a quietly hand-maintained block under a marker that says otherwise.
 */
const NOTICE = [
  '<!-- Written from packages/*/package.json by scripts/sync-package-docs.mjs. Do not edit between',
  '     the markers by hand: change a manifest, or that script, then run',
  '     node scripts/sync-package-docs.mjs --write -->',
].join('\n');

function readText(relative) {
  return readFileSync(join(repoRoot, relative), 'utf8');
}

/**
 * Greedy word wrap, so a regenerated paragraph keeps the file's own line width and a drift shows up
 * as the lines that actually changed. Greedy is deterministic, which is what makes `--write` twice
 * a no-op the second time.
 */
function wrap(text, width, hangingIndent = '') {
  const words = text.split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`;
    const limit = lines.length === 0 ? width : width - hangingIndent.length;
    if (line !== '' && candidate.length > limit) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : hangingIndent + l)).join('\n');
}

/** A list joined the way English joins one: `a`, `b` and `c`. */
function andList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Every package in `packages/`, with the manifest facts these docs state. */
function workspacePackages() {
  if (!existsSync(packagesDir)) {
    throw new Error(`${packagesDir} does not exist — this script must run from the repository.`);
  }
  const dirs = readdirSync(packagesDir).filter((dir) =>
    existsSync(join(packagesDir, dir, 'package.json'))
  );
  // Anti-vacuity: an enumeration that found nothing must not read as "nothing is wrong".
  if (dirs.length < 2) {
    throw new Error(
      `found ${dirs.length} package manifests under packages/ — the workspace has more than that, ` +
        'so the enumeration is broken rather than the docs.'
    );
  }
  const names = new Set();
  const packages = dirs.map((dir) => {
    const manifest = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'));
    names.add(manifest.name);
    return { dir, manifest, name: manifest.name, version: manifest.version };
  });
  const internal = (deps) =>
    Object.keys(deps ?? {})
      .filter((dep) => names.has(dep))
      .sort();
  for (const pkg of packages) {
    pkg.dependencies = internal(pkg.manifest.dependencies);
    pkg.peerDependencies = internal(pkg.manifest.peerDependencies);
  }
  return packages;
}

/**
 * The version-locked set, read from the script that creates it. `SYNCED` is the scoped libraries
 * and `APP_DIR` the fat CLI; both are matched strictly so a refactor that renames them stops this
 * script loudly instead of leaving it deriving the locked set from an empty match.
 */
function lockedDirsFromBump() {
  const source = readText('bump.mjs');
  const synced = source.match(/\bconst SYNCED = \[([^\]]*)\];/);
  const appDir = source.match(/\bconst APP_DIR = '([^']+)';/);
  if (!synced || !appDir) {
    throw new Error(
      'could not read SYNCED / APP_DIR out of bump.mjs. That script declares which packages are ' +
        'version-locked, and the docs state it — re-point this regex at wherever the set moved, ' +
        'rather than hard-coding the set here.'
    );
  }
  const dirs = [...synced[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (dirs.length === 0) {
    throw new Error('bump.mjs declares an empty SYNCED — nothing would read as version-locked.');
  }
  return [...dirs, appDir[1]];
}

/** The publish order, read from the array that is it. */
function publishOrderDirs() {
  const source = readText('publish-all.sh');
  const order = source.match(/^ORDER=\(([^)]*)\)/m);
  if (!order) {
    throw new Error(
      'could not read the ORDER array out of publish-all.sh. CONTRIBUTING.md points at it for the ' +
        'publish order instead of re-stating it, so this script has to be able to find it.'
    );
  }
  return order[1].split(/\s+/).filter(Boolean);
}

/** The whole model these docs describe, derived once. */
function facts() {
  const packages = workspacePackages();
  const lockedDirs = lockedDirsFromBump();
  const byDir = new Map(packages.map((pkg) => [pkg.dir, pkg]));
  const missing = lockedDirs.filter((dir) => !byDir.has(dir));
  if (missing.length > 0) {
    throw new Error(
      `bump.mjs syncs ${missing.join(', ')}, which is not a package under packages/. ` +
        'One of the two is wrong, and the docs cannot be right until they agree.'
    );
  }
  const locked = lockedDirs.map((dir) => byDir.get(dir));
  const independent = packages.filter((pkg) => !lockedDirs.includes(pkg.dir));
  return { packages, locked, independent, coreVersion: byDir.get('core')?.version };
}

/** The `README.md` block: the package table, the version lines, and the dependency edges. */
function renderReadmeBlock({ packages, locked, independent }, width) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const rows = DESCRIPTIONS.map(([name, description]) => `| \`${name}\` | ${description} |`);
  const code = (names) => names.map((name) => `\`${name}\``);

  const versionLines = wrap(
    `${andList(code(independent.map((pkg) => pkg.name)))} ${
      independent.length === 1 ? 'is an optional add-on' : 'are optional add-ons'
    } with their own release cadence, so they sit on a version line of their own. The other ` +
      `${numberWord(locked.length)} — ${andList(code(locked.map((pkg) => pkg.name)))} — are ` +
      'version-locked and released together.',
    width
  );

  const edges = DESCRIPTIONS.map(([name]) => {
    const pkg = byName.get(name);
    const runtime =
      pkg.dependencies.length > 0
        ? `depends on ${andList(code(pkg.dependencies))}`
        : 'depends on nothing in the workspace at runtime';
    const peers =
      pkg.peerDependencies.length > 0
        ? `, and takes ${andList(code(pkg.peerDependencies))} as ${
            pkg.peerDependencies.length === 1 ? 'a peer dependency' : 'peer dependencies'
          }`
        : '';
    return wrap(`- \`${name}\` ${runtime}${peers}.`, width, '  ');
  });

  return [
    '| Package | Description |',
    '|---|---|',
    ...rows,
    '',
    versionLines,
    '',
    'What each package declares as its in-workspace dependencies:',
    '',
    ...edges,
  ].join('\n');
}

/** The `AGENTS.md` block: which packages the release moves together, and which it does not. */
function renderAgentsBlock({ packages, locked, independent }, width) {
  const code = (names) => names.map((name) => `\`${name}\``);
  const scoped = locked.filter((pkg) => pkg.name.startsWith('@gaunt-sloth/'));
  const unscoped = locked.filter((pkg) => !pkg.name.startsWith('@gaunt-sloth/'));
  const scopedSet =
    scoped.length > 0
      ? `the scoped set \`@gaunt-sloth/{${scoped
          .map((pkg) => pkg.name.slice('@gaunt-sloth/'.length))
          .sort()
          .join(',')}}\``
      : '';
  const plusCli = unscoped
    .map((pkg) => `the fat \`${pkg.name}\` CLI (dir \`packages/${pkg.dir}\`)`)
    .join(' and ');
  const sets = [scopedSet, plusCli].filter(Boolean).join(' plus ');

  // Both counts, because "all five packages" reads as though the workspace held five.
  const count = `${numberWord(locked.length)} of the ${numberWord(packages.length)} packages`;
  const first = `${count[0].toUpperCase()}${count.slice(1)} are version-locked and released together — ${sets}.`;
  const second =
    independent.length > 0
      ? `The ${andList(code(independent.map((pkg) => pkg.name)))} ${
          independent.length === 1 ? 'plugin is' : 'plugins are'
        } versioned on their own track and are deliberately not part of that set.`
      : '';

  return wrap([first, second].filter(Boolean).join(' '), width);
}

/**
 * The claims `CONTRIBUTING.md` makes by pointing rather than by re-stating. A pointer cannot
 * disagree with its target, but it can outlive it, so what is checked here is that the target still
 * exists and still owns the whole fact.
 */
function checkPointers({ packages }, results) {
  const orderDirs = publishOrderDirs();
  const packageDirs = packages.map((pkg) => pkg.dir).sort();
  const missing = packageDirs.filter((dir) => !orderDirs.includes(dir));
  const unknown = orderDirs.filter((dir) => !packageDirs.includes(dir));
  if (missing.length > 0 || unknown.length > 0) {
    results.push({
      ok: false,
      what: "publish-all.sh's ORDER covers every package",
      detail: [
        missing.length > 0
          ? `never published: ${missing.join(', ')} — in packages/ but not in ORDER`
          : '',
        unknown.length > 0 ? `in ORDER but not in packages/: ${unknown.join(', ')}` : '',
        'CONTRIBUTING.md tells a releaser that ORDER is the publish order, so a package missing ' +
          'from it is a package that silently never ships.',
      ]
        .filter(Boolean)
        .join('\n'),
    });
  } else {
    results.push({
      ok: true,
      what: "publish-all.sh's ORDER covers every package",
      detail: `${orderDirs.length} packages, in ORDER's order`,
    });
  }

  const contributing = readText('CONTRIBUTING.md');
  const pointers = ['publish-all.sh', 'bump.mjs'].filter((name) => !contributing.includes(name));
  results.push({
    ok: pointers.length === 0,
    what: 'CONTRIBUTING.md points at the release scripts rather than re-stating them',
    detail:
      pointers.length === 0
        ? 'names publish-all.sh and bump.mjs'
        : `CONTRIBUTING.md no longer names ${pointers.join(' or ')}. Its release section defers ` +
          'to those scripts for the publish order and the version-locked set; without the ' +
          'pointer the reader is back to a list in prose that nothing checks.',
  });
}

/** The version-locked set really is locked — the corroboration, not the derivation. */
function checkLockedVersions({ locked, coreVersion }, results) {
  const drifted = locked.filter((pkg) => pkg.version !== coreVersion);
  results.push({
    ok: drifted.length === 0,
    what: 'every version-locked package carries core’s version',
    detail:
      drifted.length === 0
        ? `${locked.map((pkg) => pkg.dir).join(', ')} at ${coreVersion}`
        : `${drifted
            .map((pkg) => `${pkg.dir} at ${pkg.version}`)
            .join(', ')} — core is at ${coreVersion}. bump.mjs syncs these, so either a ` +
          'package.json was edited by hand or the set in bump.mjs is wrong.',
  });
}

/** Every package is described, and every description names a package. */
function checkDescriptions({ packages }, results) {
  const described = new Set(DESCRIPTIONS.map(([name]) => name));
  const undescribed = packages.filter((pkg) => !described.has(pkg.name)).map((pkg) => pkg.name);
  const names = new Set(packages.map((pkg) => pkg.name));
  const stale = [...described].filter((name) => !names.has(name));
  results.push({
    ok: undescribed.length === 0 && stale.length === 0,
    what: 'every workspace package has a description, and every description a package',
    detail:
      undescribed.length === 0 && stale.length === 0
        ? `${packages.length} packages`
        : [
            undescribed.length > 0
              ? `no description for ${undescribed.join(', ')} — add one to DESCRIPTIONS in ` +
                'scripts/sync-package-docs.mjs, which is also where the table order is decided'
              : '',
            stale.length > 0
              ? `DESCRIPTIONS names ${stale.join(', ')}, which is not a package`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
  });
}

/**
 * The markers and what is between them, or a loud failure — a missing block must not read as ok.
 *
 * The end marker is searched for **after** the begin marker, and the pair must occur **exactly
 * once**. Both matter, and the second one is not hypothetical: a duplicated block — a bad merge, a
 * copied section — leaves its second copy outside the span compared here, so it is unchecked prose
 * wearing a marker that says it is generated, and `--write` would rewrite only the first and leave
 * the two copies contradicting each other. Measured against this file before the guard existed: a
 * second copy carrying "The other four" passed.
 */
function locateBlock(text, id, file) {
  const begin = beginMarker(id);
  const end = endMarker(id);
  const from = text.indexOf(begin);
  const to = from === -1 ? -1 : text.indexOf(end, from + begin.length);
  if (from === -1 || to === -1) {
    throw new Error(
      `${file} has no "${id}" generated block. Both markers must be present, verbatim, and the ` +
        `end marker after the begin marker:\n${begin}\n${end}\n` +
        'Without them this check has nothing to compare and would pass about nothing.'
    );
  }
  if (
    text.indexOf(begin, from + begin.length) !== -1 ||
    text.indexOf(end, to + end.length) !== -1
  ) {
    throw new Error(
      `${file} has more than one "${id}" generated block. Only the first is checked and only the ` +
        'first is rewritten, so every later copy is unchecked text under a marker claiming it is ' +
        'generated. Delete the duplicates.'
    );
  }
  return { from, to: to + end.length, body: text.slice(from + begin.length, to).trim() };
}

function diffLines(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(expectedLines.length, actualLines.length); i++) {
    if (expectedLines[i] === actualLines[i]) continue;
    if (actualLines[i] !== undefined) out.push(`    in the file: ${actualLines[i]}`);
    if (expectedLines[i] !== undefined) out.push(`    manifests:   ${expectedLines[i]}`);
  }
  return out.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const unknown = args.filter((arg) => arg !== '--write' && arg !== '--check');
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}`);
    console.error('Usage: node scripts/sync-package-docs.mjs [--check | --write]');
    process.exitCode = 1;
    return;
  }

  const model = facts();
  const results = [];
  checkDescriptions(model, results);
  checkLockedVersions(model, results);
  checkPointers(model, results);

  // The derived facts have to be sound before a block is written from them: writing the docs out of
  // a model that already contradicts the release scripts would make the docs agree with this script
  // and with nothing else.
  const blocked = results.filter((result) => !result.ok);
  if (write && blocked.length > 0) {
    console.error('--- package docs checks ---');
    for (const result of results) {
      console.error(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.what}`);
      if (!result.ok) console.error(`      ${result.detail.replace(/\n/g, '\n      ')}`);
    }
    console.error('\nNothing written: fix the above first, or the generated blocks inherit it.');
    process.exitCode = 1;
    return;
  }

  for (const target of TARGETS) {
    const path = join(repoRoot, target.file);
    const text = readFileSync(path, 'utf8');
    const { from, to, body } = locateBlock(text, target.id, target.file);
    const expected = `${NOTICE}\n\n${target.render(model, target.width)}`;
    if (write) {
      const replacement = `${beginMarker(target.id)}\n\n${expected}\n\n${endMarker(target.id)}`;
      const updated = text.slice(0, from) + replacement + text.slice(to);
      if (updated !== text) writeFileSync(path, updated);
      results.push({
        ok: true,
        what: `${target.file} — ${target.id}`,
        detail: updated === text ? 'already up to date' : 'rewritten from the manifests',
      });
    } else {
      results.push({
        ok: body === expected,
        what: `${target.file}'s "${target.id}" block matches the manifests`,
        detail:
          body === expected
            ? `${expected.split('\n').length} lines`
            : `${diffLines(expected, body)}\n    Run "node scripts/sync-package-docs.mjs --write".`,
      });
    }
  }

  const failed = results.filter((result) => !result.ok);
  const out = failed.length > 0 ? console.error : console.log;
  out(`--- package docs ${write ? 'sync' : 'checks'} ---`);
  for (const result of results) {
    out(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.what}`);
    if (!result.ok || write) out(`      ${result.detail.replace(/\n/g, '\n      ')}`);
  }
  if (failed.length > 0) {
    out(
      `\n${failed.length} of ${results.length} package-docs checks failed. The docs state what the ` +
        'manifests and the release scripts declare; one of the two has moved.'
    );
    process.exitCode = 1;
    return;
  }
  out(`\nPackage docs ${write ? 'written' : 'check passed'}.`);
}

try {
  main();
} catch (error) {
  console.error(`Package docs check could not run: ${error.message}`);
  process.exitCode = 1;
}
