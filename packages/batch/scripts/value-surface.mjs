/**
 * The batch package's public RUNTIME (value) surface, bound to core's
 * `scripts/surface/barrel-value-surface.mjs`.
 *
 * That engine is the single implementation shared by every package that pins a barrel, and by the
 * two things here that must never disagree: `generate-value-surface.mjs`, which writes the golden,
 * and `spec/batchBarrelValueSurface.spec.ts`, which asserts the golden still describes the
 * surface. The spec's docblock is where the design is written down; the engine is the mechanism,
 * and this file is only the descriptor that names the batch package.
 *
 * `published-surface.mjs` is the companion to this file and accounts for the modules the `"./*.js"`
 * wildcard publishes that the barrel does not reach.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBarrelValueSurface } from '../../core/scripts/surface/barrel-value-surface.mjs';

export { kindOf, listDeclaredExports } from '../../core/scripts/surface/barrel-value-surface.mjs';

/** The `packages/batch` directory — this file lives one level down, in `scripts/`. */
export const BATCH_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The probe reads the built barrel, so a regeneration is only as fresh as `dist/`. */
const BUILD = 'pnpm --filter @gaunt-sloth/batch run build';

/** The one command that rewrites the golden, named verbatim in every failure message. */
const REGENERATE = `${BUILD} && pnpm --filter @gaunt-sloth/batch run value-surface:generate`;

/**
 * A floor, not a pin on the size of the API. It exists for one failure only: a probe that imported
 * something other than the barrel and came back with almost nothing, which would make every name
 * assertion pass by checking nothing.
 *
 * **Measured against THIS barrel, and deliberately not copied from core's.** Core's floor is 60
 * and this barrel exports 59 — one short. Inheriting core's number would refuse a completely
 * healthy package, and the message it refuses with ("this is a broken probe, not a small API") is
 * the one sentence guaranteed to send the reader looking in the wrong place.
 */
const MIN_EXPORTS = 40;

/**
 * Kinds the classifier must actually distinguish on the batch barrel.
 *
 * This guard exists because `kindOf` is the one part of the derivation that can fail SILENTLY and
 * self-consistently: a classifier that returned `'object'` for everything would write a
 * self-consistent golden and compare clean forever.
 *
 * **`class` is deliberately absent, and that is measured rather than an oversight.** This barrel
 * exports no class at all — it is functions, numbers, strings, objects and an array — so core's
 * list would refuse it outright. `number` takes the place `class` holds in core's: it is a kind
 * this surface really has, so a collapsed classifier still cannot satisfy the list.
 */
const KINDS = ['function', 'number', 'object', 'string'];

const batch = createBarrelValueSurface({
  packageName: '@gaunt-sloth/batch',
  packageDir: BATCH_DIR,
  goldenPath: path.join(BATCH_DIR, 'spec', 'batchBarrelValueSurface.golden.json'),
  buildCommand: BUILD,
  regenerateCommand: REGENERATE,
  goldenComment: `GENERATED — do not hand-edit. The public runtime (value) surface of the batch barrel, read from packages/batch/dist/index.js by scripts/value-surface.mjs and compared against this file by spec/batchBarrelValueSurface.spec.ts. Regenerate with: ${REGENERATE}`,
  minValueExports: MIN_EXPORTS,
  requiredKinds: KINDS,
});

export const {
  PACKAGE_NAME,
  DIST_DIR,
  DIST_BARREL_JS,
  DIST_BARREL_TYPES,
  GOLDEN_PATH,
  BUILD_COMMAND,
  REGENERATE_COMMAND,
  GOLDEN_COMMENT,
  MIN_VALUE_EXPORTS,
  REQUIRED_KINDS,
  requireBuiltBarrel,
  resolveBarrelEntry,
  deriveDeclaredClasses,
  assertNonDegenerate,
  deriveValueSurface,
  toGoldenDocument,
  readGoldenDocument,
  describeValueSurfaceDrift,
} = batch;
