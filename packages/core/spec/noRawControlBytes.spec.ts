import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readRepoFile, repoFiles } from '../../../scripts/repo-files.mjs';
import { isGateProbeChild, runGateWithUntrackedFixture } from './fixtures/untrackedGateProbe.mjs';

/**
 * OPS-34 — no text file in this repository may contain a raw C0 control character in its source.
 *
 * NUL is the one that does real damage: it makes a search tool classify a file as binary. Measured
 * on the three engines in use here, ripgrep and ugrep **silently omit** such a file from a
 * recursive search — no match, no warning, exit 0 — while GNU grep prints "binary file matches"
 * with no line. An empty result then reads as proof of absence, which is how one stray byte in
 * `GthLangChainAgent.ts` produced three separate false conclusions about code that was there all
 * along. Using a control character as a data delimiter is fine; writing it as a raw byte in SOURCE
 * is not — use the escape form, as `TOOL_CALL_SIGNATURE_DELIMITER` does.
 *
 * ESC (U+001B) is the one deliberate exemption, on measurement rather than taste: it is the only
 * other C0 byte present in the repo (6 of them, in two TUI specs asserting ANSI colour sequences),
 * and — checked against the same three engines — a file containing ESC is found normally by all of
 * them. Banning it would cost real assertions and prevent nothing. Every other C0 byte is refused:
 * none is present today, and a BEL or FF appearing in source is an accident by definition.
 *
 * The file list comes from `repoFiles()`, so this covers every file in every package that the
 * repository is responsible for: tracked, and untracked but not ignored. The second half is
 * load-bearing (OPS-105) — asking git for tracked files alone cannot see the file a change is
 * *adding*, and that is precisely how the byte described above survived a green run of this gate.
 * Ignored paths are still out, so build output can never trip it.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Files that are legitimately binary and therefore exempt. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.zip',
  '.gz',
  '.wasm',
]);

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
/** Allowed on measurement — see the header. */
const ESCAPE = 0x1b;

const ALLOWED_CONTROL_BYTES = new Set([TAB, LINE_FEED, CARRIAGE_RETURN, ESCAPE]);

function isDisallowedControlByte(byte: number): boolean {
  return byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte);
}

function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.');
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return dot > slash ? file.slice(dot).toLowerCase() : '';
}

let cachedFiles: string[] | undefined;

/** Memoised: the list is identical for every test here, and the Windows cells pay for each spawn. */
function repoTextFiles(): string[] {
  if (cachedFiles) return cachedFiles;
  cachedFiles = repoFiles(REPO_ROOT).filter((f) => !BINARY_EXTENSIONS.has(extensionOf(f)));
  return cachedFiles;
}

/** The detector under test: every disallowed control byte in a buffer, as `0xNN at <offset>`. */
function controlByteHits(buffer: Buffer): string[] {
  const hits: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    if (isDisallowedControlByte(buffer[i])) {
      hits.push(`0x${buffer[i].toString(16).padStart(2, '0')} at ${i}`);
    }
  }
  return hits;
}

describe('OPS-34 no raw control bytes in repository text files', () => {
  it('flags the bytes it must and passes the ones it must allow', () => {
    // Control mutation: without this pair a detector that always returned [] would let every
    // assertion below pass while scanning nothing meaningful.
    const withNul = Buffer.concat([Buffer.from('a'), Buffer.from([0x00]), Buffer.from('b')]);
    const withBel = Buffer.concat([Buffer.from('a'), Buffer.from([0x07]), Buffer.from('b')]);
    const withEsc = Buffer.concat([Buffer.from('a'), Buffer.from([ESCAPE]), Buffer.from('[31m')]);
    const withWhitespace = Buffer.from('a\tb\r\nc', 'utf8');
    // The escape FORM that source must use is six ordinary characters, not a control byte.
    const escapedForm = Buffer.from('const d = "\\u0000";\n', 'utf8');

    expect(controlByteHits(withNul)).toEqual(['0x00 at 1']);
    expect(controlByteHits(withBel)).toEqual(['0x07 at 1']);
    expect(controlByteHits(withEsc)).toEqual([]);
    expect(controlByteHits(withWhitespace)).toEqual([]);
    expect(controlByteHits(escapedForm)).toEqual([]);
  });

  it('scans a plausible number of files', () => {
    // Anti-vacuity: a failed git call or a wrong cwd would yield an empty list, and every
    // per-file assertion would then pass by scanning nothing.
    const files = repoTextFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('packages/core/src/core/GthLangChainAgent.ts');
  });

  it('no text file contains a raw control byte', () => {
    const offenders: string[] = [];
    let read = 0;
    for (const file of repoTextFiles()) {
      const content = readRepoFile(REPO_ROOT, file);
      // `undefined` means an untracked file was deleted between the listing and this read; a
      // tracked one still throws. See readRepoFile's header.
      if (content === undefined) continue;
      read++;
      const hits = controlByteHits(content);
      if (hits.length > 0) offenders.push(`${file}: ${hits[0]}`);
    }
    // Anti-vacuity on what was actually READ, not on what was enumerated — a read that can return
    // nothing is a read that can hand this assertion an empty scan.
    expect(read).toBeGreaterThan(200);
    expect(
      offenders,
      'A file here carries a raw C0 byte and search tools will silently omit it. If an offender ' +
        'is an untracked file you did not write — generated output, a downloaded artefact — the ' +
        'remedy is to add it to .gitignore, which is what this gate honours.'
    ).toEqual([]);
  });

  it('every text file is valid UTF-8', () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const offenders: string[] = [];
    let read = 0;
    for (const file of repoTextFiles()) {
      const content = readRepoFile(REPO_ROOT, file);
      if (content === undefined) continue;
      read++;
      try {
        decoder.decode(content);
      } catch {
        offenders.push(file);
      }
    }
    expect(read).toBeGreaterThan(200);
    expect(offenders).toEqual([]);
  });
});

describe('OPS-105 this gate sees the file a change is adding', () => {
  /**
   * The discriminating test, and it is a real fixture on purpose: the defect OPS-105 names lives
   * in what the enumeration *returns*, so an assertion over the enumeration can pass while the
   * gate stays blind. This plants a genuinely new, untracked source file carrying a raw NUL and
   * reads the gate's own red.
   *
   * The fixture sits under `evals/` rather than at the root or in a package `src/`, because it is
   * live in the tree while the rest of the suite runs: `evals/**` is matched by a block in
   * `eslint.config.js`, so the lint-coverage gate does not report it as unconfigured, and nothing
   * under `evals/` is compiled by a build or collected by vitest. It has no shebang and the
   * line-ending gate classifies binaries from tracked files only, so that gate cannot see it
   * either.
   */
  it('goes red on a NEW, UNTRACKED source file carrying a raw control byte', () => {
    if (isGateProbeChild()) return;
    const fixturePath = 'evals/ops105-untracked-control-byte-fixture.ts';
    const { status, output } = runGateWithUntrackedFixture({
      repoRoot: REPO_ROOT,
      specPath: 'packages/core/spec/noRawControlBytes.spec.ts',
      fixturePath,
      contents: Buffer.concat([
        Buffer.from('export const ops105 = "a'),
        Buffer.from([0x00]),
        Buffer.from('b";\n'),
      ]),
    });
    // Both assertions are required: a non-zero exit alone would also be satisfied by the child
    // failing for an unrelated reason, or by vitest finding no test to run at all.
    expect(status).not.toBe(0);
    expect(output).toContain(fixturePath);
    expect(output).toContain('0x00');
  }, 120_000);
});
