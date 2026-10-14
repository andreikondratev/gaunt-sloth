/**
 * [[OPS-153]] — give every PTY case the environment 0.0.4's workers had, before any case file loads.
 *
 * Every case builds its program's env as `{ ...process.env }` and then edits it, and the harness
 * hands that to the program as its WHOLE environment. So whatever is in this process's environment
 * reaches `gth`. A vitest worker adds its own keys — measured: `NODE_ENV=test`, `TEST`, `VITEST`,
 * `VITEST_MODE`, `VITEST_POOL_ID`, `VITEST_WORKER_ID`, `FORCE_TTY`, `BASE_URL`, `MODE`, `DEV`, `PROD`,
 * `SSR`. `NODE_ENV=test` alone would put every case on React's development build and break
 * `react-build.tui.test.ts` outright. So the environment is reset to the one `run-tui-e2e.js`
 * spawned vitest with, which it writes to `GTH_E2E_BASE_ENV_FILE`.
 *
 * Then `CI` and `GTH_NO_TUI` are deleted, because Ink paints a blank screen when it sees `CI`, and
 * the engine layers a case's env over this process's — a key absent here is the only way to keep
 * it absent there. `vitest.config.mjs` has already read `CI` for the retry count by now: the config
 * runs in the main process, this file in the worker.
 */
import fs from 'node:fs';
import process from 'node:process';

const baseFile = process.env.GTH_E2E_BASE_ENV_FILE;
if (!baseFile) {
  throw new Error(
    'the PTY e2e suite must be run through packages/app/run-tui-e2e.js (pnpm run it-tui), which ' +
      'owns the environment the cases see. GTH_E2E_BASE_ENV_FILE is not set.'
  );
}

const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
const norm = process.platform === 'win32' ? (key) => key.toUpperCase() : (key) => key;
const baseKeys = new Set(Object.keys(base).map(norm));
for (const key of Object.keys(process.env)) {
  if (!baseKeys.has(norm(key))) delete process.env[key];
}
for (const [key, value] of Object.entries(base)) process.env[key] = value;

delete process.env.CI;
delete process.env.GTH_NO_TUI;
