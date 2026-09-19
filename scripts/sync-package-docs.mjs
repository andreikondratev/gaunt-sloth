#!/usr/bin/env node
/**
 * Generates the repository docs' statements about the workspace packages, and fails when what is in
 * the docs disagrees with what the manifests and the release scripts say.
 *
 * `README.md`, `AGENTS.md`, `CONTRIBUTING.md` and `maintenance/RELEASE-HOWTO.md` each restated facts
 * that every `packages` manifest, `bump.mjs`, `publish-all.sh` and `tag-packages.sh` already own:
 * how many packages there are, which of them are version-locked, what depends on what, in which
 * order they publish, and which of them get git-tagged. Every one of those sentences was correct
 * when it was written, and most were wrong by the time this script read them. They go wrong the same
 * way every time — a package is added and the prose is not — so the remedy is not to correct the
 * sentences but to stop them being sentences anyone maintains.
 *
 * Three treatments, because the claims are not all the same kind of claim:
 *
 * - **Generated.** The package set, the version-locked split, the dependency edges and the by-hand
 *   `pack --dry-run` preview are facts the manifests state. They live between markers in the files
 *   {@link TARGETS} names and are written from here. `--write` injects them; the default checks them
 *   and exits non-zero on a disagreement.
 * - **Pointed at.** The publish order is declared exactly once, by `publish-all.sh`'s `ORDER` array,
 *   the tag set by `tag-packages.sh`'s `PACKAGES` array, and the version-locked set by `bump.mjs`. A
 *   runbook sentence that re-states any of them can disagree with it; one that points at it cannot.
 *   `CONTRIBUTING.md` and `maintenance/RELEASE-HOWTO.md` point, and {@link checkPointers} fails if a
 *   pointed-at declaration stops existing or stops covering every package — a pointer is only as
 *   good as the target still owning the fact.
 * - **Neither.** Prose that is not a manifest fact stays prose. This script does not police it.
 *
 * **A count of packages belongs inside a generated block or nowhere.** The runbook's post-outage
 * recovery caveat is the case that settles it: its job is to send a releaser to find out what
 * actually shipped, and any number there — even a correct one — is a list to trust instead of the
 * registry. Deleting the claim beats generating it wherever the right behaviour is to go and look.
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
 * - any file {@link TARGETS} does not name. Bringing one under this script is an entry there plus
 *   markers in the file. {@link checkMarkers} sweeps the repository's markdown so a marked block
 *   in a file nobody registered reads as an error rather than as generated text — otherwise it is
 *   unchecked prose wearing a marker that says it is generated, which is {@link locateBlock}'s
 *   duplicate-block problem one level up and gets likelier with every block added.
 * - a claim in one of the covered files that sits *outside* a marked block. The blocks are what is
 *   generated; prose around them is prose. Removing the counts from that prose, rather than
 *   checking them, is what keeps this boundary safe.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

/** The release runbook — the one of these documents a human follows by hand while shipping. */
const RUNBOOK = 'maintenance/RELEASE-HOWTO.md';

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
  {
    file: RUNBOOK,
    id: 'release-locked-packages',
    width: 98,
    render: renderRunbookLockedBlock,
  },
  // No width: this block is shell commands, not prose. See renderRunbookPackPreviewBlock.
  { file: RUNBOOK, id: 'release-pack-preview', render: renderRunbookPackPreviewBlock },
];

/**
 * Every directory a markdown sweep must not descend into: dependencies, build output, and the
 * rendered docs site, which copies marked blocks verbatim into its own pages.
 *
 * Dot-directories are skipped too, by name rather than by listing them. They hold tool state and
 * agent output, not documentation — and `.gsloth/` in particular is where `gth` writes its own
 * review transcripts, which quote a diff verbatim. Reviewing a change to a generated block would
 * otherwise write those markers into an ignored file and red this gate for the person running the
 * review. The cost is that the `.gsloth/` profile fixtures under `packages/app/integration-tests/`
 * are not swept either; they are fixtures, and a generated block does not live in one.
 */
const SWEEP_SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'docs-generated']);

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
  // Sorted, because `readdirSync` returns filesystem order: on ext4 that is a per-directory hash
  // order, so an unsorted enumeration can render one block here and a differently-ordered one in
  // CI, which reds a check for a reason nobody can see in the diff.
  const dirs = readdirSync(packagesDir)
    .filter((dir) => existsSync(join(packagesDir, dir, 'package.json')))
    .sort();
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

/**
 * The git-tagged set, read from the array that is it. `maintenance/RELEASE-HOWTO.md` used to
 * enumerate this list and had fallen three names behind it, so the prose now points here instead —
 * which only helps while this array still exists and still holds the whole set.
 */
function taggedDirs() {
  const source = readText('tag-packages.sh');
  const packages = source.match(/^PACKAGES=\(([^)]*)\)/m);
  if (!packages) {
    throw new Error(
      'could not read the PACKAGES array out of tag-packages.sh. maintenance/RELEASE-HOWTO.md ' +
        'points at it for which packages get tagged instead of re-stating them, so this script ' +
        'has to be able to find it — re-point this regex at wherever the array moved.'
    );
  }
  return packages[1].split(/\s+/).filter(Boolean);
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
 * A declaration a document defers to instead of re-stating: it has to still cover every package,
 * or the prose pointing at it has quietly become wrong in the one direction that matters — a
 * package nobody publishes, tags, or previews.
 */
function checkCoverage(what, declaredDirs, packageDirs, consequence, results) {
  const missing = packageDirs.filter((dir) => !declaredDirs.includes(dir));
  const unknown = declaredDirs.filter((dir) => !packageDirs.includes(dir));
  if (missing.length === 0 && unknown.length === 0) {
    results.push({ ok: true, what, detail: `${declaredDirs.length} packages` });
    return;
  }
  results.push({
    ok: false,
    what,
    detail: [
      missing.length > 0 ? `in packages/ but not declared: ${missing.join(', ')}` : '',
      unknown.length > 0 ? `declared but not in packages/: ${unknown.join(', ')}` : '',
      consequence,
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

/** A document still names the declarations it defers to, so its pointers still point somewhere. */
function checkPointerFile(file, names, consequence, results) {
  const text = readText(file);
  const lost = names.filter((name) => !text.includes(name));
  results.push({
    ok: lost.length === 0,
    what: `${file} points at the release scripts rather than re-stating them`,
    detail:
      lost.length === 0
        ? `names ${andList(names)}`
        : `${file} no longer names ${andList(lost)}. ${consequence}`,
  });
}

/**
 * The runbook's version block: which packages move together, which do not, and the directory the
 * fat CLI lives in — the three things a releaser reading it by hand needs and the three that were
 * each a name short.
 */
function renderRunbookLockedBlock({ packages, locked, independent }, width) {
  const code = (names) => names.map((name) => `\`${name}\``);
  const scoped = locked.filter((pkg) => pkg.name.startsWith('@gaunt-sloth/'));
  const unscoped = locked.filter((pkg) => !pkg.name.startsWith('@gaunt-sloth/'));

  const opening = wrap(
    `${numberWord(locked.length)[0].toUpperCase()}${numberWord(locked.length).slice(1)} of the ` +
      `${numberWord(packages.length)} packages release in lockstep at one version:`,
    width
  );

  const bullets = [];
  if (scoped.length > 0) {
    bullets.push(
      wrap(
        `- ${
          scoped.length === 1 ? 'the scoped library' : 'the scoped libraries'
        } ${andList(code(scoped.map((pkg) => pkg.name)))}${unscoped.length > 0 ? ', and' : '.'}`,
        width,
        '  '
      )
    );
  }
  for (const pkg of unscoped) {
    bullets.push(
      wrap(
        `- \`${pkg.name}\` — the fat user-facing CLI, whose package name and directory differ ` +
          `(dir \`packages/${pkg.dir}\`).`,
        width,
        '  '
      )
    );
  }

  const rest =
    independent.length > 0
      ? wrap(
          `${andList(code(independent.map((pkg) => pkg.name)))} ${
            independent.length === 1 ? 'is' : 'are'
          } versioned on ${
            independent.length === 1 ? 'its' : 'their'
          } own track, bumped by hand, and deliberately outside that set — ` +
            'published and git-tagged alongside it, at their own versions.',
          width
        )
      : '';

  return [opening, '', ...bullets, ...(rest === '' ? [] : ['', rest])].join('\n');
}

/**
 * The by-hand `pack --dry-run` preview, one line per package.
 *
 * This is the step whose whole purpose is eyeballing what a tarball will contain, so a preview that
 * omits a package is a package nobody ever looks at before it ships — which is what a hand-kept
 * list of these lines had become. Ordered by `publish-all.sh`'s `ORDER` so the preview reads in the
 * order the release ships, but driven off the package set rather than off `ORDER`, so it covers
 * every package even while `ORDER` is the thing that is wrong. {@link checkPointers} reports that
 * separately; this block must not also collapse, or one defect would read as two.
 *
 * It takes no wrap width, unlike every other renderer: these are shell commands in a fenced block,
 * and one wrapped across two lines is one a releaser cannot paste.
 */
function renderRunbookPackPreviewBlock({ packages }) {
  const order = publishOrderDirs();
  const rank = (pkg) => {
    const index = order.indexOf(pkg.dir);
    return index === -1 ? order.length : index;
  };
  const sorted = [...packages].sort((a, b) => rank(a) - rank(b) || (a.dir < b.dir ? -1 : 1));
  return [
    '```bash',
    ...sorted.map((pkg) => `pnpm --filter ${pkg.name} pack --dry-run`),
    '```',
  ].join('\n');
}

/**
 * The claims `CONTRIBUTING.md` and the release runbook make by pointing rather than by re-stating.
 * A pointer cannot disagree with its target, but it can outlive it, so what is checked here is that
 * the target still exists and still owns the whole fact.
 */
function checkPointers({ packages }, results) {
  const packageDirs = packages.map((pkg) => pkg.dir).sort();
  checkCoverage(
    "publish-all.sh's ORDER covers every package",
    publishOrderDirs(),
    packageDirs,
    'CONTRIBUTING.md and the release runbook tell a releaser that ORDER is the publish order, so ' +
      'a package missing from it is a package that silently never ships.',
    results
  );
  checkCoverage(
    "tag-packages.sh's PACKAGES covers every package",
    taggedDirs(),
    packageDirs,
    'The release runbook tells a releaser that this array is what gets tagged, so a package ' +
      'missing from it ships with no git tag and nobody verifying the release notices.',
    results
  );

  checkPointerFile(
    'CONTRIBUTING.md',
    ['publish-all.sh', 'bump.mjs'],
    'Its release section defers to those scripts for the publish order and the version-locked ' +
      'set; without the pointer the reader is back to a list in prose that nothing checks.',
    results
  );
  checkPointerFile(
    RUNBOOK,
    ['publish-all.sh', 'tag-packages.sh'],
    'It defers to those scripts for the publish order and the tagged set; without the pointer a ' +
      'releaser working by hand is back to a list in prose that nothing checks.',
    results
  );
}

/** Every markdown file under `dir`, sorted, skipping the trees a generated block never lives in. */
function markdownFiles(dir, relative = '') {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    if (SWEEP_SKIP.has(entry.name)) continue;
    if (entry.isDirectory() && entry.name.startsWith('.')) continue;
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...markdownFiles(join(dir, entry.name), path));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

/**
 * Every marked block in the repository is one {@link TARGETS} knows about.
 *
 * {@link locateBlock} can only check the blocks it is pointed at. A `BEGIN GENERATED` pair in a
 * file nobody registered — a section copied into a new document, a `TARGETS` entry deleted while
 * the markers stayed — is text that reads as generated to every human and is checked by nothing.
 * That is the duplicate-block failure one level up, and each block added makes it likelier.
 */
function checkMarkers(results) {
  const registered = new Map();
  for (const target of TARGETS) {
    if (!registered.has(target.file)) registered.set(target.file, new Set());
    registered.get(target.file).add(target.id);
  }
  const pattern = /<!--\s*(?:BEGIN|END)\s+GENERATED\s+([^\s>]+)\s*-->/g;
  // A set, so one unregistered block reports once rather than twice — it has two markers, and a
  // doubled line reads as a bug in the checker at the moment someone is trusting it.
  const orphans = new Set();
  let seen = 0;
  for (const file of markdownFiles(repoRoot)) {
    const text = readText(file);
    for (const match of text.matchAll(pattern)) {
      seen++;
      if (!registered.get(file)?.has(match[1])) orphans.add(`${file} — "${match[1]}"`);
    }
  }
  // Anti-vacuity: every TARGETS entry has two markers, so a sweep that found fewer read nothing.
  if (seen < TARGETS.length * 2) {
    results.push({
      ok: false,
      what: 'every generated block in the repository is one this script maintains',
      detail:
        `the sweep found ${seen} markers, fewer than the ${TARGETS.length * 2} TARGETS alone ` +
        'requires — it is the sweep that is broken, not the documents.',
    });
    return;
  }
  results.push({
    ok: orphans.size === 0,
    what: 'every generated block in the repository is one this script maintains',
    detail:
      orphans.size === 0
        ? `${seen} markers, all registered in TARGETS`
        : `${[...orphans].join('\n')}\nA marked block this script does not maintain is unchecked ` +
          'prose under a marker claiming it is generated. Add it to TARGETS, or remove the ' +
          'markers and let it be prose.',
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
  checkMarkers(results);

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
