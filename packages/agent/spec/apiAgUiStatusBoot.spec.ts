import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { GthConfig } from '#src/config.js';

/**
 * CFG-61 — the boot assertion for the two status endpoints.
 *
 * Deliberately a separate file from `apiAgUiModule.spec.ts`, which mocks express wholesale and
 * invokes the registered handlers by hand. That mock is the right tool for the run handler's
 * event stream, and it is the wrong tool here: a handler called directly proves what the function
 * returns, never that a server which actually booted and bound answers that way over HTTP. The
 * defect this node names is that every outward check — a CI probe, a port smoke test, a liveness
 * probe — passes against a server that cannot answer a run, and only a real socket can stand where
 * those checks stand. So nothing is mocked here: the real express, the real agent init, a real
 * listen, a real `fetch`.
 *
 * Port 0 throughout, so these cells cannot collide with a sibling worktree running its own server
 * (or with each other), and the bound port is read off `server.address()`.
 *
 * Every cell is one half of a PAIR. The assertion that matters is the DIFFERENTIAL: the same
 * request against the same code answers differently depending only on whether a model resolved. A
 * cell that checked one fixture could not tell a derived answer from a literal that happens to
 * agree with it, which is exactly how the behaviour being fixed here went unnoticed.
 */

/** The config fields the server and the agent read on the way up, with no model. */
const baseConfig = {
  projectGuidelines: '.gsloth.guidelines.md',
  projectReviewInstructions: '.gsloth.review.md',
  streamOutput: false,
  commands: {},
} as Partial<GthConfig> as GthConfig;

/**
 * A config that reaches the endpoints carrying nothing usable. `llm: {}` rather than an absent
 * `llm`, and the difference is not cosmetic — see the boundary cell at the bottom of this file. An
 * absent `llm` dies inside the agent before the server ever binds, so it can prove nothing about
 * what these endpoints answer; an empty object sails through that same code and binds a server
 * that then reported itself healthy. This is the shape the endpoints have to be right about.
 */
const unresolvedConfig = { ...baseConfig, llm: {} } as Partial<GthConfig> as GthConfig;

/**
 * A model as far as this server is concerned: it answers a call. Nothing here talks to a provider,
 * and it deliberately does not carry `bindTools` — a model without tool support is still a model,
 * and the server must report it as one.
 */
const resolvedConfig = {
  ...baseConfig,
  llm: { invoke: async () => ({}), _llmType: () => 'ollama', model: 'gemma4:12b' },
} as Partial<GthConfig> as GthConfig;

/**
 * The shape that made this a node: a raw `{ type, model }` spec that no provider layer ever built,
 * beside the display name the user asked for. It looks configured and cannot answer anything.
 */
const askedForButNeverBuilt = {
  ...baseConfig,
  llm: { type: 'openai', model: 'gpt-5.4' },
  modelDisplayName: 'gpt-5.4',
} as Partial<GthConfig> as GthConfig;

let running: Server | undefined;

afterEach(async () => {
  if (running) {
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = undefined;
  }
});

/** Boot the real server on an OS-chosen port and GET `path` off the socket it actually bound. */
async function bootAndGet(config: GthConfig, path: string) {
  const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
  running = await startAgUiServer(config, 0);
  const address = running.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  expect(port, 'the server must have bound a real port').toBeTypeOf('number');
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('a booted AG-UI server answers /health from the model, not from the request', () => {
  it('answers 200 ok when a model resolved', async () => {
    const { status, body } = await bootAndGet(resolvedConfig, '/health');

    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });

  it('answers 503, not ok, when nothing usable resolved', async () => {
    const { status, body } = await bootAndGet(unresolvedConfig, '/health');

    expect(status).toBe(503);
    expect(body.status).not.toBe('ok');
    expect(body.status).toBe('error');
  });

  it('answers 503 for a raw spec nothing built, however configured it looks', async () => {
    const { status, body } = await bootAndGet(askedForButNeverBuilt, '/health');

    expect(status).toBe(503);
    expect(body.status).toBe('error');
  });
});

describe('a booted AG-UI server answers /info from the model, not from the request', () => {
  it('names the provider and model off the resolved model', async () => {
    const { status, body } = await bootAndGet(resolvedConfig, '/info');

    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', provider: 'ollama', model: 'gemma4:12b' });
  });

  it('says error beside two nulls when nothing usable resolved', async () => {
    const { status, body } = await bootAndGet(unresolvedConfig, '/info');

    // 200 on purpose — the metadata request succeeded, and the payload is the answer.
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'error', provider: null, model: null });
  });

  it('never names a model the config asked for and nothing built', async () => {
    const { body } = await bootAndGet(askedForButNeverBuilt, '/info');

    expect(body.status).toBe('error');
    expect(body.model).toBeNull();
    expect(body.provider).toBeNull();
    // The whole payload, not just the fields above: a server with no model must not leak the name
    // it was asked for through any key of this response.
    expect(JSON.stringify(body)).not.toContain('gpt-5.4');
  });
});

describe('the boundary: which no-model configs reach these endpoints at all', () => {
  /**
   * Pinned because it decides what the cells above can be written with, and a reader who does not
   * know it will "simplify" `unresolvedConfig` to an absent `llm` and turn six assertions into a
   * crash — which vitest reports as a failure of the endpoint, naming a file that is not at fault.
   *
   * An absent `llm` never reaches a bound socket: the agent refuses the config on the way up and
   * throws before `listen`. EXT-186 is what makes that refusal say so — it used to be
   * `TypeError: Cannot read properties of undefined (reading 'bindTools')`, a message naming
   * neither the config nor the key — and this cell is the AG-UI half of that node's acceptance, as
   * well as the boundary it always was.
   *
   * Both halves of the boundary are asserted, and they must stay that way: an absent `llm` is
   * refused, and `unresolvedConfig` (`llm: {}`) is NOT — the control cell below says so directly,
   * and the six endpoint assertions above depend on it. That pair is what forbids keying the
   * refusal on whether the model is USABLE: `isUsableModel` is false for `llm: {}` and false for
   * the raw `{ type, model }` spec in `askedForButNeverBuilt`, so a usability-keyed refusal would
   * take down every cell in this file.
   */
  it('a config with no llm key at all never binds, and says which key is missing', async () => {
    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
    const { isConfigDiscoveryError } = await import('#src/config.js');

    const failure = await startAgUiServer(baseConfig, 0).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(isConfigDiscoveryError(failure)).toBe(true);
    expect((failure as Error).message).toContain('has no llm');
    expect((failure as Error).message).toContain('llm.type');
    expect((failure as Error).message).not.toContain('bindTools');
  });

  it('CONTROL: an llm that is merely unusable still binds, which is what the cells above need', async () => {
    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');

    running = await startAgUiServer(unresolvedConfig, 0);

    expect(running.address()).not.toBeNull();
  });
});
