#!/usr/bin/env node
// OPS-123 — tell the dispatcher, BEFORE anything is tagged or published, that the release about to
// go out has no notes file and will therefore ship a blank GitHub Release body.
//
// WHAT WENT WRONG WITHOUT IT. OPS-99 ruled that a version nobody wrote notes for ships a BLANK
// body rather than a synthesised list of merged pull requests, because such a list here describes
// whatever happened to arrive as a PR and not the release. That ruling stands and nothing here
// reopens it. What it left behind is silence: both arms of the "Create GitHub Release" step succeed
// identically, so a release dispatched without notes is indistinguishable, from inside the pipeline
// and from the dispatcher's console, from one dispatched with them. Three of four betas shipped
// empty before anyone noticed.
//
// THIS WARNS, IT NEVER BLOCKS. Failing a release on a missing prose file would let a documentation
// omission stop a shipping fix, which is worse than a blank body. Every path here exits 0 — there
// is no `process.exit(<non-zero>)` and no uncaught throw, including on a notes directory that does
// not exist or a package.json that will not parse. The workflow step carries `continue-on-error:
// true` on top of that, and nothing in the workflow consumes this step: it has no `id:`, so no
// later `if:`, `needs:` or output expression can grow a dependency on it and quietly turn the
// advisory into a gate.
//
// THE COST OF FAILING OPEN, AND WHAT PAYS FOR IT. Belt-and-braces non-failure means a mechanism
// that breaks produces silence, which is the exact "nobody finds out" shape this script exists to
// fix. Two things answer that. The crash path is unit-tested rather than merely swallowed
// (packages/core/spec/releaseNotesPreflight.spec.ts drives an absent notes directory and an
// unreadable package.json and asserts exit 0 with a diagnostic). And the OK path is NOT silent: it
// writes a one-line confirmation naming the file it found to the job summary, so the run page shows
// either the warning or the confirmation, and shows NOTHING only when the mechanism itself is
// broken. The confirmation is deliberately not a warning — a warning that fires on every release is
// one nobody reads, which is the control OPS-123 demands.
//
// THE DECISION IS HERE, NOT INLINE IN THE YAML, for the reason scripts/release-notes-for.mjs gives
// for the same split: this runs only during a real release dispatch, so inline bash could be
// verified only by shipping a broken release, while a script is covered by the ordinary unit suite.
// The workflow's own spec (packages/core/spec/releaseNotesWiredIntoRelease.spec.ts) asserts only
// that the job INVOKES this script; whether the warning actually fires is proven by running it.
// Asserting the warning's text against the YAML would be an assertion that cannot fail — it would
// pass whenever the string is present, whatever the job would do.
//
// NO dependencies beyond node: builtins, and no workspace install in the job that runs it. The
// `validate-inputs` job checks out and calls `node` directly; anything else would add a moving part
// to the pipeline's fail-fast gate whose outage could block a release.
//
// THE VERSION IS READ FROM packages/core/package.json — the same file release.yml's "Read CURRENT
// version to ship" step reads. The dispatch inputs (bump / preid / explicit_version) describe the
// POST-bump and say nothing about what ships now, so the version whose notes to check is knowable
// at validate-inputs time from the checked-out repo, with nothing computed. If those two ever read
// different files this check would preflight a version other than the one that ships; the wiring
// spec pins both.
//
// THE SECOND FINDING: A LINK THAT DIES ON PUBLICATION (OPS-147). A Release body is rendered by
// GitHub against the REPOSITORY ROOT, not against release-notes/, and the URL it builds is
// `/<owner>/<repo>/blob/` + the link. A valid blob URL is `/<owner>/<repo>/blob/<ref>/<path>`, so
// the link's FIRST SEGMENT lands in the position the ref occupies: `../docs/COMMANDS.md` becomes
// `blob/docs/COMMANDS.md`, read as ref `docs` and path `COMMANDS.md`, and no branch called `docs`
// exists — 404. The `..` is not what breaks it; `docs/COMMANDS.md` with no `..` at all produces the
// identical URL. That is why the check below allow-lists absolute targets rather than denying `..`:
// a check keyed on `..` blesses the second form, and the failure is silent in the worst direction,
// because the link renders, is clickable, and looks right in the source and in every editor preview.
//
// It warns on the SAME footing as the missing-notes finding and for the same reason — a link-shape
// complaint must not stop a shipping fix — but it is reported in its own field, so the OPS-123
// control that the notes-present path raises no missing-notes annotation keeps saying what it says.
// It checks link SHAPE and never resolves a URL: the suggested form pins the release's own tag,
// which this dispatch has not created yet, so a link that is correct 404s until the release is cut.
//
// CLI:
//   node scripts/release-notes-preflight.mjs [--version <v>] [--dir <notes dir>]
//                                            [--package-json <path>]
// Prints a summary on stdout, emits a `::warning` workflow command when the notes are missing or
// carry a link that will not survive publication, and — when GITHUB_STEP_SUMMARY is set — appends a
// markdown block to the job summary. Exits 0 always.

import { appendFileSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_NOTES_DIR, notesFileName, releaseNotesFor } from './release-notes-for.mjs';

/** The repo root, one level up from scripts/. */
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * The package.json the release job reads the shipping version out of. Kept identical to
 * release.yml's `require('./packages/core/package.json').version`, deliberately: this check is
 * worthless if it preflights a version other than the one that ships.
 */
export const DEFAULT_CORE_PACKAGE_JSON = join(REPO_ROOT, 'packages', 'core', 'package.json');

/** The workflow-command annotation title, and the heading the job summary opens with. */
export const WARNING_TITLE = 'Release notes missing';

/** The annotation title for the link finding. Distinct, so the two are told apart at a glance. */
export const LINK_WARNING_TITLE = 'Release notes link check';

/** The directory name a notes link is resolved against when naming its absolute form. */
const NOTES_DIR_NAME = 'release-notes';

/**
 * Would this markdown link target survive publication as part of a GitHub Release body?
 *
 * An ALLOW-LIST of absolute forms, deliberately, rather than a deny-list on `..`. Both
 * `../docs/X.md` and `docs/X.md` render as `blob/docs/X.md` — the leading segment is consumed by
 * the ref position either way — so a rule that looks for `..` passes the second form and blesses
 * the next broken link. Anything carrying a URI scheme (`https:`, `mailto:`) or protocol-relative
 * is absolute and fine.
 *
 * A bare fragment (`#section`) is left alone: it addresses the Release body itself, which is a
 * different question from this one and not one this check can answer.
 * @param {string} target
 * @returns {boolean}
 */
export function isAbsoluteLinkTarget(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#');
}

/**
 * Every inline markdown link in `text` whose target will not survive publication, with the
 * 1-based line it sits on.
 *
 * Fenced code blocks are skipped — a link written out as an EXAMPLE is not a link. The scan is
 * line-by-line and the pattern holds no nested quantifier, so it cannot backtrack catastrophically
 * on a long line.
 *
 * NOT matched, and neither appears in this directory today: reference-style definitions
 * (`[label]: ../docs/X.md`) and raw HTML anchors. Both break identically; extend this if either is
 * ever used here.
 * @param {string} text
 * @returns {Array<{ line: number, target: string }>}
 */
export function relativeLinksIn(text) {
  /** @type {Array<{ line: number, target: string }>} */
  const found = [];
  const lines = String(text ?? '').split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const pattern = /\[[^\]\n]*\]\(([^)\s]*)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const target = match[1];
      if (target && !isAbsoluteLinkTarget(target)) found.push({ line: i + 1, target });
    }
  }
  return found;
}

/**
 * The repository's web URL, read off the same manifest the version comes from so an organisation
 * rename cannot leave a hardcoded owner behind.
 *
 * Returns undefined rather than throwing on anything unexpected: a warning that can still name the
 * file and the offending link is worth more than a check that died computing a suggestion.
 * @param {string} [packageJsonPath]
 * @returns {string | undefined}
 */
export function repoWebUrl(packageJsonPath = DEFAULT_CORE_PACKAGE_JSON) {
  try {
    const { repository } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const url = typeof repository === 'string' ? repository : repository?.url;
    if (typeof url !== 'string') return undefined;
    const web = url.replace(/^git\+/, '').replace(/\.git$/, '');
    return /^https:\/\/[^\s/]+\/\S+$/.test(web) ? web : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The absolute URL a relative notes link was reaching for: the target resolved against
 * `release-notes/` and pinned to the tag this release will create.
 *
 * TAG-PINNED, not `main`. A Release page is a permanent record of one version, so its links should
 * address the tree that version shipped — and a tag is immutable, so a URL verified once stays
 * correct, where a `main` URL decays silently the day a doc is renamed. The consequence, which the
 * howto states: the tag does not exist until the release is cut, so a correct link 404s while the
 * notes are being written. That is why nothing here resolves the URL it suggests.
 *
 * The suggestion is the LITERAL resolution of the path as written, so a link whose path was already
 * wrong yields a URL that is absolute and still wrong — `docs/X.md` inside release-notes/ means
 * `release-notes/docs/X.md`, and seeing that spelled out is usually how the author notices. This
 * check tests SHAPE; it cannot tell you the target exists.
 * @param {string} target the relative link target as written
 * @param {string} version the version about to ship
 * @param {string | undefined} base the repository web URL
 * @returns {string | undefined} undefined when there is no base, or the target escapes the repo
 */
export function absoluteFormFor(target, version, base) {
  if (!base) return undefined;
  const hash = target.indexOf('#');
  const path = hash === -1 ? target : target.slice(0, hash);
  const fragment = hash === -1 ? '' : target.slice(hash);
  if (!path) return undefined;
  const resolved = posix.normalize(posix.join(NOTES_DIR_NAME, path));
  if (!resolved || resolved.startsWith('../')) return undefined;
  return `${base}/blob/v${version}/${resolved}${fragment}`;
}

/**
 * The path to NAME to a human: repo-relative with forward slashes when the file is under the repo,
 * otherwise the path as joined.
 *
 * A dispatcher can act on `release-notes/v2_0_0-beta_13.md`; the absolute path a GitHub runner
 * joins (`/home/runner/work/gaunt-sloth/gaunt-sloth/release-notes/...`) names a directory that no
 * longer exists by the time anyone reads the annotation. Forward slashes unconditionally, so the
 * text is the same on every platform and a spec can assert it without a win32 special case.
 * @param {string} path
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function displayPath(path, repoRoot = REPO_ROOT) {
  const rel = relative(repoRoot, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return path;
  return rel.split(sep).join('/');
}

/**
 * Escape a value for the DATA half of a GitHub Actions workflow command.
 *
 * A `::warning::` command is terminated by a newline, so an unescaped one in the message would
 * truncate the annotation and spill the rest into the log as ordinary text — the annotation would
 * still appear, saying less than it was asked to, which is the quiet kind of wrong.
 * @param {string} value
 * @returns {string}
 */
export function escapeData(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * The version this dispatch would ship.
 *
 * @param {string} [packageJsonPath]
 * @returns {string} the `version` field
 * @throws when the file is absent or unparseable, or carries no version — callers in the CLI catch
 *   it, because a release must not be blocked by this check failing to run.
 */
export function versionToShip(packageJsonPath = DEFAULT_CORE_PACKAGE_JSON) {
  const version = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
  if (!version || typeof version !== 'string') {
    throw new Error(`no version field in ${packageJsonPath}`);
  }
  return version;
}

/**
 * The annotation and job-summary block for links that will not survive publication.
 *
 * Both name the file, every offending link with its line, and the absolute form it should have had.
 * A warning a reader cannot act on without opening this script is barely better than no warning.
 * @param {string} notesPath
 * @param {string} version
 * @param {Array<{ line: number, target: string }>} relativeLinks
 * @param {string | undefined} base the repository web URL
 * @returns {{ annotation: string, summary: string }}
 */
function linkFinding(notesPath, version, relativeLinks, base) {
  const where = displayPath(notesPath);
  const count = relativeLinks.length;
  const plural = count === 1 ? '' : 's';
  const suggest = (/** @type {{ line: number, target: string }} */ link) =>
    absoluteFormFor(link.target, version, base);

  const detail = relativeLinks
    .map((link) => {
      const fixed = suggest(link);
      return `line ${link.line}: ${link.target}${fixed ? ` -> ${fixed}` : ''}`;
    })
    .join('; ');

  const message =
    `${where} has ${count} relative link${plural} that will be DEAD on the published Release ` +
    `page. GitHub resolves a Release body's link against the repository root and builds ` +
    `/<owner>/<repo>/blob/ + the link, so the link's first segment lands where the ref belongs: ` +
    `"../docs/X.md" and "docs/X.md" both become blob/docs/X.md, naming a branch called "docs" ` +
    `that does not exist. Write a full https:// URL pinned to this release's tag. ${detail}. ` +
    `This does NOT block the release — but the Release body is a stored copy, so once it is ` +
    `published, fixing the file here does not repair the page.`;

  const bullets = relativeLinks
    .map((link) => {
      const fixed = suggest(link);
      return `- **Line ${link.line}:** \`${link.target}\`${fixed ? ` → \`${fixed}\`` : ''}`;
    })
    .join('\n');

  return {
    annotation: `::warning title=${LINK_WARNING_TITLE}::${escapeData(message)}`,
    summary:
      `## ⚠️ ${LINK_WARNING_TITLE} — ${count} link${plural} will be dead on the Release page\n\n` +
      `In \`${where}\`:\n\n${bullets}\n\n` +
      `- **Why:** GitHub builds a Release body's link as \`/<owner>/<repo>/blob/\` + the link, and ` +
      `a valid blob URL is \`/<owner>/<repo>/blob/<ref>/<path>\`. The link's first segment is ` +
      `therefore read as the **ref**: \`../docs/X.md\` and \`docs/X.md\` alike become ` +
      `\`blob/docs/X.md\`, a branch named \`docs\`. Dropping the \`..\` does not fix it.\n` +
      `- **The suggested tag does not exist yet.** This dispatch creates it, so the corrected link ` +
      `404s until the release is cut and resolves from then on. Do not "fix" it to \`main\`.\n` +
      `- **This does not block the release.** A link-shape complaint must not stop a shipping fix. ` +
      `But the body is stored at publication, so a link left broken stays broken on that page.\n`,
  };
}

/**
 * The whole decision: does the version about to ship have notes, and what should be said about it.
 *
 * `annotation` and `summary` are undefined on the OK path — that is the control OPS-123 asks for,
 * and it is a property of this function rather than of the shell that calls it. `confirmation` is
 * present on both paths so a broken mechanism is distinguishable from a clean release.
 *
 * @param {string} version the version that would ship
 * @param {string} [notesDir]
 * @param {{ repoUrl?: string | undefined }} [options] `repoUrl` overrides the repository web URL
 *   the suggested absolute links are built from; specs pin it so they do not assert against this
 *   repository's own manifest.
 * @returns {{ version: string, notesMissing: boolean, notesPath: string | undefined,
 *   expectedPath: string, expectedDisplay: string, annotation: string | undefined,
 *   summary: string | undefined, confirmation: string,
 *   relativeLinks: Array<{ line: number, target: string }>,
 *   linkAnnotation: string | undefined, linkSummary: string | undefined }}
 */
export function releaseNotesPreflight(version, notesDir = DEFAULT_NOTES_DIR, options = {}) {
  const { notesPath, notesMissing } = releaseNotesFor(version, notesDir);
  const expectedPath = join(notesDir, notesFileName(version));
  const expectedDisplay = displayPath(expectedPath);

  if (!notesMissing) {
    const found = /** @type {string} */ (notesPath);
    // The WHOLE file, not the body `releaseNotesFor` returns: the body has the H1 removed, so its
    // line numbers would not be the ones in the file a dispatcher opens, and an unactionable line
    // number is worse than none.
    const relativeLinks = relativeLinksIn(readFileSync(found, 'utf8'));
    const base = options.repoUrl ?? repoWebUrl();
    const finding = relativeLinks.length
      ? linkFinding(found, version, relativeLinks, base)
      : { annotation: undefined, summary: undefined };
    return {
      version,
      notesMissing: false,
      notesPath,
      expectedPath,
      expectedDisplay,
      annotation: undefined,
      summary: undefined,
      confirmation: `Release notes preflight: ${version} will publish with the body in ${displayPath(found)}.`,
      relativeLinks,
      linkAnnotation: finding.annotation,
      linkSummary: finding.summary,
    };
  }

  const message =
    `No release notes file for ${version} — looked for ${expectedDisplay}. This release will ` +
    `publish with an EMPTY GitHub Release body. It does NOT block the release: write the file ` +
    `and re-dispatch, or ship blank deliberately. The name is "v" + the version with every dot ` +
    `replaced by an underscore, + ".md" — a file named anything else is not found.`;

  return {
    version,
    notesMissing: true,
    notesPath: undefined,
    expectedPath,
    expectedDisplay,
    annotation: `::warning title=${WARNING_TITLE}::${escapeData(message)}`,
    summary:
      `## ⚠️ ${WARNING_TITLE} — this release would ship a blank body\n\n` +
      `Nothing was found for version \`${version}\`.\n\n` +
      `- **Looked for:** \`${expectedDisplay}\`\n` +
      `- **Naming rule:** \`v\` + the version with every dot replaced by an underscore, + \`.md\`. ` +
      `A file named anything else is not found, and the only sign of it is an empty Release page.\n` +
      `- **This does not block the release.** A missing prose file must not stop a shipping fix. ` +
      `Cancel and write \`${expectedDisplay}\` if the notes were simply forgotten; carry on if the ` +
      `blank body is deliberate.\n`,
    confirmation: message,
    // There is no file, so there is nothing to check the links of. The two findings are mutually
    // exclusive by construction, not by accident.
    relativeLinks: [],
    linkAnnotation: undefined,
    linkSummary: undefined,
  };
}

// CLI.
// Guarded so importing this module (e.g. from the vitest spec) never runs it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // One line, because it is quoted into a workflow-command annotation below, where a newline
  // terminates the command and would truncate the message.
  const usage =
    'usage: release-notes-preflight.mjs [--version <v>] [--dir <notes dir>] ' +
    '[--package-json <path>]';
  try {
    const args = process.argv.slice(2);
    let version;
    let notesDir = DEFAULT_NOTES_DIR;
    let packageJsonPath = DEFAULT_CORE_PACKAGE_JSON;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--version') version = args[++i];
      else if (args[i] === '--dir') notesDir = args[++i];
      else if (args[i] === '--package-json') packageJsonPath = args[++i];
      else throw new Error(`unknown argument: ${args[i]} (${usage})`);
    }

    const result = releaseNotesPreflight(version ?? versionToShip(packageJsonPath), notesDir);
    process.stdout.write(`${result.confirmation}\n`);
    if (result.annotation) process.stdout.write(`${result.annotation}\n`);
    if (result.linkAnnotation) process.stdout.write(`${result.linkAnnotation}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const block =
        result.summary ??
        `## Release notes preflight\n\n${result.confirmation}\n\n` +
          `No action needed — this line is here so a run page showing neither this nor a ` +
          `warning means the preflight itself did not run.\n`;
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        result.linkSummary ? `${block}\n${result.linkSummary}` : block,
        'utf8'
      );
    }
  } catch (error) {
    // Deliberately terminal: this check must never be the reason a release does not ship. The
    // diagnostic is a `::notice`, not a `::warning`, so it cannot be mistaken for the missing-notes
    // finding — it says the check did not run, not that the notes are absent.
    const reason = error instanceof Error ? error.message : String(error);
    process.stdout.write(`Release notes preflight could not run: ${reason}\n`);
    process.stdout.write(
      `::notice title=Release notes preflight skipped::${escapeData(reason)} — the release is ` +
        `unaffected, but nothing checked whether it has notes. Check release-notes/ by hand.\n`
    );
  }
  // No exit code is set on any path, deliberately. See the docblock.
}
