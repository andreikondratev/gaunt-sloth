/**
 * The agent package's public RUNTIME (value) surface, bound to core's
 * `scripts/surface/barrel-value-surface.mjs`.
 *
 * That engine is the single implementation shared by every package that pins a barrel, and by the
 * two things here that must never disagree: `generate-value-surface.mjs`, which writes the golden,
 * and `spec/agentBarrelValueSurface.spec.ts`, which asserts the golden still describes the
 * surface. The spec's docblock is where the design is written down; the engine is the mechanism,
 * and this file is only the descriptor that names the agent package.
 *
 * `deep-subpath-surface.mjs` is the twin of this file and pins the paths reachable as
 * `@gaunt-sloth/agent/<something>.js`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBarrelValueSurface } from '../../core/scripts/surface/barrel-value-surface.mjs';

export { kindOf } from '../../core/scripts/surface/barrel-value-surface.mjs';

/** The `packages/agent` directory — this file lives one level down, in `scripts/`. */
export const AGENT_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The probe reads the built barrel, so a regeneration is only as fresh as `dist/`. */
const BUILD = 'pnpm --filter @gaunt-sloth/agent run build';

/**
 * The one command that rewrites both of this package's goldens, named verbatim in every failure
 * message so nobody has to go looking for it.
 */
const REGENERATE = `${BUILD} && pnpm --filter @gaunt-sloth/agent run value-surface:generate`;

/**
 * A floor, not a pin on the size of the API. It exists for one failure only: a probe that imported
 * something other than the barrel and came back with almost nothing, which would make every name
 * assertion pass by checking nothing. The golden is what sees a surface that merely shrank; this
 * is what makes a total collapse say the right sentence.
 *
 * **Measured against THIS barrel, and deliberately not copied from core's.** Core's floor is 60
 * and this barrel exports 24, so core's number would refuse a perfectly healthy agent package and
 * read as a real failure until someone found this sentence.
 */
const MIN_EXPORTS = 15;

/**
 * Kinds the classifier must actually distinguish on the agent barrel.
 *
 * This guard exists because `kindOf` is the one part of the derivation that can fail SILENTLY and
 * self-consistently: a classifier that returned `'object'` for everything would write a
 * self-consistent golden, compare clean forever, and never see a class demoted to a plain object.
 * Measured on this barrel, which exports classes, functions, objects and strings.
 */
const KINDS = ['class', 'function', 'object', 'string'];

/**
 * The names the CONSUMER REPOSITORY takes off the bare barrel. Measured, not assumed:
 * `pukeko-robot-controller`'s `server/index.ts` does
 * `import { startAgUiServer } from '@gaunt-sloth/agent'`.
 *
 * This is an oracle from outside the artifact under test — it is read off the consumer's own
 * import statement rather than off this package's build — which is what separates the cell that
 * uses it from the golden's change-detection. That repository builds against the PUBLISHED package
 * at a pinned version, so nothing in this repository re-proves the edge on its behalf.
 */
export const CONSUMER_BARREL_NAMES = ['startAgUiServer'];

const agent = createBarrelValueSurface({
  packageName: '@gaunt-sloth/agent',
  packageDir: AGENT_DIR,
  goldenPath: path.join(AGENT_DIR, 'spec', 'agentBarrelValueSurface.golden.json'),
  buildCommand: BUILD,
  regenerateCommand: REGENERATE,
  goldenComment: `GENERATED — do not hand-edit. The public runtime (value) surface of the agent barrel, read from packages/agent/dist/index.js by scripts/value-surface.mjs and compared against this file by spec/agentBarrelValueSurface.spec.ts. Regenerate with: ${REGENERATE}`,
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
} = agent;
