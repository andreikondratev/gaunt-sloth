#!/usr/bin/env node
/**
 * Write the committed goldens of the core package's public RUNTIME (value) surface — the name/kind
 * sets that `spec/coreBarrelValueSurface.spec.ts` and `spec/coreDeepSubpathValueSurface.spec.ts`
 * compare against. The probes themselves live in `value-surface.mjs` and `deep-subpath-surface.mjs`
 * and are shared with those specs, so the files this writes are by construction the things the
 * specs derive rather than a second opinion about them.
 *
 * **Both goldens, one command.** The root barrel re-exports several of the modules the deep gate
 * pins, so one surface change routinely moves both files, and a second command is a command to
 * forget. Every failure message in both specs names this one.
 *
 * Run AFTER a build, because the probes import the emitted package in `dist/`:
 *
 *   pnpm --filter @gaunt-sloth/core run build
 *   pnpm --filter @gaunt-sloth/core run value-surface:generate
 *
 * Run it when a spec's golden cell tells you to and you have established that the change to the
 * public surface is one you meant. On a LOSS of exports that is a decision, not a formality: the
 * specs' failure messages say what to establish first.
 */
import { writeFileSync } from 'node:fs';
import { deriveValueSurface, GOLDEN_PATH, toGoldenDocument } from './value-surface.mjs';
import {
  deriveDeepSubpathSurface,
  GOLDEN_PATH as DEEP_GOLDEN_PATH,
  toGoldenDocument as toDeepGoldenDocument,
} from './deep-subpath-surface.mjs';

const golden = toGoldenDocument(await deriveValueSurface());
writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n', 'utf8');
const kinds = new Map();
for (const entry of golden.exports) kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
const summary = [...kinds]
  .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(([kind, count]) => `${count} ${kind}`)
  .join(', ');
console.log(`Wrote ${GOLDEN_PATH} (${golden.exports.length} runtime exports: ${summary})`);

const deep = toDeepGoldenDocument(await deriveDeepSubpathSurface());
writeFileSync(DEEP_GOLDEN_PATH, JSON.stringify(deep, null, 2) + '\n', 'utf8');
const deepExports = deep.subpaths.reduce((total, entry) => total + entry.exports.length, 0);
console.log(
  `Wrote ${DEEP_GOLDEN_PATH} (${deep.subpaths.length} gated subpaths, ${deepExports} runtime exports)`
);
