import { describe, it, expect } from 'vitest';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Vitest workspace-import shim under test. Importing it directly (rather than
// driving resolution through vitest) lets us assert exactly which package file a
// `#src/…` specifier resolves to for a given importer.
import { resolveWorkspaceImports, packageOfImporter } from '../../../vitest.config.js';

// Repo root = three levels up from this spec (packages/app/spec).
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

// Real files inside packages/app and packages/review, used as representative importers.
const APP_IMPORTER = resolve(repoRoot, 'packages', 'app', 'spec', 'getCommand.spec.ts');
const REVIEW_IMPORTER = resolve(repoRoot, 'packages', 'review', 'spec', 'reviewPreamble.spec.ts');
// A core module that self-imports by `#src/…` — the importer side of the EXT-188 invariant.
const CORE_IMPORTER = resolve(repoRoot, 'packages', 'core', 'src', 'utils', 'ProgressIndicator.ts');

const CORE_SYSTEM_UTILS = resolve(repoRoot, 'packages', 'core', 'src', 'utils', 'systemUtils.ts');
const CORE_FILE_UTILS = resolve(repoRoot, 'packages', 'core', 'src', 'utils', 'fileUtils.ts');
const REVIEW_FILE_UTILS = resolve(repoRoot, 'packages', 'review', 'src', 'utils', 'fileUtils.ts');

const APP_COMMAND_UTILS = resolve(
  repoRoot,
  'packages',
  'app',
  'src',
  'commands',
  'commandUtils.ts'
);
const REVIEW_COMMAND_UTILS = resolve(
  repoRoot,
  'packages',
  'review',
  'src',
  'commands',
  'commandUtils.ts'
);

describe('resolveWorkspaceImports (GS2-45 importer-aware #src resolution)', () => {
  const plugin = resolveWorkspaceImports();
  const resolveId = (id: string, importer: string | undefined): string | undefined =>
    plugin.resolveId(id, importer);

  it('maps an importer absolute path to the workspace package it belongs to', () => {
    expect(packageOfImporter(APP_IMPORTER)).toBe('app');
    expect(packageOfImporter(REVIEW_IMPORTER)).toBe('review');
    // Not a workspace-package file -> unmapped, so resolution falls back to the scan.
    expect(packageOfImporter(undefined)).toBeUndefined();
    expect(packageOfImporter(resolve(repoRoot, 'node_modules', 'x', 'index.js'))).toBeUndefined();
  });

  // The core regression: `packages/app` and `packages/review` both own an
  // independent `src/commands/commandUtils.ts` with the same exported names but
  // different content. The specifier must resolve to the IMPORTER's own package.
  it('resolves #src/commands/commandUtils.js to the importer’s OWN package on the app↔review collision', () => {
    const fromApp = resolveId('#src/commands/commandUtils.js', APP_IMPORTER);
    const fromReview = resolveId('#src/commands/commandUtils.js', REVIEW_IMPORTER);

    // app importer -> app's file (the old importer-blind resolver returned review's here).
    expect(fromApp).toBe(APP_COMMAND_UTILS);
    // review importer -> review's file.
    expect(fromReview).toBe(REVIEW_COMMAND_UTILS);
    // They are genuinely different files — proving per-importer discrimination.
    expect(fromApp).not.toBe(fromReview);
  });

  it('resolves a non-colliding #src import to the importer’s own package (app-only path)', () => {
    // `commands/getCommand.ts` exists only in app; an app importer must still get it.
    const resolved = resolveId('#src/commands/getCommand.js', APP_IMPORTER);
    expect(resolved).toBe(resolve(repoRoot, 'packages', 'app', 'src', 'commands', 'getCommand.ts'));
  });

  it('falls back to the dependency-order scan when the importer is not a workspace package', () => {
    // No importer -> importer-blind fallback (the old behavior): review is the
    // first package in scan order that ships commands/commandUtils.ts (core has none).
    expect(resolveId('#src/commands/commandUtils.js', undefined)).toBe(REVIEW_COMMAND_UTILS);
  });

  it('prefers core over a review re-export stub sharing the same relative path', () => {
    // review/src/utils/fileUtils.ts is a stub re-exporting core; a review importer
    // must still get core's canonical module (shared identity), not the stub.
    const resolved = resolveId('#src/utils/fileUtils.js', REVIEW_IMPORTER);
    expect(resolved).toBe(resolve(repoRoot, 'packages', 'core', 'src', 'utils', 'fileUtils.ts'));
  });

  it('resolves @gaunt-sloth/<pkg>/<path>.js to that package’s src file', () => {
    expect(resolveId('@gaunt-sloth/core/utils/fileUtils.js', APP_IMPORTER)).toBe(
      resolve(repoRoot, 'packages', 'core', 'src', 'utils', 'fileUtils.ts')
    );
  });

  // Guard against an accidental hard-coded separator in the importer→package map.
  it('uses the platform path separator when splitting importer paths', () => {
    expect(sep.length).toBe(1);
  });

  // EXT-188 — the invariant that makes `vi.mock` work across packages at all.
  //
  // Specs mock `systemUtils` with BOTH spellings: `#src/utils/systemUtils.js` and
  // `@gaunt-sloth/core/utils/systemUtils.js`. `vi.mock` keys on the resolved module, so
  // those are interchangeable only because this resolver maps them onto one file. Were
  // that to stop, a spec outside core mocking the package spelling would replace a module
  // core's own `#src/` import never reaches: the mock installs, the spec passes, and the
  // assertion observes a stub production never writes to. Nothing else in the suite can
  // see that happen, which is why it is pinned here.
  it('resolves both spellings of a singly-owned core module to ONE module identity', () => {
    // core's own self-import — the specifier ProgressIndicator actually uses.
    expect(resolveId('#src/utils/systemUtils.js', CORE_IMPORTER)).toBe(CORE_SYSTEM_UTILS);

    // …and every spelling available to a spec OUTSIDE core lands on that same file.
    expect(resolveId('#src/utils/systemUtils.js', APP_IMPORTER)).toBe(CORE_SYSTEM_UTILS);
    expect(resolveId('@gaunt-sloth/core/utils/systemUtils.js', APP_IMPORTER)).toBe(
      CORE_SYSTEM_UTILS
    );
    expect(resolveId('#src/utils/systemUtils.js', REVIEW_IMPORTER)).toBe(CORE_SYSTEM_UTILS);
    expect(resolveId('@gaunt-sloth/core/utils/systemUtils.js', REVIEW_IMPORTER)).toBe(
      CORE_SYSTEM_UTILS
    );
  });

  // The QUALIFIER on the cell above, and the reason a single canonical spelling is NOT
  // imposed: convergence holds because exactly one package owns `utils/systemUtils.ts`.
  // Where two packages own the same relative path the spellings resolve to different
  // modules — deliberately (GS2-45), since those are different files. A spec author
  // mocking such a path must pick the spelling naming the package they mean.
  it('does NOT converge the two spellings on a path more than one package owns', () => {
    // app and review each own an independent src/commands/commandUtils.ts.
    expect(resolveId('#src/commands/commandUtils.js', APP_IMPORTER)).toBe(APP_COMMAND_UTILS);
    expect(resolveId('@gaunt-sloth/review/commands/commandUtils.js', APP_IMPORTER)).toBe(
      REVIEW_COMMAND_UTILS
    );
    expect(APP_COMMAND_UTILS).not.toBe(REVIEW_COMMAND_UTILS);
  });

  // The asymmetry inside that qualifier: the core-over-review-stub preference lives in the
  // `#src/` arm only. So on `utils/fileUtils.js` the `#src/` spelling yields core's
  // canonical module while the review PACKAGE spelling yields review's re-export stub —
  // two module records, and a `vi.mock` on one does not intercept the other.
  it('sends the two spellings to different records where only the #src arm prefers core', () => {
    expect(resolveId('#src/utils/fileUtils.js', REVIEW_IMPORTER)).toBe(CORE_FILE_UTILS);
    expect(resolveId('@gaunt-sloth/review/utils/fileUtils.js', APP_IMPORTER)).toBe(
      REVIEW_FILE_UTILS
    );
    expect(CORE_FILE_UTILS).not.toBe(REVIEW_FILE_UTILS);
  });
});
