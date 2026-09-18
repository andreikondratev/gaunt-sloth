import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRepoFile, repoFiles, trackedRepoFiles } from '../../../scripts/repo-files.mjs';

/**
 * OPS-105 — a repository-wide gate gets its subject list from `scripts/repo-files.mjs`, and only
 * from there.
 *
 * A gate that asks git for tracked files alone is structurally blind to the file a change is
 * *adding*: an untracked file is not in that list, so the gate runs, finds nothing wrong, and
 * exits 0 about a set that excludes the very file most likely to carry a new defect. The
 * assertion is fine; the subject list is what cannot contain the failing case, which is why
 * auditing the gate finds nothing wrong with it.
 *
 * Fixing the gates that had this shape is not enough on its own, because the next gate somebody
 * writes reaches for the same obvious spelling. This file is the part that cannot be forgotten: it
 * reads every executable source file in the repository and fails naming any that spawns git for a
 * file list itself instead of calling `repoFiles()`. It runs under `pnpm test`, which is how this
 * repository's gates are actually invoked, so nothing has to be remembered or wired up twice.
 *
 * ## The sweep this node ran, and what it found
 *
 * Swept for `ls-files`, `ls-tree`, `git grep`, `--cached`, every spelling of a git subprocess
 * spawn, and every `git` string literal, across the whole repository. Three gates built a subject
 * list from git, all through the same call, and all three now go through `repoFiles()`:
 *
 * - `noRawControlBytes.spec.ts` (OPS-34) — widened to tracked plus untracked-not-ignored.
 * - `noUnlintedFiles.spec.ts` (OPS-31) — widened the same way.
 * - `lineEndingPolicy.spec.ts` (OPS-79) — widened for the shebang layers; its BINARY layer stays
 *   tracked-only on purpose, because it asks what `.gitattributes` has recorded for a path and an
 *   untracked file has no such rule and needs none.
 *
 * Left alone deliberately, with the reason:
 *
 * - `pnpmOverridesGate.spec.ts` already walks the filesystem rather than asking git, and its own
 *   docblock explains why, so it was never blind to an untracked manifest.
 * - `bump.mjs` passes git an explicit list of release files rather than enumerating a subject set,
 *   so there is no set for an untracked file to be missing from.
 * - `gitDiffSource.ts` and `debugDump.ts` are production code that reports a diff to a user. They
 *   are not gates and have no subject list.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Where the enumeration is allowed to live — the one place that may spawn git for a file list. */
const ENUMERATION_MODULE = 'scripts/repo-files.mjs';

/**
 * This file, which has to contain the spelling it forbids: its control test asserts the detector
 * fires on a real invocation, and a control written in anything but the real spelling would not be
 * a control. Derived from `import.meta.url` rather than written out, so renaming this file cannot
 * leave a stale literal behind that quietly exempts nothing — or, worse, exempts something else.
 */
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url))
  .split(sep)
  .join('/');

/** The only two files allowed to contain a git file-listing. Both are named above, with reasons. */
const ALLOWED = new Set([ENUMERATION_MODULE, SELF]);

/** Files that could plausibly run a command; a markdown mention of a command is not one. */
const EXECUTABLE_EXTENSION = /\.(?:js|cjs|mjs|ts|tsx|sh|ya?ml)$/;

/**
 * The detector: a git file-listing spawned as an argv token, or as a command string.
 *
 * It matches the *quoted* spellings only, which is deliberate. Every invocation of this kind in
 * this repository is written one of those two ways, and restricting the match to them is what lets
 * prose keep naming the command in backticks — as three docblocks here legitimately do — without
 * this gate reporting an explanation as a violation. The boundary is worth knowing: a command
 * assembled from pieces, or one interpolated at runtime, would slip past. `repoFiles()` is the
 * contract; this is what stops the contract being forgotten, not a parser for every way around it.
 */
const GIT_FILE_LISTING = [/(['"])ls-files\1/, /(['"])git ls-files/];

function spawnsItsOwnFileListing(source: string): boolean {
  return GIT_FILE_LISTING.some((pattern) => pattern.test(source));
}

describe('OPS-105 one enumeration for every repository-wide gate', () => {
  it('tells an invocation apart from a mention of one', () => {
    // Control: without this pair, a detector that never matched would let the repo-wide assertion
    // below pass while reading every file and finding nothing by construction.
    expect(spawnsItsOwnFileListing(`execFileSync('git', ['ls-files', '-z'])`)).toBe(true);
    expect(spawnsItsOwnFileListing(`execSync("git ls-files -z")`)).toBe(true);
    // The prose form, which must stay writable: a docblock naming the command in backticks.
    expect(spawnsItsOwnFileListing('The file list used to come from `git ls-files`.')).toBe(false);
    expect(spawnsItsOwnFileListing('const files = repoFiles(REPO_ROOT);')).toBe(false);
  });

  it('reads a plausible number of executable source files', () => {
    // Anti-vacuity: a failed git call, a wrong cwd or an extension regex that matched nothing
    // would leave the assertion below scanning an empty list and passing for that reason.
    const files = repoFiles(REPO_ROOT).filter((file) => EXECUTABLE_EXTENSION.test(file));
    expect(files.length).toBeGreaterThan(400);
    expect(files).toContain(ENUMERATION_MODULE);
    // If this drifted, the exemption below would be naming a file that is not this one.
    expect(files).toContain(SELF);
    // And the detector must actually fire on the one file that is supposed to contain it, or the
    // sweep below would be clean because it never found anything anywhere.
    const enumeration = readRepoFile(REPO_ROOT, ENUMERATION_MODULE);
    expect(enumeration).toBeDefined();
    expect(spawnsItsOwnFileListing(String(enumeration))).toBe(true);
  });

  it('no gate builds its own subject list from git', () => {
    let read = 0;
    const offenders = repoFiles(REPO_ROOT)
      .filter((file) => EXECUTABLE_EXTENSION.test(file) && !ALLOWED.has(file))
      .filter((file) => {
        const content = readRepoFile(REPO_ROOT, file);
        // `undefined` means an untracked file was deleted between the listing and this read; a
        // tracked one still throws. See readRepoFile's header.
        if (content === undefined) return false;
        read++;
        return spawnsItsOwnFileListing(String(content));
      });
    // Anti-vacuity on what was actually READ, not on what was enumerated — a read that can return
    // nothing is a read that can hand this assertion an empty sweep.
    expect(read).toBeGreaterThan(400);
    expect(
      offenders,
      `These ask git for a file list themselves, which cannot see the file a change is adding. ` +
        `Call repoFiles() from ${ENUMERATION_MODULE} instead, and read its header for the one ` +
        `case where trackedRepoFiles() is the right answer.`
    ).toEqual([]);
  });

  /**
   * The differential, and the reason it is here rather than only in the three gates: if
   * `repoFiles()` silently regressed to tracked-only, all three fixture cells would go red
   * together and read as three broken gates. This one names the helper instead.
   *
   * The probe is a plain-ASCII `.txt` at the repository root, chosen so that nothing it is live
   * alongside can report it: the lint gate and this sweep both filter by extension and skip it,
   * and the two gates that do read every file see no control byte and no shebang in it. Those
   * gates run in parallel spec files that this cell cannot sequence itself against, and the
   * moment the probe is removed is covered by `readRepoFile` rather than by luck.
   */
  it('separates tracked from untracked, on a file that is genuinely new', () => {
    const probePath = 'ops105-enumeration-probe.txt';
    writeFileSync(join(REPO_ROOT, probePath), 'ops105\n');
    try {
      expect(repoFiles(REPO_ROOT)).toContain(probePath);
      expect(trackedRepoFiles(REPO_ROOT)).not.toContain(probePath);
    } finally {
      rmSync(join(REPO_ROOT, probePath), { force: true });
    }
  });

  /**
   * `readRepoFile` decides whether a listed-but-missing file is a red or a shrug, and that branch
   * only ever runs in a race, so nothing else would exercise it. Both answers matter: silence for
   * a tracked file would be a real narrowing, and a throw for an untracked one would make every
   * repository-wide gate intermittently red for something that is not a defect.
   *
   * Hermetic, in its own repository under the OS temp dir, because the only way to ask the tracked
   * question honestly is to have a tracked file that is not on disk — and doing that to a file of
   * this repository is not something a test should be doing.
   */
  it('shrugs at a vanished untracked file and refuses a vanished tracked one', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ops105-readrepofile-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: scratch });
      writeFileSync(join(scratch, 'tracked.txt'), 'tracked\n');
      writeFileSync(join(scratch, 'untracked.txt'), 'untracked\n');
      // `add` alone is enough: the tracked list is the index, not the history.
      execFileSync('git', ['add', 'tracked.txt'], { cwd: scratch });

      expect(String(readRepoFile(scratch, 'tracked.txt'))).toBe('tracked\n');
      expect(String(readRepoFile(scratch, 'untracked.txt'))).toBe('untracked\n');

      rmSync(join(scratch, 'tracked.txt'));
      rmSync(join(scratch, 'untracked.txt'));

      expect(readRepoFile(scratch, 'untracked.txt')).toBeUndefined();
      expect(() => readRepoFile(scratch, 'tracked.txt')).toThrow(/ENOENT/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
