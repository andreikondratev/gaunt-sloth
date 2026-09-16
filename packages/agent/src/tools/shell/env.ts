/**
 * Credential scrubbing for the shell tool's child environment. By default a
 * spawned child inherits `process.env` verbatim, so an approved (or bypassed)
 * command can `echo $ANTHROPIC_API_KEY` and exfiltrate the operator's LLM/cloud
 * credentials. {@link buildScrubbedEnv} returns a copy of the parent env with
 * those credentials removed before spawn.
 *
 * Policy (deliberately scoped):
 * - Strip LLM provider keys and cloud-provider secrets (the explicit blocklist +
 *   a wildcard sweep for `*_API_KEY` / `*_TOKEN` / `*_SECRET` / `*SECRET_KEY`).
 * - LEAVE generic dev env intact (PATH, HOME, SHELL, LANG, npm/pnpm config, …)
 *   so normal commands still work.
 * - LEAVE `GITHUB_TOKEN` / `GH_TOKEN` intact: gaunt-sloth's content/requirement
 *   providers shell out to `gh` (`gh pr diff`, `gh issue view`), so stripping
 *   these would break first-class workflows. They are explicitly allow-listed
 *   against the wildcard `*_TOKEN` sweep.
 *
 * Patterned after hermes-agent `_HERMES_PROVIDER_ENV_BLOCKLIST` (tools/environments/local.py)
 * — but narrower: we only own the provider/cloud-secret floor.
 *
 * @module
 */
import { env as processEnv } from '@gaunt-sloth/core/utils/systemUtils.js';

/**
 * Explicit blocklist of LLM-provider and cloud credentials. Covers the providers
 * gaunt-sloth (and its consumers) can be configured against, plus the standard
 * cloud secret-bearing vars. Matched case-insensitively.
 */
export const CREDENTIAL_BLOCKLIST: ReadonlyArray<string> = [
  // LLM providers
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'COHERE_API_KEY',
  'TOGETHER_API_KEY',
  'PERPLEXITY_API_KEY',
  'FIREWORKS_API_KEY',
  // Azure OpenAI
  'AZURE_OPENAI_API_KEY',
  'AZURE_API_KEY',
  // Cloud provider secrets (AWS / GCP)
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_ACCESS_KEY_ID',
];

/**
 * Allow-list of credential-shaped names that must survive the wildcard sweep
 * because gaunt-sloth legitimately depends on them. Matched case-insensitively.
 */
export const CREDENTIAL_ALLOWLIST: ReadonlyArray<string> = [
  // `gh` CLI auth — used by the github content/requirement providers.
  'GITHUB_TOKEN',
  'GH_TOKEN',
];

// Wildcard sweep: any var whose name ends in one of these suffixes is treated as
// a secret and stripped (unless allow-listed). Catches provider keys we didn't
// enumerate (e.g. a new `FOO_API_KEY`).
const SECRET_SUFFIXES = [
  /_API_KEY$/i,
  /_SECRET_ACCESS_KEY$/i,
  /_SECRET_KEY$/i,
  /_SECRET$/i,
  /_TOKEN$/i,
];

function isAllowlisted(name: string): boolean {
  return CREDENTIAL_ALLOWLIST.some((a) => a.toUpperCase() === name.toUpperCase());
}

function isBlocklisted(name: string): boolean {
  return CREDENTIAL_BLOCKLIST.some((b) => b.toUpperCase() === name.toUpperCase());
}

function matchesSecretSuffix(name: string): boolean {
  return SECRET_SUFFIXES.some((re) => re.test(name));
}

/**
 * True when an env var name should be scrubbed from the child environment.
 * Exported for testing.
 */
export function shouldScrubEnvVar(name: string): boolean {
  if (isAllowlisted(name)) return false;
  if (isBlocklisted(name)) return true;
  return matchesSecretSuffix(name);
}

/**
 * Marker the CLI entry point (`packages/app/cli.js`) sets alongside a `NODE_ENV`
 * it invented for itself, so React resolves to its production build (TUI-C55).
 *
 * It exists because the value carries no provenance: an operator's own
 * `NODE_ENV=production` is byte-identical to the one we synthesize, and the two
 * must be treated differently — theirs is a deliberate instruction to the whole
 * process tree, ours is an implementation detail of how *we* render. Without the
 * marker, stripping `NODE_ENV` from child environments would quietly discard a
 * setting the operator made on purpose.
 *
 * It is an environment variable rather than module state because it has to cross
 * from `packages/app`'s entry script into this package, which that script cannot
 * import from at the point it runs.
 */
export const SYNTHESIZED_NODE_ENV_MARKER = 'GTH_SYNTHESIZED_NODE_ENV';

/**
 * Build the child environment for a spawned shell command: a copy of the parent
 * env with LLM/cloud credentials removed. Defaults to the live `process.env`
 * (via systemUtils); a source can be injected for testing.
 *
 * Also drops a `NODE_ENV` we synthesized ourselves (see
 * {@link SYNTHESIZED_NODE_ENV_MARKER}). Our reason for setting it — picking
 * React's production build for the Ink renderer — has nothing to do with the
 * commands the agent runs, and `NODE_ENV=production` changes real behaviour in a
 * child: it makes `npm install` skip devDependencies, and flips framework build
 * and logging defaults. Inheriting it would mean a shell tool invocation behaved
 * differently depending on whether the user happened to be in the TUI.
 * An operator-set `NODE_ENV` has no marker and is passed through untouched.
 */
export function buildScrubbedEnv(source: NodeJS.ProcessEnv = processEnv): NodeJS.ProcessEnv {
  const synthesizedNodeEnv = Boolean(source[SYNTHESIZED_NODE_ENV_MARKER]);
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (shouldScrubEnvVar(key)) continue;
    // The marker is ours and means nothing to a child, so it never travels.
    if (key === SYNTHESIZED_NODE_ENV_MARKER) continue;
    if (key === 'NODE_ENV' && synthesizedNodeEnv) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}
