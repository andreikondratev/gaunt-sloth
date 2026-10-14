import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * PTY end-to-end config for the Ink TUI. The cases live beside this file and drive the real `gth`
 * binary in a pseudo-terminal (`@microsoft/tui-test`'s engine, through `fixtures/harness.mjs`), fed
 * by the deterministic fixture agent (`src/tui/fixtureAgent.ts`), so runs are hermetic and key-free.
 * Kept separate from the unit suite, whose root config globs only `packages/*\/spec`.
 *
 * Run it through `node packages/app/run-tui-e2e.js` (or `pnpm run it-tui`), never with a bare
 * `vitest`: the runner owns the environment the cases see and reads the structured result this
 * config's reporter writes. `fixtures/vitest.setup.mjs` refuses to run without it.
 */
const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  test: {
    include: ['**/*.tui.test.ts'],
    environment: 'node',
    // The engine is a native addon holding real ptys, so each file gets a process of its own.
    pool: 'forks',
    // The worker count 0.0.4 used: half the CPUs, at least one.
    maxWorkers: Math.max(Math.floor(os.cpus().length / 2), 1),
    // Streaming-TUI timing varies on slow CI, so retry twice there. Read HERE, in the main
    // process: the workers delete `CI` from their own environment before any case spawns `gth`
    // (see fixtures/vitest.setup.mjs), because Ink paints nothing when it sees it.
    retry: process.env.CI ? 2 : 0,
    // The per-case cap has to hold a whole case whose last assertion then burns the full 15 s
    // expect budget, or a slow failure is killed without the terminal content that says what was on
    // screen — the one output worth having from a flake. Measured on this suite, locally: median
    // 5.2 s, p90 5.5 s, slowest passing case 7.8 s, of which 5 s is the fixed wait before the body
    // (kept, see fixtures/harness.mjs). A Windows CI cell took 30.2 s for a single approval-framing
    // case (run 34044200014), and the flake register records that cell running roughly 6x these
    // durations, so the budget a failing case needs there is nearer 37 s. 45 s covers that with room.
    testTimeout: 45_000,
    // Hooks are bounded by the same reasoning: the settle hook waits up to 5 s for a killed session.
    hookTimeout: 45_000,
    // The flake report names a file, line and column, so the reporter needs each case's location.
    includeTaskLocation: true,
    setupFiles: ['./fixtures/vitest.setup.mjs'],
    reporters: ['default', '../tui-e2e-results-reporter.mjs'],
    // A run that discovers no cases must not pass. The runner checks this from the structured
    // result too; this makes vitest's own exit code agree.
    passWithNoTests: false,
  },
});
