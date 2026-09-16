/**
 * EXT-121 — `GthLangChainAgent.init` refuses to build a graph that will interrupt with no
 * checkpointer to suspend into.
 *
 * Suspending a graph writes a checkpoint, so an interrupt with no saver raises LangGraph's
 * `MISSING_CHECKPOINTER` from inside `interrupt()` — mid-turn, on the user's first gated tool call,
 * in a vocabulary naming nothing the user configured. `init` holds both facts, so it checks them.
 *
 * ## What these cells pin, and why it takes more than two of them
 *
 * The guard's condition is a **conjunction** — a saver was omitted AND something will interrupt —
 * and the left conjunct is itself a **disjunction** over the two independent ways `init` installs an
 * interrupt. Each of those three claims needs its own cell, because a wrong implementation passes
 * the others:
 *
 * - **Throws on interrupts + no saver.** The headline behaviour.
 * - **Silent on no interrupts + no saver.** Omitting the saver is legitimate and common — a graph
 *   that never interrupts never checkpoints. This is what stops the guard being "simplified" into a
 *   required third parameter.
 * - **Silent on interrupts + a saver.** Without this, a guard that ignored the checkpointer
 *   entirely and fired on interrupts alone would pass every other cell here. This is the only cell
 *   that pins the conjunction rather than its left half.
 * - **Throws on a client-fulfilled tool even when the approval interrupt set is EMPTY.** The second
 *   installer. `commandAnswersApprovals('api') === false`, so an AG-UI graph carries no approval
 *   interrupt while its client tools interrupt for real. A guard keyed on the approval set alone
 *   would wave through exactly the surface [[EXT-119]] reached a user from, and would pass all
 *   three cells above.
 * - **Silent on the same `api` graph with an ordinary tool.** The control for the cell above: it is
 *   the `client` marker doing the work there, not merely "the command is `api`".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_TOOL_NAME, type GthConfig } from '#src/config.js';
import type { StatusUpdateCallback } from '#src/core/types.js';
import { MemorySaver } from '@langchain/langgraph';

vi.mock('#src/utils/consoleUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/consoleUtils.js')>();
  return {
    ...actual,
    display: vi.fn(),
    displayInfo: vi.fn(),
    displayWarning: vi.fn(),
    displayError: vi.fn(),
    displaySuccess: vi.fn(),
    displayDebug: vi.fn(),
    displayToolIndication: vi.fn(),
  };
});

const createAgentMock = vi.fn();
vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof import('langchain')>('langchain');
  return { ...actual, createAgent: createAgentMock };
});

vi.mock('#src/middleware/registry.js', () => ({ resolveMiddleware: vi.fn(async () => []) }));

vi.mock('#src/utils/llmUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/llmUtils.js')>();
  return {
    ...actual,
    buildSystemMessages: vi.fn(() => [{ content: 'SYSTEM PROMPT' }]),
    readChatPrompt: vi.fn(() => 'chat-mode-prompt'),
    readCodePrompt: vi.fn(() => 'code-mode-prompt'),
    readExecPrompt: vi.fn(() => 'exec-mode-prompt'),
  };
});

/** A toolset that something gates at some rung — the shell is gated at every rung there is. */
const GATED_TOOLS = [
  { name: SHELL_TOOL_NAME, description: 'Run a shell command.' },
  { name: 'read_file', description: 'Read one file.' },
];

/** A toolset no rung gates: built-in READ tools are granted everywhere. */
const READ_ONLY_TOOLS = [{ name: 'read_file', description: 'Read one file.' }];

/** A frontend-fulfilled tool: `extractAndFlattenTools` rewrites its body to `interrupt()`. */
const clientTool = (): Record<string, unknown> => ({
  name: 'capture_image',
  description: 'Fulfilled by the client.',
  invoke: vi.fn(),
  call: vi.fn(),
  metadata: { client: true },
});

/** The same tool without the marker — ordinary, server-side, never interrupts. */
const serverTool = (): Record<string, unknown> => ({
  name: 'capture_image',
  description: 'Fulfilled here.',
  invoke: vi.fn(),
  call: vi.fn(),
});

let statusUpdate: StatusUpdateCallback;
let GthLangChainAgent: any;

const baseConfig = (): GthConfig =>
  ({
    llm: { _llmType: () => 'test', bindTools: vi.fn() },
    streamOutput: false,
    contentSource: 'file',
    requirementSource: 'file',
    filesystem: 'none',
    useColour: false,
    writeOutputToFile: false,
    writeBinaryOutputsToFile: false,
    streamSessionInferenceLog: false,
    canInterruptInferenceWithEsc: false,
    includeCurrentDateAfterGuidelines: false,
    output: { header: 'none' },
  }) as unknown as GthConfig;

const resolversFor = (tools: unknown[]) => ({ resolveTools: async () => tools });

beforeEach(async () => {
  vi.clearAllMocks();
  createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
  statusUpdate = vi.fn();
  ({ GthLangChainAgent } = await import('#src/core/GthLangChainAgent.js'));
});

describe('EXT-121 — an interrupt with no checkpointer is refused at init', () => {
  it('throws when an approval interrupt is installed and no saver was given', async () => {
    const agent = new GthLangChainAgent(statusUpdate, resolversFor(GATED_TOOLS) as never);

    await expect(agent.init('code', baseConfig())).rejects.toThrow(/no checkpointer was supplied/i);
    // Nothing was built: the refusal happens before the graph is constructed, which is the whole
    // point of moving the failure to init.
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('names the surface and the missing saver rather than quoting LangGraph', async () => {
    const agent = new GthLangChainAgent(statusUpdate, resolversFor(GATED_TOOLS) as never);

    const error = await agent.init('code', baseConfig()).catch((e: unknown) => e as Error);

    // The surface the user was on, so the message is locatable...
    expect(error.message).toContain('code');
    // ...what is missing, in the vocabulary of the API the caller actually used...
    expect(error.message).toContain('GthLangChainAgent.init()');
    // ...and the concrete remedy, naming a type the caller can pass.
    expect(error.message).toContain('BaseCheckpointSaver');
    expect(error.message).toContain('MemorySaver');
  });

  it('does NOT throw when nothing will interrupt and no saver was given', async () => {
    const agent = new GthLangChainAgent(statusUpdate, resolversFor(READ_ONLY_TOOLS) as never);

    // The legitimate saver-less caller. If this ever reds, the guard has been widened into the
    // required-parameter form the design rejects.
    await expect(agent.init('chat', baseConfig())).resolves.toBeUndefined();
    expect(createAgentMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT throw when an interrupt is installed and a saver WAS given', async () => {
    const agent = new GthLangChainAgent(statusUpdate, resolversFor(GATED_TOOLS) as never);

    // Same graph as the first cell; only the saver differs. This is the cell that pins the
    // condition as a conjunction — a guard firing on interrupts alone would red here.
    await expect(agent.init('code', baseConfig(), new MemorySaver())).resolves.toBeUndefined();
    expect(createAgentMock).toHaveBeenCalledTimes(1);
  });
});

describe('EXT-121 — the client-fulfilled tool is the second interrupt installer', () => {
  it('throws for a client tool on `api`, where the approval interrupt set is empty', async () => {
    const agent = new GthLangChainAgent(statusUpdate, resolversFor([]) as never);

    await expect(
      agent.init('api', { ...baseConfig(), tools: [clientTool()] } as GthConfig)
    ).rejects.toThrow(/no checkpointer was supplied/i);
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('does NOT throw for the same graph with an ordinary tool', async () => {
    const agent = new GthLangChainAgent(statusUpdate, resolversFor([]) as never);

    // The control for the cell above: identical command and shape, marker removed. It proves the
    // `client` marker is what fires the guard there, not the command or the presence of a tool.
    await expect(
      agent.init('api', { ...baseConfig(), tools: [serverTool()] } as GthConfig)
    ).resolves.toBeUndefined();
    expect(createAgentMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a client tool once a saver is supplied', async () => {
    const agent = new GthLangChainAgent(statusUpdate, resolversFor([]) as never);

    await expect(
      agent.init('api', { ...baseConfig(), tools: [clientTool()] } as GthConfig, new MemorySaver())
    ).resolves.toBeUndefined();
    expect(createAgentMock).toHaveBeenCalledTimes(1);
  });
});
