/**
 * The JUnit reporter package's public RUNTIME (value) surface, bound to core's
 * `scripts/surface/barrel-value-surface.mjs`.
 *
 * That engine is the single implementation shared by every package that pins a barrel, and by the
 * two things here that must never disagree: `generate-value-surface.mjs`, which writes the golden,
 * and `spec/junitBarrelValueSurface.spec.ts`, which asserts the golden still describes the
 * surface. The spec's docblock is where the design is written down; the engine is the mechanism,
 * and this file is only the descriptor that names this package.
 *
 * `published-surface.mjs` is the companion to this file and accounts for the modules the `"./*.js"`
 * wildcard publishes that the barrel does not reach. There are two modules in all, so it is short.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBarrelValueSurface } from '../../core/scripts/surface/barrel-value-surface.mjs';

export { kindOf, listDeclaredExports } from '../../core/scripts/surface/barrel-value-surface.mjs';

/** The `packages/eval-reporter-junit` directory — this file lives one level down, in `scripts/`. */
export const JUNIT_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The probe reads the built barrel, so a regeneration is only as fresh as `dist/`. */
const BUILD = 'pnpm --filter @gaunt-sloth/eval-reporter-junit run build';

/** The one command that rewrites the golden, named verbatim in every failure message. */
const REGENERATE = `${BUILD} && pnpm --filter @gaunt-sloth/eval-reporter-junit run value-surface:generate`;

/**
 * A floor, and on a two-name barrel it can only do the smaller half of the job.
 *
 * **Measured against THIS barrel, and deliberately not copied from core's or batch's.** Those are
 * 60 and 40 against surfaces of 128 and 59; this barrel exports exactly two names. A floor high
 * enough to tell the barrel apart from the one other module this package publishes would have to
 * be 2 — the barrel's own size — and would then refuse any deliberate narrowing while saying "this
 * is a broken probe, not a small API", which is the one sentence guaranteed to send a reader
 * looking in the wrong place.
 *
 * So it is 1, which refuses only a probe that came back with nothing at all. The question it
 * cannot answer here — did the probe read the barrel or something else? — is answered directly and
 * better by the cell in the spec that asserts the resolved entry is `dist/index.js`, and the
 * golden is what sees a surface that merely shrank.
 */
const MIN_EXPORTS = 1;

/**
 * Kinds the classifier must actually distinguish on this barrel.
 *
 * This guard exists because `kindOf` is the one part of the derivation that can fail SILENTLY and
 * self-consistently: a classifier that returned `'object'` for everything would write a
 * self-consistent golden and compare clean forever. Measured on this barrel, which exports one
 * function and one string — so a collapsed classifier still cannot satisfy the list, small as it
 * is. `class` is absent because this package exports none; core's list would refuse it outright.
 */
const KINDS = ['function', 'string'];

const junit = createBarrelValueSurface({
  packageName: '@gaunt-sloth/eval-reporter-junit',
  packageDir: JUNIT_DIR,
  goldenPath: path.join(JUNIT_DIR, 'spec', 'junitBarrelValueSurface.golden.json'),
  buildCommand: BUILD,
  regenerateCommand: REGENERATE,
  goldenComment: `GENERATED — do not hand-edit. The public runtime (value) surface of the JUnit reporter barrel, read from packages/eval-reporter-junit/dist/index.js by scripts/value-surface.mjs and compared against this file by spec/junitBarrelValueSurface.spec.ts. Regenerate with: ${REGENERATE}`,
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
} = junit;
