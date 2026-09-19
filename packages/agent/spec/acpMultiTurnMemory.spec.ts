/**
 * EXT-122 — **a second ACP turn is given the first one, and the memory dies with the session.**
 *
 * ## What this file pins, and why it did not exist
 *
 * [[EXT-119]] handed each ACP session a per-session `MemorySaver` so a gated tool call could
 * suspend the graph. That fixed the reported crash and, as a side effect nobody's diff review would
 * have predicted, gave an ACP session **cross-turn memory it did not have before**: an ACP turn
 * sends only the new human message (see `runTurn`, which calls the runner with
 * `[new HumanMessage(text)]` and nothing else), so before the saver turn 2 began with an empty
 * conversation and after it LangGraph retrieves the checkpointed state of a stable thread.
 *
 * That is the shape an editor session should have and it matches the interactive surface, but no
 * ACP spec drove a second turn, so the behaviour was pinned in neither direction. This file is that
 * pin. It changes nothing; it measures.
 *
 * ## Why the assertion is on what reached the MODEL
 *
 * The node's acceptance — *"a test that fails if the second cannot see the first"* — is satisfiable
 * by a test that cannot fail. Two nearby facts look like cross-turn memory and are not:
 *
 * - **`session.replayLog` is not the checkpointer.** The app keeps its own transcript so
 *   `session/resume` can replay it, and that log accumulates whether or not a saver exists. A cell
 *   asserting on replayed updates passes with the checkpointer ripped out.
 * - **Anything the agent would have said anyway** — a greeting, a system-prompt echo, the shape of
 *   the answer — is not causally dependent on turn 1's content.
 *
 * So every memory assertion here lands on **the message list handed to `_generate`**, which is the
 * model's actual input, and on a **nonce the model itself emitted in turn 1**. That string exists
 * nowhere in the process except in turn 1's reply; turn 2's prompt does not contain it and no
 * fixture supplies it. If it is in turn 2's model input, turn 1's exchange was retrieved from the
 * checkpoint.
 *
 * ## The mutation that proves these cells can fail is NOT "remove the saver"
 *
 * It used to be, and it no longer is. [[EXT-121]] added a refusal in `GthLangChainAgent.init` that
 * throws when a graph carries interrupt tools and no checkpointer was supplied — and an ACP session
 * always carries them. Passing no saver therefore fails at `session/new`, before turn 1 runs, and
 * reds every cell in this file including the controls: a red that says nothing about what turn 2
 * remembers. **The mutation that isolates the memory is per-turn thread rotation** — a
 * `session.runner.resetThread()` ahead of `processMessagesWithEvents` in both dialects' `runTurn`,
 * which starts turn 2 on an empty checkpointer thread and changes nothing else. It reds the two
 * memory cells and the two accumulation cells and leaves the controls and the lifetime cells green.
 * The lifetime cells have their own: one process-wide saver on one fixed thread.
 *
 * ## Why the model here is TEXT-ONLY, unlike the EXT-119 spec next door
 *
 * Deliberate, and load-bearing for the mutation proof. `acpRealAgentGate.spec.ts` scripts a model
 * that calls a gated shell tool, and everything about a gated call — the interrupt, the suspension,
 * the permission request — is a second thing the checkpointer decides. A text-only model leaves it
 * exactly one thing to decide: the message list. The cells below also assert the failure is not
 * `No checkpointer set`, so a wrong-reason red cannot pass for the right one.
 *
 * ## Both dialects
 *
 * `acpAgentApp.ts` (v2) and `acpAgentAppV1.ts` (v1, the dialect Zed speaks) each construct their own
 * `MemorySaver`. Pinning one would leave the other free to move silently, which is the same hole one
 * dialect smaller.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import * as acpV1 from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type { AgentResolvers } from '@gaunt-sloth/core/core/types.js';
import { peekProjectDir, setProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';

/** Both dialects, so neither can move on its own. */
type Dialect = 'v1' | 'v2';
const DIALECTS: readonly Dialect[] = ['v1', 'v2'];

/**
 * A chat model with no provider, no key and no tools that **records every message list it is
 * handed** and answers with whatever the driver queued for this turn.
 *
 * The recording is the measurement: the model's input is the only place a checkpointer's effect is
 * visible from outside LangGraph, and it is the one thing a canned answer cannot fake.
 */
class RecordingModel extends BaseChatModel {
  /** One entry per `_generate`, each the rendered messages of that call, in order. */
  readonly calls: string[][] = [];
  /** What the next reply says; the driver sets it before each turn. */
  nextReply = 'ok';

  constructor() {
    super({});
  }
  _llmType(): string {
    return 'ext-122-recording';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.calls.push(messages.map(renderMessage));
    const message = new AIMessage(this.nextReply);
    return { generations: [{ message, text: this.nextReply }] };
  }
}

/** One message as `type: text`, so an assertion can search a whole call with `join`. */
function renderMessage(message: BaseMessage): string {
  const content = message.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((block) => (block as { text?: string })?.text ?? '').join('')
        : '';
  return `${message.getType()}: ${text}`;
}

/**
 * The persisted grant store anchors at the project dir, so a spec booting a real runner must clamp
 * it or it reads (and writes) the real allow-list of whoever runs the suite.
 */
const projectDir = mkdtempSync(join(tmpdir(), 'gth-acp-multiturn-spec-'));
const workspace = join(projectDir, 'workspace');

/**
 * Minimal config carrying the recording model. Same shape as the EXT-119 spec's, and for the same
 * reason: nothing here names `approvals`, so the session runs on the posture it gets with no
 * configuration at all.
 */
function recordingConfig(llm: BaseChatModel): GthConfig {
  return {
    streamOutput: true,
    contentSource: 'file',
    requirementSource: 'file',
    filesystem: 'none',
    useColour: false,
    writeOutputToFile: false,
    writeBinaryOutputsToFile: false,
    streamSessionInferenceLog: false,
    canInterruptInferenceWithEsc: false,
    includeCurrentDateAfterGuidelines: true,
    llm,
  } as unknown as GthConfig;
}

/**
 * Resolvers with **no tools at all**.
 *
 * Explicit rather than `createResolvers()`, which would load the production toolset — including a
 * shell tool that runs commands for real — and contact MCP servers from a unit spec. Empty also
 * keeps the approvals gate out of the picture entirely, which is what keeps the mutation below
 * honest (see the header).
 */
function emptyResolvers(): AgentResolvers {
  return {
    resolveTools: async () => [],
    resolveMiddleware: async (middleware: unknown[] | undefined) => middleware ?? [],
  } as unknown as AgentResolvers;
}

/** What one turn of a drive reports back. */
interface TurnRecord {
  /** Every message list the model was handed during this turn, in order. */
  modelInputs: string[][];
  /** Agent text the client rendered for this turn. */
  text: string;
  /** The failure this turn reported, in whichever way its dialect reports one. */
  failure: string | undefined;
}

/** What a whole drive reports back. */
interface Drive {
  turns: TurnRecord[];
  /** Session ids created, in order. */
  sessionIds: string[];
  /** `session/list` as it read at the end of the connection. */
  listedAtEnd: string[];
}

/** One session's worth of instructions for {@link drive}. */
interface SessionPlan {
  /** `[prompt, reply]` per turn: what the client sends, and what the model answers. */
  turns: Array<[prompt: string, reply: string]>;
  /** Close this session before the next one starts. */
  closeAfter?: boolean;
}

let createAcpV1AgentApp: typeof import('#src/modules/acp/acpAgentAppV1.js').createAcpV1AgentApp;
let createAcpAgentApp: typeof import('#src/modules/acp/acpAgentApp.js').createAcpAgentApp;

/**
 * Drive one or more sessions over one dialect on a single connection — one process, one agent app,
 * exactly as an editor holds it.
 *
 * The two dialects report a turn's end differently and cannot share an assertion shape: v1 answers
 * the still-open `session/prompt` with the stop reason, so a failed turn arrives as that request's
 * rejection; v2 acknowledges immediately and reports the outcome on a later idle `state_update`.
 * That difference lives here, so the cells below read the same either way.
 */
async function drive(dialect: Dialect, plans: SessionPlan[]): Promise<Drive> {
  const model = new RecordingModel();
  const options = {
    loadConfig: async () => recordingConfig(model),
    resolvers: emptyResolvers(),
  };
  const turns: TurnRecord[] = [];
  const sessionIds: string[] = [];
  let listedAtEnd: string[] = [];

  if (dialect === 'v1') {
    const texts: string[] = [];
    const client = acpV1
      .client({ name: 'ext-122-v1-client' })
      .onNotification(acpV1.CLIENT_METHODS.session_update, ({ params }) => {
        const update = params.update as unknown as Record<string, unknown>;
        if (
          update.sessionUpdate === 'agent_message_chunk' ||
          update.sessionUpdate === 'agent_message'
        )
          texts.push(renderContent(update.content));
      });

    await client.connectWith(createAcpV1AgentApp(options), async (ctx) => {
      await ctx.request(acpV1.AGENT_METHODS.initialize, {
        protocolVersion: acpV1.PROTOCOL_VERSION,
        clientInfo: { name: 'ext-122-v1-client', version: '0.0.0' },
      });
      for (const plan of plans) {
        const created = await ctx.request(acpV1.AGENT_METHODS.session_new, {
          cwd: workspace,
          mcpServers: [],
        });
        sessionIds.push(created.sessionId);
        for (const [prompt, reply] of plan.turns) {
          const callsBefore = model.calls.length;
          const textsBefore = texts.length;
          model.nextReply = reply;
          const failure = await ctx
            .request(acpV1.AGENT_METHODS.session_prompt, {
              sessionId: created.sessionId,
              prompt: [{ type: 'text', text: prompt }],
            })
            .then(
              () => undefined,
              (error: unknown) => (error as Error).message
            );
          turns.push({
            modelInputs: model.calls.slice(callsBefore),
            text: texts.slice(textsBefore).join(''),
            failure,
          });
        }
        if (plan.closeAfter) {
          await ctx.request(acpV1.AGENT_METHODS.session_close, {
            sessionId: created.sessionId,
          });
        }
      }
      const listed = await ctx.request(acpV1.AGENT_METHODS.session_list, {});
      listedAtEnd = (listed.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId);
    });
    return { turns, sessionIds, listedAtEnd };
  }

  const texts: string[] = [];
  const states: Array<Record<string, unknown>> = [];
  const client = acpV2
    .client({ name: 'ext-122-v2-client' })
    .onNotification(acpV2.CLIENT_METHODS.session_update, ({ params }) => {
      const update = params.update as unknown as Record<string, unknown>;
      if (update.sessionUpdate === 'state_update') states.push(update);
      if (
        update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_message'
      )
        texts.push(renderContent(update.content));
    });

  await client.connectWith(createAcpAgentApp(options), async (ctx) => {
    await ctx.request(acpV2.AGENT_METHODS.initialize, {
      protocolVersion: acpV2.PROTOCOL_VERSION,
      info: { name: 'ext-122-v2-client', version: '0.0.0' },
    });
    for (const plan of plans) {
      const created = await ctx.request(acpV2.AGENT_METHODS.session_new, { cwd: workspace });
      sessionIds.push(created.sessionId);
      for (const [prompt, reply] of plan.turns) {
        const callsBefore = model.calls.length;
        const textsBefore = texts.length;
        const idlesBefore = states.filter((state) => state.state === 'idle').length;
        model.nextReply = reply;
        await ctx.request(acpV2.AGENT_METHODS.session_prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: prompt }],
        });
        const idle = await waitForIdle(states, idlesBefore);
        const text = texts.slice(textsBefore).join('');
        turns.push({
          modelInputs: model.calls.slice(callsBefore),
          text,
          // v2 has no error response for a turn: the failure is the `_error` stop reason, and what
          // went wrong is in the message the client rendered.
          failure: idle.stopReason === '_error' ? text : undefined,
        });
      }
      if (plan.closeAfter) {
        await ctx.request(acpV2.AGENT_METHODS.session_close, { sessionId: created.sessionId });
      }
    }
    const listed = await ctx.request(acpV2.AGENT_METHODS.session_list, {});
    listedAtEnd = (listed.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId);
  });
  return { turns, sessionIds, listedAtEnd };
}

/** The next idle `state_update` past the ones already seen — v2's end of a turn. */
async function waitForIdle(
  states: Array<Record<string, unknown>>,
  idlesBefore: number
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20000;
  for (;;) {
    const idles = states.filter((state) => state.state === 'idle');
    if (idles.length > idlesBefore) return idles[idlesBefore];
    if (Date.now() > deadline) throw new Error('timed out waiting for the idle state update');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The text of one update's content, whatever block shape the dialect used. */
function renderContent(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map((block) => (block as { text?: string })?.text ?? '').join('');
}

/** Everything one turn put in front of the model, as a single searchable string. */
function inputOf(turn: TurnRecord): string {
  return turn.modelInputs.map((call) => call.join('\n')).join('\n');
}

/** A turn that ended badly says so here, naming the reason rather than a bare "it failed". */
function expectTurnSucceeded(turn: TurnRecord, label: string): void {
  // Named rather than left to a bare "the turn failed": a real-agent run has a dozen other ways to
  // throw, and `No checkpointer set` in particular is the EXT-119 crash — if the saver mutation
  // reds a cell THAT way, it has proved nothing about what turn 2 remembers.
  expect(turn.failure ?? '', label).not.toContain('No checkpointer set');
  expect(turn.failure, label).toBeUndefined();
}

let priorProjectDir: string | undefined;
let priorInitCwd: string | undefined;

beforeEach(async () => {
  vi.resetAllMocks();
  priorProjectDir = peekProjectDir();
  priorInitCwd = process.env.INIT_CWD;
  setProjectDir(projectDir);
  ({ createAcpV1AgentApp } = await import('#src/modules/acp/acpAgentAppV1.js'));
  ({ createAcpAgentApp } = await import('#src/modules/acp/acpAgentApp.js'));
});
afterEach(() => {
  setProjectDir(priorProjectDir);
  // The production config loader assigns INIT_CWD, a process-global that outlives the connection.
  if (priorInitCwd === undefined) delete process.env.INIT_CWD;
  else process.env.INIT_CWD = priorInitCwd;
});
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe('EXT-122: a second turn on one ACP session', () => {
  /**
   * The node's acceptance, on both dialects.
   *
   * The assertion is on **`AI-NONCE`**, a string the model emitted as turn 1's answer. Turn 2's
   * prompt does not contain it, no fixture supplies it, and the ACP layer never echoes a prior
   * answer back into a prompt — `runTurn` hands the runner `[new HumanMessage(text)]` and nothing
   * else. The only path from turn 1's reply into turn 2's model input is the checkpoint of the
   * session's thread. The human nonce is asserted beside it as the cheaper half of the same fact.
   */
  it.each(DIALECTS)(
    '%s: turn 2 is given turn 1s exchange, not just its own message',
    async (dialect) => {
      const run = await drive(dialect, [
        {
          turns: [
            ['Remember this word: HUMAN-NONCE-9f3a', 'Noted. AI-NONCE-71d4'],
            ['What word did I ask you to remember?', 'It was that word.'],
          ],
        },
      ]);

      expect(run.turns, dialect).toHaveLength(2);
      expectTurnSucceeded(run.turns[0], `${dialect} turn 1`);
      expectTurnSucceeded(run.turns[1], `${dialect} turn 2`);

      // Turn 1 saw only itself — the baseline the second assertion is a change FROM.
      expect(inputOf(run.turns[0]), `${dialect} turn 1 input`).toContain('HUMAN-NONCE-9f3a');
      expect(inputOf(run.turns[0]), `${dialect} turn 1 input`).not.toContain('AI-NONCE-71d4');

      // The pin. Both halves of turn 1's exchange are in front of the model on turn 2.
      expect(inputOf(run.turns[1]), `${dialect} turn 2 input`).toContain('HUMAN-NONCE-9f3a');
      expect(inputOf(run.turns[1]), `${dialect} turn 2 input`).toContain('AI-NONCE-71d4');
    },
    30000
  );

  /**
   * **CONTROL — this cell passes with or without the checkpointer, and is here to say so.**
   *
   * Turn 2's own message reaching the model is not evidence of memory: it is what a turn does. Its
   * job is to make the difference between the two cells visible rather than asserted — the cell
   * above reds when the per-session saver is removed and this one stays green, which is what
   * distinguishes a measurement from a test that cannot fail.
   */
  it.each(DIALECTS)(
    '%s: CONTROL — turn 2 is given its own message (green either way, by design)',
    async (dialect) => {
      const run = await drive(dialect, [
        {
          turns: [
            ['Remember this word: HUMAN-NONCE-9f3a', 'Noted. AI-NONCE-71d4'],
            ['Second turn says CONTROL-NONCE-4c8e', 'Understood.'],
          ],
        },
      ]);

      expectTurnSucceeded(run.turns[1], `${dialect} turn 2`);
      expect(inputOf(run.turns[1]), `${dialect} turn 2 input`).toContain('CONTROL-NONCE-4c8e');
    },
    30000
  );

  /**
   * The accumulation itself, past the two turns the acceptance asks for: every earlier exchange is
   * still in front of the model on turn 4, and the input grows with each turn.
   *
   * **This pins accumulation, NOT unboundedness.** Nothing here asserts that no bound may ever
   * exist: the product ruling recorded on [[GS2-20]] is full history with no shedding except by the
   * user's explicit act, so a future user-invoked `/compact` ([[GS2-23]] item (e)) leaves these
   * assertions intact. What the growth costs an editor session is measured in the node and belongs
   * to [[EXT-134]]'s planning, not here.
   */
  it.each(DIALECTS)(
    '%s: a fourth turn still carries the first three',
    async (dialect) => {
      const run = await drive(dialect, [
        {
          turns: [
            ['turn one says ACC-NONCE-A', 'reply one says ACC-REPLY-A'],
            ['turn two says ACC-NONCE-B', 'reply two says ACC-REPLY-B'],
            ['turn three says ACC-NONCE-C', 'reply three says ACC-REPLY-C'],
            ['turn four says ACC-NONCE-D', 'reply four says ACC-REPLY-D'],
          ],
        },
      ]);

      for (const [index, turn] of run.turns.entries())
        expectTurnSucceeded(turn, `${dialect} turn ${index + 1}`);

      const fourth = inputOf(run.turns[3]);
      for (const nonce of [
        'ACC-NONCE-A',
        'ACC-REPLY-A',
        'ACC-NONCE-B',
        'ACC-REPLY-B',
        'ACC-NONCE-C',
      ])
        expect(fourth, `${dialect} turn 4 input`).toContain(nonce);

      // Strictly growing, turn over turn: the message count the model is handed is the size of the
      // conversation it is being asked to answer from.
      const sizes = run.turns.map((turn) => turn.modelInputs[0].length);
      for (let i = 1; i < sizes.length; i++)
        expect(sizes[i], `${dialect} turn ${i + 1} message count`).toBeGreaterThan(sizes[i - 1]);
    },
    60000
  );

  /**
   * **The saver's lifetime ends with the session** — the second half of the node's acceptance.
   *
   * Asserted BEHAVIOURALLY, over the wire: a session opened after another was closed, in the same
   * process and on the same connection, is given none of the closed session's conversation. That is
   * what "the memory died with the session" means to a client, and it reds if someone swapped the
   * per-session saver for a process-wide one — which is exactly the change that would otherwise
   * leak one editor session's conversation into the next.
   *
   * Complementary to, not a duplicate of, the EXT-119 cell in `acpRealAgentGate.spec.ts` that
   * asserts each session is handed its own `MemorySaver` INSTANCE. That one reads the argument; this
   * one reads the consequence, across a close, on the model's actual input.
   *
   * The close itself is asserted too: a closed session is gone from `session/list`, so nothing in
   * the app still holds the runner the saver lives on.
   */
  it.each(DIALECTS)(
    '%s: a session closed is a memory gone',
    async (dialect) => {
      const run = await drive(dialect, [
        {
          turns: [['First session says FIRST-SESSION-NONCE-b52c', 'Noted. FIRST-REPLY-NONCE-e07f']],
          closeAfter: true,
        },
        { turns: [['Second session says SECOND-SESSION-NONCE-3a1d', 'Understood.']] },
      ]);

      expect(run.sessionIds, dialect).toHaveLength(2);
      expectTurnSucceeded(run.turns[0], `${dialect} session 1 turn 1`);
      expectTurnSucceeded(run.turns[1], `${dialect} session 2 turn 1`);

      const second = inputOf(run.turns[1]);
      expect(second, `${dialect} session 2 input`).toContain('SECOND-SESSION-NONCE-3a1d');
      expect(second, `${dialect} session 2 input`).not.toContain('FIRST-SESSION-NONCE-b52c');
      expect(second, `${dialect} session 2 input`).not.toContain('FIRST-REPLY-NONCE-e07f');

      // The closed session is gone from the app; only the second one is still live.
      expect(run.listedAtEnd, dialect).toEqual([run.sessionIds[1]]);
    },
    30000
  );
});
