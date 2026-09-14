import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '@gaunt-sloth/core/config.js';

/**
 * BATCH-32 — the production adapters' pass-through of the advertised-tool inventory.
 *
 * This is the seam nothing else can see. Every eval spec injects a FAKE `RunCellFn`, so the whole
 * suite stays green if `buildProductionRunCell`'s explicit destructure drops `advertisedTools` on
 * the floor — the run would simply report no coverage, which is also what a legitimately
 * inventory-less target does. These two cells are the only thing that distinguishes them.
 */

const resolversMock = {
  createResolvers: vi.fn(),
};
vi.mock('@gaunt-sloth/agent/resolvers.js', () => resolversMock);

const resolvedFactory = vi.fn();
vi.mock('@gaunt-sloth/agent/core/resolveAgentFactory.js', () => ({
  resolveAgentFactory: vi.fn(() => resolvedFactory),
}));

const runSingleShot = vi.fn();
vi.mock('@gaunt-sloth/core/runtime/singleShot.js', () => ({ runSingleShot }));

const runConversation = vi.fn();
vi.mock('@gaunt-sloth/core/runtime/conversation.js', () => ({ runConversation }));

vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displaySuccess: vi.fn(),
  displayWarning: vi.fn(),
}));

const INVENTORY = {
  tools: [{ name: 'read_file' }, { name: 'write_file', server: 'fs' }],
  filteredOut: [{ name: 'write_file' }],
  unnamed: 1,
};

const options = {
  command: 'ask' as const,
  displayCommand: 'eval',
  sourcePrefix: 'EVAL',
  wrapBlockPrefix: 'message',
  wrapPrefix: 'user message',
};

describe('production run adapters carry the advertised-tool inventory', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resolversMock.createResolvers.mockImplementation(() => ({
      resolveTools: vi.fn(),
      cleanupTools: vi.fn(),
    }));
  });

  it('buildProductionRunCell threads advertisedTools onto the cell outcome', async () => {
    runSingleShot.mockResolvedValue({
      ok: true,
      answer: 'ANSWER',
      tokensInput: 1,
      tokensOutput: 2,
      tools: ['read_file'],
      advertisedTools: INVENTORY,
    });

    const { buildProductionRunCell } = await import('#src/commands/batchCommand.js');
    const runCell = await buildProductionRunCell(
      { llm: {} } as unknown as GthConfig,
      'PREAMBLE',
      {},
      options
    );

    const outcome = await runCell({ id: 'c1', modelIndex: 0, inputIndex: 0, content: 'hi' });

    expect(outcome.advertisedTools).toEqual(INVENTORY);
  });

  it('buildProductionRunConversation threads it onto every turn', async () => {
    runConversation.mockResolvedValue([
      { ok: true, answer: 'A', tools: ['read_file'], advertisedTools: INVENTORY },
      { ok: true, answer: 'B', tools: [], advertisedTools: INVENTORY },
    ]);

    const { buildProductionRunConversation } = await import('#src/commands/batchCommand.js');
    const runConv = await buildProductionRunConversation(
      { llm: {} } as unknown as GthConfig,
      'PREAMBLE',
      options
    );

    const turns = await runConv(['one', 'two']);

    expect(turns.map((turn) => turn.advertisedTools)).toEqual([INVENTORY, INVENTORY]);
  });
});
