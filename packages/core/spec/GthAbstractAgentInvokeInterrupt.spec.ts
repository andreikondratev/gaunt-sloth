/**
 * [[EXT-184]] — Esc on the NON-STREAMING turn path.
 *
 * `GthAgentRunner` branches on `config.streamOutput`. The streaming arm reaches
 * `GthAbstractAgent.streamFromInput`, which arms the interrupt and threads an abort signal; the
 * other arm reaches `GthAbstractAgent.invoke`, which armed nothing — so a runaway model call under
 * `streamOutput: false` showed a spinner and nothing else for as long as the provider took, with no
 * key that could stop it. These cells pin the affordance on that arm.
 *
 * ## Why these cells are shaped the way they are
 *
 * [[TUI-C97]] found an abort in the approval hold that "worked" only because LangGraph refused an
 * already-aborted signal downstream — incidental, and invisible to every test, because the test
 * aborted BEFORE the call was made. So every cell here:
 *
 * - runs a **real compiled LangGraph** whose node **ignores the signal entirely** and simply hangs,
 *   rather than a double that cooperates. A double that rejects when told to would pass with the
 *   signal never threaded at all.
 * - fires Esc **after the graph is demonstrably mid-node**, asserting the node saw the signal and
 *   that it fired there — an abort that arrived DURING the call, not before it.
 * - asserts on the answer and the classification, not on a timeout. With the arming removed the
 *   hanging node settles on its own and the turn returns the model's text, so the cells go red on a
 *   wrong VALUE rather than by hanging.
 *
 * The last `describe` is the control the node asks for: the same fixture and the same keypress
 * driven through the other arm of the runner's branch, which must stay green under any mutation of
 * the `invoke` arm.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import type { GthConfig } from '#src/config.js';
import { StatusLevel } from '#src/core/types.js';

/**
 * The arming is captured rather than performed: the real `waitForEscape` puts a TTY into raw mode,
 * which a test runner has no business doing (and could not do on a piped stdin anyway).
 */
const escape = vi.hoisted(() => {
  const armings: Array<{ callback: () => void; enabled: unknown; showHint: unknown }> = [];
  return {
    armings,
    waitForEscape: vi.fn((callback: () => void, enabled: unknown, showHint?: unknown) => {
      armings.push({ callback, enabled, showHint });
    }),
    stopWaitingForEscape: vi.fn(),
  };
});

vi.mock('#src/utils/systemUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/systemUtils.js')>();
  return {
    ...actual,
    waitForEscape: escape.waitForEscape,
    stopWaitingForEscape: escape.stopWaitingForEscape,
  };
});

/**
 * The spinner, recorded rather than drawn: WHEN it stops is the observable part, because it writes
 * over whatever is on the line until it does.
 */
const spinner = vi.hoisted(() => ({ stops: [] as number[] }));

vi.mock('#src/utils/ProgressIndicator.js', () => ({
  ProgressIndicator: class {
    constructor(_message: string, _manual?: boolean) {}
    indicate(): void {}
    stop(): void {
      spinner.stops.push(Date.now());
    }
  },
}));

/** Long enough that a turn which cancels properly finishes an order of magnitude sooner. */
const HANG_MS = 4000;
/** Long enough for the first node to have completed and the second to be mid-hang. */
const MID_FLIGHT_MS = 150;

const runConfig: RunnableConfig = { configurable: { thread_id: 'ext-184' } };

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A two-node graph shaped like a real turn that goes wrong: the model says something, and then the
 * run does not come back. The hanging node NEVER looks at `config.signal` — it only records that it
 * was handed one and that it fired — so nothing here can cancel itself into a false pass.
 */
function hangingGraph() {
  const observed = { enteredHang: false, sawSignal: false, signalFired: false, settled: false };
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('speak', () => ({ messages: [new AIMessage('partial')] }))
    .addNode('hang', async (_state, config) => {
      observed.enteredHang = true;
      observed.sawSignal = !!(config as { signal?: AbortSignal } | undefined)?.signal;
      (config as { signal?: AbortSignal } | undefined)?.signal?.addEventListener('abort', () => {
        observed.signalFired = true;
      });
      await new Promise((resolve) => {
        // Unref'd: a cell that cancels correctly leaves this timer pending, and nothing should wait
        // on it once the assertion has run.
        setTimeout(resolve, HANG_MS).unref?.();
      });
      observed.settled = true;
      return { messages: [new AIMessage('the model came back on its own')] };
    })
    .addEdge(START, 'speak')
    .addEdge('speak', 'hang')
    .addEdge('hang', END)
    .compile({ checkpointer: new MemorySaver() });
  return { graph, observed };
}

/** The config fields `invoke` and the runner actually read. */
const BASE_CONFIG = {
  streamOutput: false,
  canInterruptInferenceWithEsc: true,
  contentSource: 'file',
  requirementSource: 'file',
  filesystem: 'none',
  useColour: false,
  writeOutputToFile: false,
  writeBinaryOutputsToFile: false,
  streamSessionInferenceLog: false,
  includeCurrentDateAfterGuidelines: true,
};

describe('[[EXT-184]] the non-streaming turn path arms Esc', () => {
  let GthAbstractAgent: typeof import('#src/core/GthAbstractAgent.js').GthAbstractAgent;
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;

  beforeEach(async () => {
    escape.armings.length = 0;
    escape.waitForEscape.mockClear();
    escape.stopWaitingForEscape.mockClear();
    spinner.stops.length = 0;
    ({ GthAbstractAgent } = await import('#src/core/GthAbstractAgent.js'));
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  /** A real agent over an injected graph, with the config fields `invoke` reads. */
  function agentOver(graph: unknown, overrides: Record<string, unknown> = {}) {
    const statusUpdate = vi.fn();
    class TestAgent extends GthAbstractAgent {
      async init(): Promise<void> {
        /* the graph is injected directly */
      }
    }
    const agent = new TestAgent(statusUpdate);
    (agent as unknown as { config: unknown }).config = { ...BASE_CONFIG, ...overrides };
    (agent as unknown as { agent: unknown }).agent = graph;
    return { agent, statusUpdate };
  }

  describe('arming', () => {
    it('arms the interrupt before the call, passing the config gate straight through', async () => {
      const { graph } = hangingGraph();
      const { agent } = agentOver(graph);

      const turn = agent.invoke([new HumanMessage('q')], runConfig);
      // Armed synchronously, before the first await: a runaway that begins immediately must not be
      // able to start before the key that stops it does.
      expect(escape.waitForEscape).toHaveBeenCalledTimes(1);
      expect(escape.armings[0].enabled).toBe(true);

      escape.armings[0].callback();
      await turn;
    });

    /**
     * The out-of-scope half of the node, pinned rather than assumed: a non-TTY caller (CI, a piped
     * diff, the batch pipeline) has `canInterruptInferenceWithEsc` false — the loader ANDs it with
     * `isTTY()` — and this path decides nothing of its own about that. Bounding an unattended run
     * is a different question, and this cell is what stops it being answered here by accident.
     */
    it('passes a disabled gate through unchanged rather than deciding for itself', async () => {
      const { graph } = hangingGraph();
      const { agent } = agentOver(graph, { canInterruptInferenceWithEsc: false });

      void agent.invoke([new HumanMessage('q')], runConfig).catch(() => undefined);

      expect(escape.armings[0].enabled).toBe(false);
    });
  });

  describe('cancelling', () => {
    it('cancels a hanging turn, says so, and classifies it', async () => {
      const { graph, observed } = hangingGraph();
      const { agent, statusUpdate } = agentOver(graph);

      const turn = agent.invoke([new HumanMessage('q')], runConfig);
      await settle(MID_FLIGHT_MS);

      // The abort lands DURING the model call, which is the whole difference between this and the
      // already-aborted shape TUI-C97 found: the node has been entered and was handed a live
      // signal.
      expect(observed.enteredHang).toBe(true);
      expect(observed.sawSignal).toBe(true);
      expect(observed.signalFired).toBe(false);

      escape.armings[0].callback();
      const answer = await turn;

      // The signal reached the node itself, so a real provider call is CANCELLED rather than
      // merely abandoned — and the node never got to finish.
      expect(observed.signalFired).toBe(true);
      expect(observed.settled).toBe(false);

      // DL-1, no action is silent: the cancellation says so, on the surface and in the answer.
      expect(answer).toBe('Interrupted by user.');
      expect(statusUpdate).toHaveBeenCalledWith(
        StatusLevel.WARNING,
        expect.stringContaining('Interrupted by user, exiting')
      );
      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.invoke-cancelled',
        category: 'cancelled',
        source: 'control',
        detail: 'escape',
      });
    });

    /**
     * A non-empty answer is not cosmetic. The runner treats an empty non-streaming turn as terminal
     * at once — "Model returned an empty response. Try again or switch to a more stable model." —
     * so an empty return would answer the user's own Esc with an accusation against the model.
     */
    it('returns a non-empty answer, so the empty-turn error cannot fire on a cancellation', async () => {
      const { graph } = hangingGraph();
      const { agent } = agentOver(graph);

      const turn = agent.invoke([new HumanMessage('q')], runConfig);
      await settle(MID_FLIGHT_MS);
      escape.armings[0].callback();

      expect((await turn).trim().length).toBeGreaterThan(0);
    });

    /**
     * DL-1 again, one layer down: the callback fires while the call is still pending, so a spinner
     * left running would keep writing dots OVER the notice until the provider unwound — which on
     * the runaway this node is about is minutes of typing across the sentence that says it stopped.
     * The spinner is stopped in the callback, not only in the `finally`.
     */
    it('stops the spinner before it says anything, not when the call finally unwinds', async () => {
      const { graph } = hangingGraph();
      const { agent, statusUpdate } = agentOver(graph);

      const turn = agent.invoke([new HumanMessage('q')], runConfig);
      await settle(MID_FLIGHT_MS);
      expect(spinner.stops).toHaveLength(0);
      escape.armings[0].callback();

      // Read at the moment of the notice and BEFORE awaiting the turn: the `finally`'s own stop has
      // not run yet, so a stop recorded here can only be the callback's.
      expect(spinner.stops).toHaveLength(1);
      expect(statusUpdate).toHaveBeenCalledWith(
        StatusLevel.WARNING,
        expect.stringContaining('Interrupted by user, exiting')
      );

      await turn;
    });

    /**
     * A leaked keypress listener holds stdin in raw mode and ref'd, which wedges the readline
     * approval prompt the runner may run next and stops a one-shot command exiting at all. The
     * arming is paired on every exit, so this asserts the ordinary path too.
     */
    it('tears the listener down on a cancelled turn and on an ordinary one alike', async () => {
      const { graph } = hangingGraph();
      const { agent } = agentOver(graph);

      const turn = agent.invoke([new HumanMessage('q')], runConfig);
      await settle(MID_FLIGHT_MS);
      escape.armings[0].callback();
      await turn;
      expect(escape.stopWaitingForEscape).toHaveBeenCalled();

      escape.stopWaitingForEscape.mockClear();
      const quick = new StateGraph(MessagesAnnotation)
        .addNode('answer', () => ({ messages: [new AIMessage('done')] }))
        .addEdge(START, 'answer')
        .addEdge('answer', END)
        .compile({ checkpointer: new MemorySaver() });
      const { agent: fast } = agentOver(quick);

      await fast.invoke([new HumanMessage('q')], { configurable: { thread_id: 'ext-184-fast' } });

      expect(escape.stopWaitingForEscape).toHaveBeenCalled();
    });
  });

  /**
   * **The control the node asks for: one fixture, one keypress, the two arms of the runner's
   * `streamOutput` branch.** Both cells go through a real `GthAgentRunner` and a real agent, so it
   * is the branch itself being exercised rather than a description of it. Any mutation of the
   * `invoke` arming reds the first cell and must leave the second untouched — which is what makes
   * the pair evidence that these tests can tell the arms apart at all.
   */
  describe('the two arms of the runner branch', () => {
    async function runnerOver(graph: unknown, overrides: Record<string, unknown>) {
      const statusUpdate = vi.fn();
      class TestAgent extends GthAbstractAgent {
        async init(_command: unknown, config: GthConfig): Promise<void> {
          (this as unknown as { config: unknown }).config = config;
          (this as unknown as { agent: unknown }).agent = graph;
        }
      }
      const agent = new TestAgent(statusUpdate);
      const runner = new GthAgentRunner(statusUpdate, undefined, () => agent);
      await runner.init('chat', { ...BASE_CONFIG, ...overrides } as unknown as GthConfig);
      return { runner, statusUpdate };
    }

    it('cancels through `invoke` when `streamOutput` is false', async () => {
      const { graph, observed } = hangingGraph();
      const { runner } = await runnerOver(graph, { streamOutput: false });

      const turn = runner.processMessages([new HumanMessage('q')]);
      await settle(MID_FLIGHT_MS);
      expect(observed.enteredHang).toBe(true);
      escape.armings[0].callback();

      await expect(turn).resolves.toBe('Interrupted by user.');
      expect(runner.getTerminationReason()).toMatchObject({
        site: 'agent.invoke-cancelled',
        category: 'cancelled',
      });
    });

    it('cancels through the streaming twin when `streamOutput` is true, keeping its partial text', async () => {
      const { graph, observed } = hangingGraph();
      const { runner } = await runnerOver(graph, { streamOutput: true });

      const turn = runner.processMessages([new HumanMessage('q')]);
      await settle(MID_FLIGHT_MS);
      expect(observed.enteredHang).toBe(true);
      escape.armings[0].callback();

      // The streaming arm has incremental output, so its cancellation keeps what the model had
      // already said; the other arm has none by construction and returns the notice instead. Two
      // arms, two sites, one key.
      await expect(turn).resolves.toBe('partial');
      expect(runner.getTerminationReason()).toMatchObject({
        site: 'agent.stream-cancelled',
        category: 'cancelled',
      });
    });
  });
});
