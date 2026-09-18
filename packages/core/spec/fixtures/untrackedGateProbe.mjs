import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * OPS-105 — run a repository-wide gate for real, with a new untracked file planted in the tree,
 * and hand back what it did.
 *
 * The defect these cells exist to catch is in what a gate's enumeration *returns*, not in what the
 * gate does with it, so an assertion over the enumerator can pass while the gate stays blind. The
 * only test that discriminates is the whole gate, on a real file, read as a real red — which is
 * why this spawns the gate's own spec in a child vitest run rather than calling anything directly.
 *
 * **Why the cell belongs in the same spec file as the gate it probes.** Vitest runs spec *files*
 * in parallel but the tests within one file in sequence. A fixture planted from a different file
 * would sit in the tree while the parent's own copy of the gate was running, and turn it red at
 * random. Placed beside the gate, the fixture only ever exists while that gate's other tests are
 * not running — and each fixture path is additionally chosen so that no *other* gate can see it.
 *
 * `GSLOTH_OPS105_CHILD` is set for the child so the cell it re-enters returns immediately instead
 * of spawning another one. It is a recursion guard, not a skipped assertion: the parent run — the
 * one that gates anything — executes every cell.
 *
 * @param {object} options
 * @param {string} options.repoRoot Absolute path to the repository root.
 * @param {string} options.specPath Repository-relative path of the gate's spec file.
 * @param {string} options.fixturePath Repository-relative path to plant. Its parent directory must
 *   already exist, and nothing is created beyond the file itself, so cleanup is one unlink.
 * @param {string | Uint8Array} options.contents What to write there.
 * @returns {{ status: number | null, output: string }} The child's exit status and its combined
 *   stdout and stderr.
 */
export function runGateWithUntrackedFixture({ repoRoot, specPath, fixturePath, contents }) {
  writeFileSync(join(repoRoot, fixturePath), contents);
  try {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', specPath],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GSLOTH_OPS105_CHILD: '1' },
      }
    );
    return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
  } finally {
    // Unconditional: a leaked fixture carrying a raw NUL is the incident this node is about, and
    // one left in the tree would make every later recursive grep silently omit it.
    rmSync(join(repoRoot, fixturePath), { force: true });
  }
}

/** True in the child run this module spawns, where the cell must not spawn another. */
export function isGateProbeChild() {
  return process.env.GSLOTH_OPS105_CHILD === '1';
}
