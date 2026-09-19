#!/usr/bin/env node
/**
 * Write the committed golden of the TeamCity reporter package's public RUNTIME (value) surface —
 * the name/kind set that `spec/teamcityBarrelValueSurface.spec.ts` compares against. The probe
 * itself lives in `value-surface.mjs`, which binds core's shared engine to this package and is the
 * same module that spec imports — so the file this writes is by construction the thing the spec
 * derives rather than a second opinion about it.
 *
 * **One golden, not two.** This package has no deep-subpath golden: it publishes two modules, the
 * barrel and the implementation the barrel re-exports by a literal specifier, so there is nothing
 * for a deep gate to pin. `scripts/published-surface.mjs` carries that reasoning and
 * `spec/teamcityPublishedSurface.spec.ts` asserts it still holds.
 *
 * Run AFTER a build, because the probe imports the emitted package in `dist/`:
 *
 *   pnpm --filter @gaunt-sloth/eval-reporter-teamcity run build
 *   pnpm --filter @gaunt-sloth/eval-reporter-teamcity run value-surface:generate
 *
 * Run it when the spec's golden cell tells you to and you have established that the change to the
 * public surface is one you meant. On a LOSS of exports that is a decision, not a formality: the
 * spec's failure message says what to establish first.
 */
import { writeFileSync } from 'node:fs';
import { deriveValueSurface, GOLDEN_PATH, toGoldenDocument } from './value-surface.mjs';

const golden = toGoldenDocument(await deriveValueSurface());
writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n', 'utf8');
const kinds = new Map();
for (const entry of golden.exports) kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
const summary = [...kinds]
  .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(([kind, count]) => `${count} ${kind}`)
  .join(', ');
console.log(`Wrote ${GOLDEN_PATH} (${golden.exports.length} runtime exports: ${summary})`);
