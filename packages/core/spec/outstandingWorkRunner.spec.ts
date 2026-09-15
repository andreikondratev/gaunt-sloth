/**
 * [[EXT-158]] — the runner's half of the seam, and the premise the whole node rests on.
 *
 * Two claims live here and they are deliberately separate cells.
 *
 * **The premise.** The node exists because a turn that stops mid-task is indistinguishable from one
 * that finished — and the detector keys on exactly that ending, so it matters that the runtime
 * really does classify it `completed` rather than as something `displayTermination` already
 * announces. That was never verified end to end before this node; these cells verify it and go red
 * if a later change reclassifies it, rather than letting the feature silently stop firing.
 *
 * **The forwarding.** The string path has no site inside the agent to record on — `agent.stream()`
 * returns a stream the RUNNER drains, so the agent never learns when the drain finished — and the
 * runner is therefore what asks. These cells pin that it asks, that it asks with the thread's own
 * `runConfig`, and that the answer reaches a caller through `getOutstandingWork()` including after
 * `cleanup()` has dropped the agent, which is when the non-interactive verbs read it.
 *
 * What is NOT claimed here: that the detector works. The agent is a stub in this file, so its
 * `noteOutstandingWork` records nothing real. `outstandingWork.spec.ts` drives the detector through
 * a real LangGraph checkpointer for exactly that reason.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import type { AgentStreamEvent, StatusUpdateCallback } from '#src/core/types.js';
import type { GthOutstandingWork } from '#src/core/outstandingWork.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';

const WORK: GthOutstandingWork = {
  outstanding: 3,
  completed: 1,
  total: 4,
  inProgress: 1,
  signature: 'completed Read the configin_progress Wire the write path',
  repeat: false,
};

const mockAgent = {
  init: vi.fn(),
  setVerbose: vi.fn(),
  invoke: vi.fn(),
  stream: vi.fn(),
  streamWithEvents: vi.fn(),
  getPendingToolInterrupts: vi.fn(),
  streamResume: vi.fn(),
  streamWithEventsResume: vi.fn(),
  cleanup: vi.fn(),
  resetTerminationReason: vi.fn(),
  getTerminationReason: vi.fn(() => null),
  noteOutstandingWork: vi.fn(async () => {}),
  getOutstandingWork: vi.fn((): GthOutstandingWork | null => null),
};

const resolveRaterModelMock = vi.fn();
vi.mock('#src/core/shell/raterModel.js', () => ({
  resolveRaterModel: resolveRaterModelMock,
}));

vi.mock('#src/core/GthLangChainAgent.js', () => ({
  GthLangChainAgent: class MockGthLangChainAgent {
    constructor() {
      return mockAgent;
    }
  },
  StatusUpdateCallback: vi.fn(),
}));

const projectDir = mkdtempSync(join(tmpdir(), 'gth-ext158-runner-'));

function textStreamOf(chunks: string[]) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function eventStreamOf(events: AgentStreamEvent[]) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

describe('[[EXT-158]] the runner seam', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let statusUpdateCallback: Mock<StatusUpdateCallback>;
  let streamingConfig: GthConfig;
  let priorProjectDir: string | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    statusUpdateCallback = vi.fn();
    mockAgent.getTerminationReason.mockReturnValue(null);
    mockAgent.getPendingToolInterrupts.mockResolvedValue([]);
    mockAgent.noteOutstandingWork.mockResolvedValue(undefined);
    mockAgent.getOutstandingWork.mockReturnValue(null);

    streamingConfig = {
      contentSource: 'file',
      requirementSource: 'file',
      filesystem: 'none',
      useColour: false,
      writeOutputToFile: false,
      writeBinaryOutputsToFile: false,
      streamSessionInferenceLog: false,
      canInterruptInferenceWithEsc: false,
      includeCurrentDateAfterGuidelines: false,
      streamOutput: true,
      llm: { _llmType: vi.fn().mockReturnValue('test'), verbose: false },
    } as unknown as GthConfig;

    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => setProjectDir(priorProjectDir));
  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  async function runnerFor(config: GthConfig) {
    const runner = new GthAgentRunner(statusUpdateCallback);
    await runner.init(undefined, config);
    return runner;
  }

  const ask = [new HumanMessage('do the thing')];

  describe('the premise: a clean stop with work outstanding is a `completed` stop', () => {
    /**
     * **The single fact this node could not be built without.** If a turn that ends with text and
     * no tool calls classified as something `shouldAnnounceTermination` already announces, the
     * silence this node fills would not exist and the gate on `completed` would never open.
     *
     * Asserted on BOTH drivers, because they reach it through different sites — the string path's
     * `runner.completed` and the typed-event path's `runner.events-completed` — and a cell on one
     * would leave the other free to drift.
     */
    it('classifies the streamed clean ending as `completed`, on the string path', async () => {
      mockAgent.stream.mockResolvedValue(
        textStreamOf(['I have the wiring. ', "Next I'll extend the write-path helpers."])
      );
      const runner = await runnerFor(streamingConfig);

      await runner.processMessages(ask);

      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.completed',
        category: 'completed',
      });
    });

    it('classifies the typed-event clean ending as `completed`', async () => {
      mockAgent.streamWithEvents.mockReturnValue(
        eventStreamOf([
          { type: 'tool_start', id: 'call-1', name: 'gth_checklist' },
          { type: 'tool_result', id: 'call-1', content: 'Checklist (1/4 completed):' },
          { type: 'text', delta: 'I have enough context. Implementing write-path support first.' },
        ])
      );
      const runner = await runnerFor(streamingConfig);

      for await (const _ of runner.processMessagesWithEvents(ask)) {
        /* drain */
      }

      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.events-completed',
        category: 'completed',
      });
    });
  });

  describe('the string path asks the agent to record, because nothing inside it can', () => {
    it('records at the end of the turn, against the thread the turn ran on', async () => {
      mockAgent.stream.mockResolvedValue(textStreamOf(['done']));
      const runner = await runnerFor(streamingConfig);

      await runner.processMessages(ask);

      expect(mockAgent.noteOutstandingWork).toHaveBeenCalledTimes(1);
      // The thread's own config, not an empty one: a read against the wrong thread returns another
      // conversation's messages, which would be a wrong answer rather than no answer.
      expect(mockAgent.noteOutstandingWork.mock.calls[0][0]).toMatchObject({
        configurable: { thread_id: expect.any(String) },
      });
    });

    /**
     * The typed-event path must NOT be recorded from here. It records inside the agent, because the
     * AG-UI server drives `streamWithEvents` directly with no runner at all — and a second call
     * from the runner would re-read the state and, worse, could mark a fresh stalled state as a
     * repeat of itself.
     */
    it('does not record from the runner on the typed-event path', async () => {
      mockAgent.streamWithEvents.mockReturnValue(eventStreamOf([{ type: 'text', delta: 'done' }]));
      const runner = await runnerFor(streamingConfig);

      for await (const _ of runner.processMessagesWithEvents(ask)) {
        /* drain */
      }

      expect(mockAgent.noteOutstandingWork).not.toHaveBeenCalled();
    });
  });

  describe('the fact reaches a caller', () => {
    it('forwards the agent’s answer', async () => {
      mockAgent.getOutstandingWork.mockReturnValue(WORK);
      const runner = await runnerFor(streamingConfig);

      expect(runner.getOutstandingWork()).toEqual(WORK);
    });

    it('is `null` when the agent has nothing to report', async () => {
      const runner = await runnerFor(streamingConfig);

      expect(runner.getOutstandingWork()).toBeNull();
    });

    /**
     * `reviewModule` and the single-shot verbs read the ending AFTER `cleanup()`, by which point
     * the agent is gone — so the runner snapshots it there, exactly as it does the termination
     * reason. Without the snapshot those two surfaces read `null` on every run.
     */
    it('survives cleanup, which is when the non-interactive verbs read it', async () => {
      mockAgent.stream.mockResolvedValue(textStreamOf(['done']));
      mockAgent.getOutstandingWork.mockReturnValue(WORK);
      const runner = await runnerFor(streamingConfig);
      await runner.processMessages(ask);

      await runner.cleanup();

      expect(runner.getOutstandingWork()).toEqual(WORK);
    });

    it('never throws when the agent cannot answer', async () => {
      mockAgent.getOutstandingWork.mockImplementation(() => {
        throw new Error('no such method');
      });
      const runner = await runnerFor(streamingConfig);

      expect(() => runner.getOutstandingWork()).not.toThrow();
      expect(runner.getOutstandingWork()).toBeNull();
    });

    it('forgets the previous turn’s fact at the next turn boundary', async () => {
      // A fresh stream per call: a generator is one-shot, and `mockResolvedValue` would hand the
      // second turn the exhausted one from the first.
      mockAgent.stream.mockImplementation(async () => textStreamOf(['done']));
      mockAgent.getOutstandingWork.mockReturnValue(WORK);
      const runner = await runnerFor(streamingConfig);
      await runner.processMessages(ask);
      expect(runner.getOutstandingWork()).toEqual(WORK);

      mockAgent.getOutstandingWork.mockReturnValue(null);
      await runner.processMessages(ask);

      expect(runner.getOutstandingWork()).toBeNull();
    });
  });
});
