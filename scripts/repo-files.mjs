import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * OPS-105 — the one place a repository-wide gate gets its subject list.
 *
 * A gate that enumerates with a bare `git ls-files` is structurally blind to the file a change is
 * adding. A new file is untracked until it is at least staged, so it is not in that list: the gate
 * runs, finds nothing wrong, and exits 0 about a set that excludes the very file most likely to
 * carry a new defect. Nothing is skipped or disabled — the subject list simply cannot contain the
 * failing case, which is why auditing the assertion finds nothing wrong with it.
 *
 * Measured: a raw NUL byte in a then-new `packages/core/src/core/terminationReason.ts` was live in
 * source for the duration of one commit while `noRawControlBytes.spec.ts`, the gate that exists to
 * ban exactly that byte, was green and right to be. It became visible on the next run, once the
 * commit made the file tracked.
 *
 * {@link repoFiles} is the remedy: tracked files **and** untracked files git is not ignoring. The
 * exclusion is git's own (`--exclude-standard` honours `.gitignore`, `.git/info/exclude` and the
 * user's global excludes file), so build output, `node_modules` and scratch directories stay out
 * without this module keeping a second copy of the ignore rules. A copied list is the thing that
 * drifts from the rules it mirrors, and it is what `pnpmOverridesGate.spec.ts` had to accept when
 * it walked the filesystem instead — its docblock says so.
 *
 * **Where the coverage this buys actually lands.** A CI run checks out a clean tree, so there are
 * no untracked files there and `--others` adds nothing to any of the five matrix cells. The run it
 * changes is the local one — the in-worktree build-and-test a lane reads before it merges, which
 * happens before the commit and is exactly where the blind spot bit.
 *
 * **What it still does not cover, deliberately.** A file git is ignoring is out of scope: that is
 * the repository stating the file is not its source. If an ignored file ought to be gated, the
 * remedy is to stop ignoring it, not to second-guess the ignore rules here. And a tracked file
 * deleted from the working tree is still listed, because it is still in the index — a caller
 * reading it gets an ENOENT rather than a silent pass, which is the loud direction.
 *
 * **In a tree with no git history** — a `git archive` extraction, say — these throw rather than
 * returning an empty list. That is intentional and unchanged: every caller here carries an
 * anti-vacuity assertion on the size of the list, so an empty one was already a red. A gate that
 * cannot look has not proved anything, and it must not read as a pass.
 */

/** `git ls-files -z` separates paths with this, so a path containing a newline stays one entry. */
const NUL = String.fromCharCode(0);

function gitPaths(args, root) {
  const out = execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // Deduplicated because a path with an unresolved merge conflict appears in the index once per
  // stage, so a mid-merge run would otherwise scan it two or three times. Sorted so a failure
  // message reads the same however git ordered the tracked and untracked halves.
  return [...new Set(out.split(NUL).filter(Boolean))].sort();
}

/**
 * Every file this repository is responsible for: tracked, plus untracked and not ignored.
 *
 * This is what a repository-wide gate should enumerate. Reach for {@link trackedRepoFiles} only
 * when the gate asserts something about the repository's own recorded policy for a path rather
 * than about the bytes on disk, and say in the gate why.
 *
 * @param {string} root Absolute path to the repository root.
 * @returns {string[]} Repository-relative paths, forward-slashed exactly as git prints them, so a
 *   failure message reads identically on Windows.
 */
export function repoFiles(root) {
  return gitPaths(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
}

/**
 * Tracked files only — the set the repository has committed to.
 *
 * Narrower than {@link repoFiles} on purpose, and only correct for a gate asserting that some
 * per-path rule has been recorded for a file, because an untracked file is one the repository has
 * not promised anything about yet.
 *
 * @param {string} root Absolute path to the repository root.
 * @returns {string[]} Repository-relative paths, forward-slashed exactly as git prints them.
 */
export function trackedRepoFiles(root) {
  return gitPaths(['ls-files', '-z'], root);
}

/**
 * Read a file {@link repoFiles} listed, or `undefined` when it is no longer there.
 *
 * Enumerating untracked files makes a gate's subject list live rather than fixed, and a live list
 * has a gap between being read and being used: an editor, a build, or one of the OPS-105 fixture
 * cells removing its own probe can delete an untracked file in between. Treating that as a hard
 * error would make every repository-wide gate intermittently red for something that is not a
 * defect — which is how a gate gets loosened by somebody who is tired of it.
 *
 * A **tracked** file that has vanished is a different fact and still throws. The index says the
 * repository has that file and the working tree does not; nothing about this change makes that
 * expected, and swallowing it would be a real narrowing. The extra git call to tell the two apart
 * is paid only on the rare path where a listed file is already gone.
 *
 * Callers must count what they actually read, not what they enumerated. A helper that can return
 * `undefined` is a helper that can hand a gate an empty scan, and the enumeration count alone
 * cannot see that.
 *
 * @param {string} root Absolute path to the repository root.
 * @param {string} file A repository-relative path from {@link repoFiles}.
 * @returns {Buffer | undefined} The file's bytes, or `undefined` if it was untracked and is gone.
 */
export function readRepoFile(root, file) {
  try {
    return readFileSync(join(root, file));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (trackedRepoFiles(root).includes(file)) throw error;
    return undefined;
  }
}
