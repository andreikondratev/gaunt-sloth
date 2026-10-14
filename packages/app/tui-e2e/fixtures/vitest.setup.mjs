/**
 * [[OPS-153]] — give every PTY case the environment 0.0.4's workers had, before any case file loads.
 *
 * Every case builds its program's env as `{ ...process.env }` and then edits it, and the harness
 * hands that to the program as its WHOLE environment. So whatever is in this process's environment
 * reaches `gth`. A vitest worker adds its own keys (`baseEnv.mjs` lists them); `NODE_ENV=test` alone
 * would put every case on React's development build and break `react-build.tui.test.ts` outright.
 * So the environment is reset to the one `run-tui-e2e.js` spawned vitest with, from the names and
 * values it hands down in `GTH_E2E_BASE_ENV` (see `baseEnv.mjs` for why that, and not a file).
 *
 * Then `CI` and `GTH_NO_TUI` are deleted, because Ink paints a blank screen when it sees `CI`, and
 * the engine layers a case's env over this process's — a key absent here is the only way to keep
 * it absent there. `vitest.config.mjs` has already read `CI` for the retry count by now: the config
 * runs in the main process, this file in the worker.
 */
import process from 'node:process';
import { BASE_ENV_VAR, restoreBaseEnv } from './baseEnv.mjs';

const encoded = process.env[BASE_ENV_VAR];
if (!encoded) {
  throw new Error(
    'the PTY e2e suite must be run through packages/app/run-tui-e2e.js (pnpm run it-tui), which ' +
      `owns the environment the cases see. ${BASE_ENV_VAR} is not set.`
  );
}

restoreBaseEnv(process.env, encoded);

delete process.env.CI;
delete process.env.GTH_NO_TUI;
