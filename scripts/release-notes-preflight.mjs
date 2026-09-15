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
// CLI:
//   node scripts/release-notes-preflight.mjs [--version <v>] [--dir <notes dir>]
//                                            [--package-json <path>]
// Prints a summary on stdout, emits a `::warning` workflow command when the notes are missing, and
// — when GITHUB_STEP_SUMMARY is set — appends a markdown block to the job summary. Exits 0 always.

import { appendFileSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
 * The whole decision: does the version about to ship have notes, and what should be said about it.
 *
 * `annotation` and `summary` are undefined on the OK path — that is the control OPS-123 asks for,
 * and it is a property of this function rather than of the shell that calls it. `confirmation` is
 * present on both paths so a broken mechanism is distinguishable from a clean release.
 *
 * @param {string} version the version that would ship
 * @param {string} [notesDir]
 * @returns {{ version: string, notesMissing: boolean, notesPath: string | undefined,
 *   expectedPath: string, expectedDisplay: string, annotation: string | undefined,
 *   summary: string | undefined, confirmation: string }}
 */
export function releaseNotesPreflight(version, notesDir = DEFAULT_NOTES_DIR) {
  const { notesPath, notesMissing } = releaseNotesFor(version, notesDir);
  const expectedPath = join(notesDir, notesFileName(version));
  const expectedDisplay = displayPath(expectedPath);

  if (!notesMissing) {
    return {
      version,
      notesMissing: false,
      notesPath,
      expectedPath,
      expectedDisplay,
      annotation: undefined,
      summary: undefined,
      confirmation:
        `Release notes preflight: ${version} will publish with the body in ` +
        `${displayPath(/** @type {string} */ (notesPath))}.`,
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
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        result.summary ??
          `## Release notes preflight\n\n${result.confirmation}\n\n` +
            `No action needed — this line is here so a run page showing neither this nor a ` +
            `warning means the preflight itself did not run.\n`,
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
