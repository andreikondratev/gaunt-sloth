/**
 * TUI-C55 — observer that records WHICH React build a real `gth` run actually loaded.
 *
 * Loaded with `--import` (via NODE_OPTIONS) so it is in place before the entry module runs,
 * while leaving `packages/app/cli.js` as the process's real main module with its real
 * bootstrap. It imports nothing but `node:module` and `node:fs`, and in particular never
 * touches React — an observer that imported React would decide the very question it is
 * asked to measure.
 *
 * WHY IT HOOKS THE LOADER RATHER THAN READING `process.env.NODE_ENV`: the env var proves
 * only that an assignment ran, not that it ran in time. The thing that decides the build is
 * the branch `react/index.js` takes, so this records that branch directly:
 *
 *     if (process.env.NODE_ENV === 'production') require('./cjs/react.production.js');
 *     else                                       require('./cjs/react.development.js');
 *
 * WHY NOT `require.cache`: measured on this tree, a production run has BOTH bundles as cache
 * keys — Node registers the development module (0 exports, never executed) while resolving
 * the CJS module's named exports for the ESM importer. Enumerating the cache therefore reports
 * "development" in a run that is correctly on production. `Module._load` fires only for
 * modules that are genuinely loaded, and was verified to distinguish the two.
 *
 * The record is appended the instant the branch is taken, not at exit: the PTY harness kills
 * these processes, so an exit handler would often never run.
 */
import Module from 'node:module';
import { appendFileSync } from 'node:fs';

const reportPath = process.env.GTH_E2E_REACT_BUILD_REPORT;

// `./cjs/react.development.js` / `./cjs/react.production.js` as requested from react/index.js,
// and the matching react-reconciler pair — the reconciler is what actually costs render time.
const REACT_BUNDLE = /^\.\/cjs\/react\.(development|production)(?:\.min)?\.js$/;
const RECONCILER_BUNDLE = /^\.\/cjs\/react-reconciler\.(development|production)(?:\.min)?\.js$/;

const record = (line) => {
  if (!reportPath) return;
  try {
    appendFileSync(reportPath, `${line}\n`);
  } catch {
    // The report is evidence, never a reason to take the run down.
  }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  const react = REACT_BUNDLE.exec(request);
  if (react) record(`react=${react[1]}\tNODE_ENV=${process.env.NODE_ENV ?? '<unset>'}`);
  const reconciler = RECONCILER_BUNDLE.exec(request);
  if (reconciler) record(`react-reconciler=${reconciler[1]}`);
  return originalLoad.apply(this, arguments);
};
