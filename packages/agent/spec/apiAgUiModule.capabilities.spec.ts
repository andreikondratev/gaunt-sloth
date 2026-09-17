import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentCapabilitiesSchema, EventType } from '@ag-ui/core';
import type { GthConfig } from '#src/config.js';
import type { GthAdvertisedTools } from '@gaunt-sloth/core/core/types.js';

/**
 * [[EXT-166]] — `GET /agents/:agentId/capabilities`.
 *
 * **`@ag-ui/core` is deliberately NOT mocked here**, unlike in `apiAgUiModule.spec.ts`, which
 * stubs it with a hand-written `EventType` map. That stub is why the existing suite would stay
 * green through a renamed event or a changed schema, and the one assertion that would not is the
 * one below: the body parsed by the **shipped** `AgentCapabilitiesSchema`.
 */

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
  defaultStatusCallback: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const llmUtilsMock = {
  getNewRunnableConfig: vi.fn().mockReturnValue({}),
  buildSystemMessages: vi.fn().mockReturnValue([]),
  readChatPrompt: vi.fn().mockReturnValue(''),
};
vi.mock('#src/utils/llmUtils.js', () => llmUtilsMock);

const agentInitMock = vi.fn();
const agentAdvertisedToolsMock = vi.fn();
const agentStreamWithEventsMock = vi.fn();
vi.mock('@gaunt-sloth/core/core/GthLangChainAgent.js', () => {
  const GthLangChainAgent = vi.fn();
  GthLangChainAgent.prototype.init = agentInitMock;
  GthLangChainAgent.prototype.getAdvertisedTools = agentAdvertisedToolsMock;
  GthLangChainAgent.prototype.streamWithEvents = agentStreamWithEventsMock;
  return { GthLangChainAgent };
});

const mockUseFn = vi.fn();
const mockPostFn = vi.fn();
const mockGetFn = vi.fn();
const mockListenFn = vi.fn();
const mockExpressApp = { use: mockUseFn, post: mockPostFn, get: mockGetFn, listen: mockListenFn };
const expressMock = Object.assign(
  vi.fn(() => mockExpressApp),
  { json: vi.fn(() => 'json-middleware') }
);
vi.mock('express', () => ({ default: expressMock }));

type RouteHandler = (_req: unknown, _res: unknown) => unknown;

function makeRes() {
  return {
    json: vi.fn(),
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    status: vi.fn().mockReturnThis(),
    on: vi.fn(),
  };
}

/** A server that never binds a socket: the boot promise settles off this fake, as in the sibling spec. */
function fakeServer(port: number) {
  return {
    listening: true,
    address: () => ({ address: '127.0.0.1', family: 'IPv4', port }),
    on() {
      return this;
    },
  };
}

/**
 * The handler the MOST RECENT boot registered at `path`.
 *
 * Most recent, not first: a cell that boots two servers to compare their answers appends a second
 * registration to the same mock, and taking the first would hand it the previous config's handler —
 * two calls returning one server's answer, which reads as "the response does not follow the config"
 * when the response follows it perfectly.
 */
function handlerFor(path: string): RouteHandler {
  const calls = mockGetFn.mock.calls.filter(([registered]) => registered === path);
  expect(calls.length, `no GET route registered at ${path}`).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as RouteHandler;
}

/** Boot a server on the mocked express app and return what the capabilities route answers. */
async function capabilitiesOf(config: Partial<GthConfig>) {
  const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
  await startAgUiServer(config as GthConfig, 3000);
  const res = makeRes();
  handlerFor('/agents/:agentId/capabilities')({ params: { agentId: 'default' } }, res);
  expect(res.json).toHaveBeenCalledTimes(1);
  return res.json.mock.calls[0][0] as Record<string, unknown>;
}

/** A tool as `config.tools` holds one — name, description and a schema, nothing else is read. */
function fakeTool(name: string, description: string, schema?: unknown, client = false) {
  return {
    name,
    description,
    ...(schema ? { schema } : {}),
    ...(client ? { metadata: { client: true } } : {}),
  };
}

function inventory(tools: string[], filteredOut: string[] = []): GthAdvertisedTools {
  const describe = (name: string) =>
    name.startsWith('mcp__') ? { name, server: name.split('__')[1] } : { name };
  return {
    tools: tools.map(describe),
    filteredOut: filteredOut.map(describe),
    unnamed: 0,
  };
}

const baseConfig = { commands: { api: { port: 3000 } } } as Partial<GthConfig>;

describe('apiAgUiModule capabilities endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentInitMock.mockResolvedValue(undefined);
    agentAdvertisedToolsMock.mockReturnValue(undefined);
    agentStreamWithEventsMock.mockReturnValue((async function* () {})());
    mockListenFn.mockImplementation((port: number, _host: string, cb: () => void) => {
      queueMicrotask(cb);
      return fakeServer(port);
    });
  });

  // ─── the route, and a control that tells it apart from the run route ───────

  it('registers the capabilities route without disturbing the run route', async () => {
    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
    await startAgUiServer(baseConfig as GthConfig, 3000);

    const getPaths = mockGetFn.mock.calls.map(([path]) => path);
    expect(getPaths).toContain('/agents/:agentId/capabilities');

    const runRegistrations = mockPostFn.mock.calls.filter(
      ([path]) => path === '/agents/:agentId/run'
    );
    expect(runRegistrations).toHaveLength(1);
    expect(mockPostFn.mock.calls).toHaveLength(1);
    expect(runRegistrations[0][1]).not.toBe(handlerFor('/agents/:agentId/capabilities'));
  });

  it('does not answer a run request with a capability declaration', async () => {
    // The control for every cell below: they read `res.json`, so they must be able to fail when
    // the declaration is wired into the wrong handler. The run route streams and never calls it.
    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
    await startAgUiServer(baseConfig as GthConfig, 3000);

    const runHandler = mockPostFn.mock.calls[0][1] as RouteHandler;
    const res = makeRes();
    await runHandler(
      { body: { threadId: 't', runId: 'r', messages: [] }, headers: {}, method: 'POST' },
      res
    );

    expect(res.json).not.toHaveBeenCalled();
    const written = res.write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).not.toContain('clientProvided');
    expect(written).not.toContain('langgraph');
  });

  // ─── the shipped schema, not a stand-in ───────────────────────────────────

  it('answers a body the real AgentCapabilitiesSchema accepts', async () => {
    agentAdvertisedToolsMock.mockReturnValue(inventory(['read_file', 'mcp__unimarket__search']));
    const body = await capabilitiesOf({
      ...baseConfig,
      tools: [fakeTool('read_file', 'Read a file', z.object({ path: z.string() }))],
      modelDisplayName: 'claude-sonnet-5',
    } as Partial<GthConfig>);

    const parsed = AgentCapabilitiesSchema.safeParse(body);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  // ─── derived from the live configuration ──────────────────────────────────

  it('reports the model and provider the config resolves, not a fixed pair', async () => {
    // Keyed on a pure config read with no mocked intermediary: two configs, two answers.
    const ollama = await capabilitiesOf({
      ...baseConfig,
      llm: { _llmType: () => 'ollama', model: 'gemma4:12b' },
    } as Partial<GthConfig>);
    const anthropic = await capabilitiesOf({
      ...baseConfig,
      llm: { _llmType: () => 'anthropic' },
      modelDisplayName: 'claude-sonnet-5',
    } as Partial<GthConfig>);

    const identityOf = (body: Record<string, unknown>) =>
      (body.identity as { metadata: Record<string, unknown> }).metadata;
    expect(identityOf(ollama)).toMatchObject({ llmProvider: 'ollama', model: 'gemma4:12b' });
    expect(identityOf(anthropic)).toMatchObject({
      llmProvider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    expect(identityOf(ollama)).not.toEqual(identityOf(anthropic));
  });

  it('declares the command the server started its agent as', async () => {
    const body = await capabilitiesOf(baseConfig);
    const metadata = (body.identity as { metadata: Record<string, unknown> }).metadata;
    expect(metadata.command).toBe('api');
    expect(agentInitMock).toHaveBeenCalledWith('api', expect.anything(), expect.anything());
  });

  it('describes the tools the configuration holds, not a fixed list', async () => {
    const withGrep = await capabilitiesOf({
      ...baseConfig,
      tools: [fakeTool('grep', 'Search the tree', z.object({ pattern: z.string() }))],
    } as Partial<GthConfig>);
    const withFetch = await capabilitiesOf({
      ...baseConfig,
      tools: [fakeTool('fetch', 'Fetch a URL')],
    } as Partial<GthConfig>);

    const itemsOf = (body: Record<string, unknown>) =>
      (body.tools as { items: { name: string; description: string; parameters?: unknown }[] })
        .items;
    expect(itemsOf(withGrep)).toEqual([
      {
        name: 'grep',
        description: 'Search the tree',
        parameters: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({ pattern: expect.anything() }),
        }),
      },
    ]);
    expect(itemsOf(withFetch)).toEqual([{ name: 'fetch', description: 'Fetch a URL' }]);
    expect(itemsOf(withGrep)).not.toEqual(itemsOf(withFetch));
  });

  it('takes the tool list from the agent inventory, not from config.tools alone', async () => {
    // The inventory is the whole point: `config.tools` is a strict subset of what the run path
    // binds, so a declaration built from it alone omits every resolver-loaded tool. The two halves
    // of this cell must DIFFER, or the inventory path is untested and only the fallback ships.
    const config = {
      ...baseConfig,
      tools: [fakeTool('read_file', 'Read a file')],
    } as Partial<GthConfig>;

    agentAdvertisedToolsMock.mockReturnValue(inventory(['read_file', 'mcp__unimarket__search']));
    const withInventory = await capabilitiesOf(config);

    agentAdvertisedToolsMock.mockReturnValue(undefined);
    const withoutInventory = await capabilitiesOf(config);

    const itemsOf = (body: Record<string, unknown>) =>
      (body.tools as { items: { name: string; description: string; metadata?: unknown }[] }).items;
    expect(itemsOf(withInventory)).toEqual([
      { name: 'read_file', description: 'Read a file' },
      { name: 'mcp__unimarket__search', description: '', metadata: { server: 'unimarket' } },
    ]);
    expect(itemsOf(withoutInventory)).toEqual([{ name: 'read_file', description: 'Read a file' }]);
    expect(itemsOf(withInventory)).not.toEqual(itemsOf(withoutInventory));
  });

  it('does not offer a tool the allowedTools filter removed', async () => {
    agentAdvertisedToolsMock.mockReturnValue(inventory(['read_file', 'run_shell'], ['run_shell']));
    const body = await capabilitiesOf({
      ...baseConfig,
      tools: [fakeTool('read_file', 'Read a file'), fakeTool('run_shell', 'Run a command')],
    } as Partial<GthConfig>);

    const items = (body.tools as { items: { name: string }[] }).items;
    expect(items.map((item) => item.name)).toEqual(['read_file']);
  });

  it('declares a client-fulfilled tool through clientProvided, never as a tool it provides', async () => {
    agentAdvertisedToolsMock.mockReturnValue(inventory(['read_file', 'drive_robot']));
    const body = await capabilitiesOf({
      ...baseConfig,
      tools: [
        fakeTool('read_file', 'Read a file'),
        fakeTool('drive_robot', 'Drive the robot', undefined, true),
      ],
    } as Partial<GthConfig>);

    const tools = body.tools as { items: { name: string }[]; clientProvided: boolean };
    expect(tools.items.map((item) => item.name)).toEqual(['read_file']);
    expect(tools.clientProvided).toBe(true);
  });

  // ─── what is deliberately absent, and what is deliberately false ──────────

  it('leaves humanInTheLoop undeclared', async () => {
    // Pinned so a later edit cannot "complete" the block: this surface wires no tool-approval
    // callback, and `approvals: true` would promise a human review that nothing performs.
    const body = await capabilitiesOf(baseConfig);
    expect('humanInTheLoop' in body).toBe(false);
    expect(Object.keys(body)).not.toContain('humanInTheLoop');
  });

  it('declares the state categories false, because the run path emits no state events', async () => {
    const body = await capabilitiesOf(baseConfig);
    expect(body.state).toEqual({ snapshots: false, deltas: false });
    expect(body.reasoning).toEqual({ supported: true, streaming: true });
    expect(body.transport).toEqual({ streaming: true });
    expect((body.tools as { supported: boolean }).supported).toBe(true);
  });

  it('takes its identity from the shipped package manifest', async () => {
    // The fail-soft manifest read degrades to omitted fields, so an identity that quietly stopped
    // resolving would look like a deliberate silence. This is what tells the two apart — and what
    // stops the block being replaced by hand-written strings that drift from the package.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    ) as { name: string; version: string; description: string; homepage: string; author: string };

    const body = await capabilitiesOf(baseConfig);
    const identity = body.identity as Record<string, unknown>;
    expect(identity.name).toBe(manifest.name);
    expect(identity.version).toBe(manifest.version);
    expect(identity.description).toBe(manifest.description);
    expect(identity.documentationUrl).toBe(manifest.homepage);
    expect(identity.provider).toBe(manifest.author);
  });

  it('still answers when the agent cannot report its inventory', async () => {
    agentAdvertisedToolsMock.mockImplementation(() => {
      throw new Error('inventory unavailable');
    });
    const body = await capabilitiesOf({
      ...baseConfig,
      tools: [fakeTool('read_file', 'Read a file')],
    } as Partial<GthConfig>);

    expect(AgentCapabilitiesSchema.safeParse(body).success).toBe(true);
    expect((body.tools as { items: { name: string }[] }).items.map((i) => i.name)).toEqual([
      'read_file',
    ]);
  });

  // ─── the tripwire under the event-derived categories ──────────────────────

  it('holds AG_UI_EMITTED_EVENT_TYPES equal to what the run path actually emits', async () => {
    // `transport`, `tools.supported`, `state` and `reasoning` are projections of that constant, so
    // it is the one place the server's emissions are written down twice. Equality, not containment:
    // the drift worth catching is an emission the run path gained and the constant never heard of.
    const source = fileURLToPath(new URL('../src/modules/apiAgUiModule.ts', import.meta.url));
    expect(existsSync(source), `run path source not found at ${source}`).toBe(true);

    const emitted = new Set(
      [...readFileSync(source, 'utf8').matchAll(/type:\s*EventType\.([A-Z_]+)/g)].map(
        ([, name]) => name
      )
    );
    // An unreadable file, or a scan that matches nothing, would compare two empty sets and pass
    // vacuously — the exact failure this cell exists to prevent elsewhere.
    expect(emitted.size).toBeGreaterThan(0);

    const { AG_UI_EMITTED_EVENT_TYPES } = await import('#src/modules/agUiCapabilities.js');
    expect([...emitted].sort()).toEqual([...AG_UI_EMITTED_EVENT_TYPES].sort());
    expect(AG_UI_EMITTED_EVENT_TYPES.has(EventType.STATE_SNAPSHOT)).toBe(false);
    expect(AG_UI_EMITTED_EVENT_TYPES.has(EventType.STATE_DELTA)).toBe(false);
  });
});
