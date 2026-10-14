/**
 * [[OPS-153]] — hand the runner's environment to the test workers without writing it anywhere.
 *
 * A vitest worker starts from the environment `run-tui-e2e.js` spawned vitest with, plus keys of its
 * own. It adds keys, and it overwrites a few the runner may already have (`NODE_ENV` above all). To
 * give every case exactly the runner's environment, a worker needs two things: the NAMES the runner
 * had, so it can delete every key vitest added, and the runner's VALUES for the few keys vitest sets,
 * so it can put those back. Nothing else is needed, because every other value is still the runner's.
 *
 * So that is all that is passed, in one environment variable. **No value of anything else ever
 * leaves the process environment.** Writing the environment to a file instead would put whatever
 * it holds — on a developer machine, live API keys — on disk, where a runner killed by a signal
 * leaves it behind. An environment variable dies with the process tree and is readable by nothing
 * that could not already read this process's environment.
 */

/**
 * The keys a vitest 5 fork worker sets, measured: it adds all of them, and overwrites any the parent
 * already had. Their values are not secrets. If a vitest bump sets another, `restoreBaseEnv` still
 * deletes it when the runner lacked it; it only cannot put back a runner value it was not told about.
 */
export const VITEST_SET_KEYS = Object.freeze([
  'NODE_ENV',
  'TEST',
  'VITEST',
  'VITEST_MODE',
  'VITEST_POOL_ID',
  'VITEST_WORKER_ID',
  'FORCE_TTY',
  'BASE_URL',
  'MODE',
  'DEV',
  'PROD',
  'SSR',
]);

/** The variable the encoded base environment travels in. */
export const BASE_ENV_VAR = 'GTH_E2E_BASE_ENV';

const normFor = (platform) => (platform === 'win32' ? (key) => key.toUpperCase() : (key) => key);

/**
 * What the runner hands down: the names it has, and its values (or `null` for absent) for the keys
 * vitest sets.
 *
 * @param {Record<string, string | undefined>} env the runner's environment, as vitest will see it
 * @param {string} [platform]
 * @returns {string}
 */
export function encodeBaseEnv(env, platform = process.platform) {
  const norm = normFor(platform);
  const names = Object.keys(env).filter((key) => env[key] !== undefined);
  const byNorm = new Map(names.map((key) => [norm(key), key]));
  const restore = {};
  for (const key of VITEST_SET_KEYS) {
    const own = byNorm.get(norm(key));
    restore[key] = own === undefined ? null : env[own];
  }
  return JSON.stringify({ names, restore });
}

/**
 * Put `processEnv` back to the runner's environment: delete every key the runner did not have, and
 * restore the runner's value (or absence) for each key vitest sets. Mutates `processEnv`.
 *
 * @param {Record<string, string | undefined>} processEnv
 * @param {string} encoded what {@link encodeBaseEnv} produced
 * @param {string} [platform]
 */
export function restoreBaseEnv(processEnv, encoded, platform = process.platform) {
  const norm = normFor(platform);
  const { names, restore } = JSON.parse(encoded);
  if (!Array.isArray(names) || restore === null || typeof restore !== 'object') {
    throw new Error(`${BASE_ENV_VAR} is not what run-tui-e2e.js writes.`);
  }
  const keep = new Set(names.map(norm));
  for (const key of Object.keys(processEnv)) {
    if (!keep.has(norm(key))) delete processEnv[key];
  }
  for (const [key, value] of Object.entries(restore)) {
    for (const existing of Object.keys(processEnv)) {
      if (norm(existing) === norm(key)) delete processEnv[existing];
    }
    if (value !== null) processEnv[key] = value;
  }
}
