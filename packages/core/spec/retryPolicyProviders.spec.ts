import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EXT-92 scope (c) — every provider this repo constructs is given the stated retry count.
 *
 * `retryPolicy.spec.ts` proves the number produces the attempts. This file proves it REACHES every
 * model we build, which is the half that rots: a provider added later, or a factory refactored to
 * build its config a different way, silently goes back to inheriting whatever upstream defaults to,
 * with nothing failing. The table below is therefore keyed on the provider modules themselves — a
 * new provider with no row here is caught by the completeness check at the bottom rather than
 * quietly skipped.
 *
 * ## The expectations are hardcoded literals on purpose
 *
 * Asserting `maxRetries === GTH_MAX_RETRIES` would pass for every possible value and so assert
 * nothing. `6` fails when the constant moves, which is what the node's acceptance asks for. Update
 * the literal deliberately if the count is ever changed.
 */

const constructorSpies = {
  openai: vi.fn(),
  openrouter: vi.fn(),
  ollama: vi.fn(),
  anthropic: vi.fn(),
  groq: vi.fn(),
  google: vi.fn(),
  deepseek: vi.fn(),
  xai: vi.fn(),
};

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    constructor(config: unknown) {
      constructorSpies.openai(config);
    }
  },
}));
vi.mock('@langchain/openrouter', () => ({
  ChatOpenRouter: class {
    constructor(config: unknown) {
      constructorSpies.openrouter(config);
    }
  },
}));
vi.mock('@langchain/ollama', () => ({
  ChatOllama: class {
    constructor(config: unknown) {
      constructorSpies.ollama(config);
    }
  },
}));
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {
    constructor(config: unknown) {
      constructorSpies.anthropic(config);
    }
  },
}));
vi.mock('@langchain/groq', () => ({
  ChatGroq: class {
    constructor(config: unknown) {
      constructorSpies.groq(config);
    }
  },
}));
vi.mock('@langchain/google/node', () => ({
  ChatGoogle: class {
    constructor(config: unknown) {
      constructorSpies.google(config);
    }
  },
}));
vi.mock('@langchain/deepseek', () => ({
  ChatDeepSeek: class {
    constructor(config: unknown) {
      constructorSpies.deepseek(config);
    }
  },
}));
vi.mock('@langchain/xai', () => ({
  ChatXAI: class {
    constructor(config: unknown) {
      constructorSpies.xai(config);
    }
  },
}));

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = { env: {} as Record<string, string | undefined> };
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

vi.mock('#src/utils/fileUtils.js', () => ({ writeConfigFileWithMessages: vi.fn() }));

// The Gemini factories wrap their model in two decorators before returning it. Neither touches the
// constructor config this file asserts on, but both would choke on the bare stub above, so they are
// reduced to identity — this file is about what reaches the constructor, not about the wrapping.
vi.mock('#src/providers/geminiSchemaSanitizer.js', () => ({
  applyGeminiToolSchemaSanitizer: <T>(model: T) => model,
}));
vi.mock('#src/providers/geminiThinking.js', () => ({
  applyGeminiThoughtSummaries: <T>(model: T) => model,
}));

type ProviderModule = { processJsonConfig: (llmConfig: never) => unknown };

/**
 * Every provider factory, the constructor it is expected to reach, and a minimal working config.
 *
 * `fake` is deliberately absent: it is a test double for a model, not a provider that talks to
 * anything, so there is no request for a retry count to bound. The completeness check below names
 * it as the one permitted omission rather than ignoring the file, so a real provider cannot be
 * dropped through the same gap.
 */
const PROVIDERS: ReadonlyArray<{
  provider: string;
  spy: keyof typeof constructorSpies;
  load: () => Promise<ProviderModule>;
  llmConfig: Record<string, unknown>;
}> = [
  {
    provider: 'openai',
    spy: 'openai',
    load: () => import('#src/providers/openai.js'),
    llmConfig: { type: 'openai', apiKey: 'sk-test', model: 'gpt-4o' },
  },
  {
    provider: 'anthropic',
    spy: 'anthropic',
    load: () => import('#src/providers/anthropic.js'),
    llmConfig: { type: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-5' },
  },
  {
    provider: 'deepseek',
    spy: 'deepseek',
    load: () => import('#src/providers/deepseek.js'),
    llmConfig: { type: 'deepseek', apiKey: 'ds-test', model: 'deepseek-chat' },
  },
  {
    provider: 'groq',
    spy: 'groq',
    load: () => import('#src/providers/groq.js'),
    llmConfig: { type: 'groq', apiKey: 'gsk-test', model: 'llama-3.3-70b-versatile' },
  },
  {
    provider: 'xai',
    spy: 'xai',
    load: () => import('#src/providers/xai.js'),
    llmConfig: { type: 'xai', apiKey: 'xai-test', model: 'grok-4' },
  },
  {
    provider: 'google-genai',
    spy: 'google',
    load: () => import('#src/providers/google-genai.js'),
    llmConfig: { type: 'google-genai', apiKey: 'goog-test', model: 'gemini-3-pro-preview' },
  },
  {
    provider: 'vertexai',
    spy: 'google',
    load: () => import('#src/providers/vertexai.js'),
    llmConfig: { type: 'vertexai', model: 'gemini-3-pro-preview' },
  },
  {
    provider: 'openrouter',
    spy: 'openrouter',
    load: () => import('#src/providers/openrouter.js'),
    llmConfig: { type: 'openrouter', model: 'x-ai/grok' },
  },
  {
    provider: 'huggingface',
    spy: 'openai',
    load: () => import('#src/providers/huggingface.js'),
    llmConfig: { type: 'huggingface', apiKey: 'hf-test', model: 'openai/gpt-oss-120b' },
  },
  {
    // ollama ACCEPTS the parameter and does nothing with it — every one of its chat paths bypasses
    // the caller that would enforce it. It is asserted here all the same: the value is meant to be
    // uniform across everything we construct, and the day upstream wires the caller in, this row is
    // what says the number was already being passed. The inertness is argued at the call site.
    provider: 'ollama',
    spy: 'ollama',
    load: () => import('#src/providers/ollama.js'),
    llmConfig: { type: 'ollama', model: 'gemma4:12b' },
  },
];

/** The config object the provider's model constructor was actually built with. */
function constructedWith(spy: keyof typeof constructorSpies): Record<string, unknown> {
  expect(constructorSpies[spy]).toHaveBeenCalledTimes(1);
  return constructorSpies[spy].mock.calls[0][0] as Record<string, unknown>;
}

describe('EXT-92 — the stated retry count reaches every provider we construct', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = { OPEN_ROUTER_API_KEY: 'test-key' };
  });

  it.each(PROVIDERS)(
    '$provider is built with the stated count',
    async ({ spy, load, llmConfig }) => {
      const { processJsonConfig } = await load();

      await processJsonConfig(llmConfig as never);

      // The literal is the gate. Change GTH_MAX_RETRIES and every row here fails.
      expect(constructedWith(spy).maxRetries).toBe(6);
    }
  );

  /**
   * The count is a DEFAULT, not an override.
   *
   * This is the regression the wiring most easily introduces: writing the constant after the spread
   * of the user's config silently discards a `maxRetries` the user set, which before this change
   * flowed through and won. A user who deliberately asks for no retries must still get none.
   */
  it.each(PROVIDERS)("$provider keeps a user's own count", async ({ spy, load, llmConfig }) => {
    const { processJsonConfig } = await load();

    await processJsonConfig({ ...llmConfig, maxRetries: 0 } as never);

    expect(constructedWith(spy).maxRetries).toBe(0);
  });

  /**
   * A provider module with no row above is a provider silently inheriting an upstream default. The
   * table cannot notice its own omissions, so the directory is read instead.
   */
  it('has a row for every provider factory in the directory', async () => {
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const providerDir = fileURLToPath(new URL('../src/providers/', import.meta.url));

    const factories: string[] = [];
    for (const entry of readdirSync(providerDir)) {
      if (!entry.endsWith('.ts')) continue;
      const source = await import('node:fs').then((fs) =>
        fs.readFileSync(providerDir + entry, 'utf8')
      );
      // A provider factory is a module exporting `processJsonConfig`; the helper modules beside them
      // (schema sanitizer, model catalog, discovery, passthrough warnings) do not.
      if (/export\s+(async\s+)?function\s+processJsonConfig/.test(source)) {
        factories.push(entry.replace(/\.ts$/, ''));
      }
    }

    const covered = new Set(PROVIDERS.map((row) => row.provider));
    // `fake` is a model stub for tests, not a provider that issues requests.
    const uncovered = factories.filter((name) => name !== 'fake' && !covered.has(name));

    expect(uncovered).toEqual([]);
    // Guard against the check passing because the scan found nothing at all.
    expect(factories.length).toBeGreaterThanOrEqual(PROVIDERS.length);
  });
});
