import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the config object ChatOllama is constructed with so we can assert on the built model.
const chatOllamaConstructorMock = vi.fn();
vi.mock('@langchain/ollama', () => {
  class ChatOllama {
    constructor(config: unknown) {
      chatOllamaConstructorMock(config);
    }
  }
  return { ChatOllama };
});

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  env: {} as Record<string, string | undefined>,
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const fileUtilsMock = {
  writeConfigFileWithMessages: vi.fn(),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

function buildConfig(overrides: Record<string, unknown> = {}) {
  return { type: 'ollama', ...overrides };
}

describe('ollama provider processJsonConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = {};
  });

  it('builds a ChatOllama pointed at the default local daemon NATIVE base URL (no /v1)', async () => {
    const { processJsonConfig } = await import('#src/providers/ollama.js');

    await processJsonConfig(buildConfig({ model: 'gemma4:31b' }) as any);

    expect(chatOllamaConstructorMock).toHaveBeenCalledTimes(1);
    const builtConfig = chatOllamaConstructorMock.mock.calls[0][0];
    expect(builtConfig.baseUrl).toBe('http://127.0.0.1:11434');
    expect(builtConfig.model).toBe('gemma4:31b');
  });

  it('falls back to the default model when none is configured', async () => {
    const { processJsonConfig } = await import('#src/providers/ollama.js');

    await processJsonConfig(buildConfig() as any);

    const builtConfig = chatOllamaConstructorMock.mock.calls[0][0];
    expect(builtConfig.model).toBe('qwen3-coder');
  });

  it('GS2-59: applies a large default numCtx so agentic prompts are not starved', async () => {
    const { processJsonConfig } = await import('#src/providers/ollama.js');

    await processJsonConfig(buildConfig() as any);

    const builtConfig = chatOllamaConstructorMock.mock.calls[0][0];
    // Well above the ~4000-token agentic prompt (and Ollama's own 4096 default) that blanked gemma,
    // while still fitting constrained consumer VRAM (32768 OOM'd a 19GB model on ~18GB of GPU).
    expect(builtConfig.numCtx).toBe(16384);
  });

  it('GS2-59: honors an explicitly configured numCtx over the default', async () => {
    const { processJsonConfig } = await import('#src/providers/ollama.js');

    await processJsonConfig(buildConfig({ numCtx: 8192 }) as any);

    const builtConfig = chatOllamaConstructorMock.mock.calls[0][0];
    expect(builtConfig.numCtx).toBe(8192);
  });

  it('is keyless: does NOT inject an apiKey (native /api/chat is unauthenticated)', async () => {
    const { processJsonConfig } = await import('#src/providers/ollama.js');

    await processJsonConfig(buildConfig() as any);

    const builtConfig = chatOllamaConstructorMock.mock.calls[0][0];
    expect('apiKey' in builtConfig).toBe(false);
  });

  it('passes through headers as the reverse-proxy auth escape hatch', async () => {
    const { processJsonConfig } = await import('#src/providers/ollama.js');

    await processJsonConfig(
      buildConfig({ headers: { Authorization: 'Bearer proxy-token' } }) as any
    );

    const builtConfig = chatOllamaConstructorMock.mock.calls[0][0];
    expect(builtConfig.headers).toEqual({ Authorization: 'Bearer proxy-token' });
  });

  // [[EXT-180]] — the fast half of the ollama abort bridge. That the composed signal actually
  // closes a socket is measured in `abortDrainsProcess.spec.ts`; these two only pin that the
  // shipped provider installs the wrapper at all, which is the part a tidy-up would delete.
  it('installs a fetch that carries a call deadline signal onto the request', async () => {
    // The base is supplied through the config so the INSTALLED wrapper is the thing exercised —
    // rebuilding one from the module here would assert about the module and prove nothing about
    // whether the provider wires it in.
    const base = vi.fn(async () => new Response('ok'));
    const { processJsonConfig } = await import('#src/providers/ollama.js');
    const { runWithCallSignal } = await import('#src/runtime/callSignalContext.js');

    await processJsonConfig(buildConfig({ fetch: base }) as any);

    const builtConfig = chatOllamaConstructorMock.mock.calls[0][0] as { fetch: typeof fetch };
    expect(builtConfig.fetch).not.toBe(base);

    const controller = new AbortController();
    await runWithCallSignal(controller.signal, () => builtConfig.fetch('http://127.0.0.1/x'));

    // Delegated, so a caller-supplied fetch is wrapped rather than discarded...
    expect(base).toHaveBeenCalledTimes(1);
    // ...and carrying the deadline's signal, which is the whole point.
    expect((base.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: controller.signal });
  });

  it('leaves a request untouched when no call deadline is running', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const { processJsonConfig } = await import('#src/providers/ollama.js');

    await processJsonConfig(buildConfig({ fetch: base }) as any);

    const builtConfig = chatOllamaConstructorMock.mock.calls[0][0] as { fetch: typeof fetch };
    // Without this the cell is decorative: if the wrapper were dropped entirely, `builtConfig.fetch`
    // WOULD be `base`, and the pass-through assertion below would pass for the wrong reason. The
    // claim is that the WRAPPER adds nothing outside a deadline, so there has to be a wrapper.
    expect(builtConfig.fetch).not.toBe(base);
    await builtConfig.fetch('http://127.0.0.1/x', { method: 'POST' });

    expect(base).toHaveBeenCalledWith('http://127.0.0.1/x', { method: 'POST' });
  });

  it('honors an explicit config baseUrl over OLLAMA_HOST and the default', async () => {
    systemUtilsMock.env = { OLLAMA_HOST: 'http://192.168.1.50:11434' };
    const { processJsonConfig } = await import('#src/providers/ollama.js');

    await processJsonConfig(buildConfig({ baseUrl: 'http://remote-ollama:9999' }) as any);

    const builtConfig = chatOllamaConstructorMock.mock.calls[0][0];
    expect(builtConfig.baseUrl).toBe('http://remote-ollama:9999');
  });

  it('derives the NATIVE base URL from a full-URL OLLAMA_HOST override (no /v1)', async () => {
    systemUtilsMock.env = { OLLAMA_HOST: 'http://192.168.1.50:11434' };
    const { processJsonConfig } = await import('#src/providers/ollama.js');

    await processJsonConfig(buildConfig() as any);

    const builtConfig = chatOllamaConstructorMock.mock.calls[0][0];
    expect(builtConfig.baseUrl).toBe('http://192.168.1.50:11434');
  });

  it('derives the NATIVE base URL from a bare host:port OLLAMA_HOST override', async () => {
    systemUtilsMock.env = { OLLAMA_HOST: '127.0.0.1:1234' };
    const { processJsonConfig } = await import('#src/providers/ollama.js');

    await processJsonConfig(buildConfig() as any);

    const builtConfig = chatOllamaConstructorMock.mock.calls[0][0];
    expect(builtConfig.baseUrl).toBe('http://127.0.0.1:1234');
  });

  it('strips a trailing slash from OLLAMA_HOST', async () => {
    systemUtilsMock.env = { OLLAMA_HOST: 'http://127.0.0.1:11434/' };
    const { processJsonConfig } = await import('#src/providers/ollama.js');

    await processJsonConfig(buildConfig() as any);

    const builtConfig = chatOllamaConstructorMock.mock.calls[0][0];
    expect(builtConfig.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('strips internal / OpenAI-client keys (type, apiKeyEnvironmentVariable, configuration) from the built model', async () => {
    const { processJsonConfig } = await import('#src/providers/ollama.js');

    await processJsonConfig(
      buildConfig({
        apiKeyEnvironmentVariable: 'OLLAMA_HOST',
        configuration: { timeout: 5000 },
      }) as any
    );

    const builtConfig = chatOllamaConstructorMock.mock.calls[0][0];
    expect('type' in builtConfig).toBe(false);
    expect('apiKeyEnvironmentVariable' in builtConfig).toBe(false);
    expect('configuration' in builtConfig).toBe(false);
  });
});

describe('ollama provider init', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = {};
  });

  it('writes the default JSON config and warns the user', async () => {
    const { init } = await import('#src/providers/ollama.js');

    init('.gsloth.config.json');

    expect(fileUtilsMock.writeConfigFileWithMessages).toHaveBeenCalledTimes(1);
    const [fileName, content, force] = fileUtilsMock.writeConfigFileWithMessages.mock.calls[0];
    expect(fileName).toBe('.gsloth.config.json');
    expect(content).toContain('"type": "ollama"');
    expect(force).toBe(false);
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
  });

  it('overwrites the config when called with force', async () => {
    const { init } = await import('#src/providers/ollama.js');

    init('.gsloth.config.json', true);

    expect(fileUtilsMock.writeConfigFileWithMessages).toHaveBeenCalledTimes(1);
    const [, , force] = fileUtilsMock.writeConfigFileWithMessages.mock.calls[0];
    expect(force).toBe(true);
  });

  it('rejects non-JSON config file names', async () => {
    const { init } = await import('#src/providers/ollama.js');

    expect(() => init('.gsloth.config.js')).toThrow('Only JSON config is supported.');
  });
});
