/**
 * The review package's public RUNTIME (value) surface, bound to core's
 * `scripts/surface/barrel-value-surface.mjs`.
 *
 * That engine is the single implementation shared by every package that pins a barrel, and by the
 * two things here that must never disagree: `generate-value-surface.mjs`, which writes the golden,
 * and `spec/reviewBarrelValueSurface.spec.ts`, which asserts the golden still describes the
 * surface. The spec's docblock is where the design is written down; the engine is the mechanism,
 * and this file is only the descriptor that names the review package.
 *
 * `deep-subpath-surface.mjs` is the twin of this file and pins the paths reachable as
 * `@gaunt-sloth/review/<something>.js`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBarrelValueSurface } from '../../core/scripts/surface/barrel-value-surface.mjs';

export { kindOf, listDeclaredExports } from '../../core/scripts/surface/barrel-value-surface.mjs';

/** The `packages/review` directory — this file lives one level down, in `scripts/`. */
export const REVIEW_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The probe reads the built barrel, so a regeneration is only as fresh as `dist/`. */
const BUILD = 'pnpm --filter @gaunt-sloth/review run build';

/**
 * The one command that rewrites both of this package's goldens, named verbatim in every failure
 * message so nobody has to go looking for it.
 */
const REGENERATE = `${BUILD} && pnpm --filter @gaunt-sloth/review run value-surface:generate`;

/**
 * A floor, not a pin on the size of the API. It exists for one failure only: a probe that imported
 * something other than the barrel and came back with almost nothing, which would make every name
 * assertion pass by checking nothing. The golden is what sees a surface that merely shrank; this
 * is what makes a total collapse say the right sentence.
 *
 * **Measured against THIS barrel, and deliberately not copied from core's.** This barrel exports
 * 97 runtime values, most of them arriving through `export * from '@gaunt-sloth/core/config.js'`,
 * and the largest non-barrel module this package publishes exports 18. A floor of 40 therefore
 * sits clear of every module the probe could resolve to by mistake while leaving room for the
 * public API to shrink without the guard claiming the instrument is broken.
 */
const MIN_EXPORTS = 40;

/**
 * Kinds the classifier must actually distinguish on the review barrel.
 *
 * This guard exists because `kindOf` is the one part of the derivation that can fail SILENTLY and
 * self-consistently: a classifier that returned `'object'` for everything would write a
 * self-consistent golden, compare clean forever, and never see a class demoted to a plain object.
 *
 * **Measured on this barrel**, which carries 3 classes, 61 functions, 7 objects and 11 strings.
 * The four populous kinds are listed and the sparse ones are not: this barrel also exports 8
 * arrays, 6 numbers and exactly one regexp, and a guard naming a kind with a single instance fires
 * on the deliberate removal of that one export while saying the classifier has collapsed.
 */
const KINDS = ['class', 'function', 'object', 'string'];

const review = createBarrelValueSurface({
  packageName: '@gaunt-sloth/review',
  packageDir: REVIEW_DIR,
  goldenPath: path.join(REVIEW_DIR, 'spec', 'reviewBarrelValueSurface.golden.json'),
  buildCommand: BUILD,
  regenerateCommand: REGENERATE,
  goldenComment: `GENERATED — do not hand-edit. The public runtime (value) surface of the review barrel, read from packages/review/dist/index.js by scripts/value-surface.mjs and compared against this file by spec/reviewBarrelValueSurface.spec.ts. Regenerate with: ${REGENERATE}`,
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
} = review;
