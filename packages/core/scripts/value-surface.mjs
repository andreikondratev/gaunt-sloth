/**
 * The core package's public RUNTIME (value) surface, bound to `surface/barrel-value-surface.mjs`.
 *
 * That engine is the single implementation shared by every package that pins a barrel, and by the
 * two things here that must never disagree: `generate-value-surface.mjs`, which writes the golden,
 * and `spec/coreBarrelValueSurface.spec.ts`, which asserts the golden still describes the surface.
 * The spec's docblock is where the design is written down — what is pinned, why the expectation is
 * a committed snapshot rather than a derivation from somewhere else, and what the pin does and
 * does not catch. Read that first; the engine is the mechanism, and this file is only the
 * descriptor that names core.
 *
 * `deep-subpath-surface.mjs` is the twin of this file and pins the paths reachable as
 * `@gaunt-sloth/core/<something>.js`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBarrelValueSurface } from './surface/barrel-value-surface.mjs';

export { kindOf } from './surface/barrel-value-surface.mjs';

/** The `packages/core` directory — this file lives one level down, in `scripts/`. */
export const CORE_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The probe reads the built barrel, so a regeneration is only as fresh as `dist/`. */
const BUILD = 'pnpm --filter @gaunt-sloth/core run build';

/**
 * The one command that rewrites the golden, named verbatim in every failure message so nobody has
 * to go looking for it.
 */
const REGENERATE = `${BUILD} && pnpm --filter @gaunt-sloth/core run value-surface:generate`;

/**
 * A floor, not a pin on the size of the API. It exists for one failure only: a probe that imported
 * something other than the barrel — a stub, a half-written artifact, a resolver pointing somewhere
 * new — and came back with almost nothing, which would make every name assertion pass by checking
 * nothing. The golden is what sees a surface that merely shrank; this is what makes a total
 * collapse say the right sentence.
 */
const MIN_EXPORTS = 60;

/**
 * Kinds the classifier must actually distinguish on core's real surface.
 *
 * This guard exists because `kindOf` is the one part of the derivation that can fail SILENTLY and
 * self-consistently: a classifier that returned `'object'` for everything would write a
 * self-consistent golden, compare clean forever, and never see a class demoted to a plain object —
 * the exact defect the kind field is here to catch. A collapsed classifier cannot satisfy this
 * list, so it is refused rather than blessed into the golden.
 *
 * It is measured against THIS barrel and is not a constant to copy: a package whose barrel
 * exports no class at all would be refused by a list naming `class`.
 */
const KINDS = ['class', 'function', 'object', 'string'];

const core = createBarrelValueSurface({
  packageName: '@gaunt-sloth/core',
  packageDir: CORE_DIR,
  goldenPath: path.join(CORE_DIR, 'spec', 'coreBarrelValueSurface.golden.json'),
  buildCommand: BUILD,
  regenerateCommand: REGENERATE,
  goldenComment: `GENERATED — do not hand-edit. The public runtime (value) surface of the core barrel, read from packages/core/dist/index.js by scripts/value-surface.mjs and compared against this file by spec/coreBarrelValueSurface.spec.ts. Regenerate with: ${REGENERATE}`,
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
} = core;
