/**
 * CFG-72 — a sibling middleware appending in `beforeModel` must not shadow the binary attachment.
 *
 * CFG-69 narrowed `collectTrailingBinaryContent` to the TRAILING RUN of tool messages, on the
 * reading that a model call following tool execution ends with the tool results it continues from.
 * The narrowing is load-bearing and must stay — without it a `gth_read_binary` result is re-matched
 * on a later, unrelated turn and the rebuilt attachment kills the session.
 *
 * But "directly follows" is a claim about the GRAPH, and the graph interposes every `beforeModel`
 * hook between the tools node and the model call. Measured here rather than asserted: the tools node
 * routes back to the FIRST beforeModel node (`langchain@1.5.11`
 * `dist/agents/ReactAgent.js:267` — `toolReturnTarget = loopEntryNode`), each `beforeModel` hook is
 * its own graph node chained to the agent node (`:205-214`), and the agent node builds the model
 * request from `state.messages` (`dist/agents/nodes/AgentNode.js:334`) — the state those nodes have
 * already committed. So a sibling that appends in `beforeModel` is always AHEAD of the binary
 * middleware's `wrapModelCall`, by composition and not by a race.
 *
 * `frontendImageInjectionMiddleware` is exactly such a sibling, and its idempotency guard is keyed
 * on the graph thread rather than on the message window, so a replayed history re-injects a capture
 * from several messages back at the TAIL. On a camera + `binaryFormats` config that is an ordinary
 * path, not a corner.
 *
 * The cells below drive the REAL `GthLangChainAgent` graph through the real registry — the same
 * instrument as `frontendImageInjectionWiring.spec.ts` — against a key-free chat model that captures
 * what it was asked to generate on. They measure what reaches the model, which is the only thing the
 * defect is about.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AIMessage,
  HumanMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { GthLangChainAgent } from '@gaunt-sloth/core/core/GthLangChainAgent.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { createResolvers } from '#src/resolvers.js';
import {
  isMiddlewareInjected,
  markMiddlewareInjected,
} from '#src/middleware/middlewareInjectedMarker.js';

/** A tiny opaque base64 payload — the middleware never looks inside it. */
const B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF_MIME = 'application/pdf';
const PDF_PATH = '/tmp/test.pdf';
const FRAME = { mimeType: 'image/jpeg', data: 'QUFBQg==' };
const FRAME_DATA_URL = `data:${FRAME.mimeType};base64,${FRAME.data}`;

/** The `gth_read_binary` ToolMessage content string, exactly as `parseBinaryContent` expects it. */
function binaryToolContent(type: string, mime: string, data: string, filePath: string): string {
  return `gth_read_binary;type:${type};path:${encodeURIComponent(filePath)};data:${mime};base64,${data}`;
}

/** A model that records every batch of messages it is asked to generate on, then ends the run. */
class CapturingChatModel extends BaseChatModel {
  seenMessages: BaseMessage[][] = [];
  constructor() {
    super({});
  }
  _llmType(): string {
    return 'capturing';
  }
  bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.seenMessages.push(messages);
    const message = new AIMessage('done');
    return { generations: [{ message, text: 'done' }] };
  }
}

/** Config as the AG-UI (`api`) reqAgent receives it, with the named middleware referenced. */
function apiConfig(model: BaseChatModel, middleware: unknown[]): GthConfig {
  return {
    llm: model,
    middleware,
    modelProviderType: 'openai',
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
    injectModelContext: false,
    noDefaultPrompts: true,
    allowedTools: [],
  } as unknown as GthConfig;
}

/** The assistant request + `gth_read_binary` result for a PDF read on this turn. */
function pdfRound(id = 'call-pdf-1'): BaseMessage[] {
  return [
    new AIMessage({ content: '', tool_calls: [{ name: 'gth_read_binary', args: {}, id }] }),
    new ToolMessage({
      content: binaryToolContent('file', PDF_MIME, B64, PDF_PATH),
      tool_call_id: id,
      name: 'gth_read_binary',
    }),
  ];
}

/** The assistant request + `capture_image` result for a camera frame. */
function captureRound(id = 'call-cap-1'): BaseMessage[] {
  return [
    new AIMessage({ content: '', tool_calls: [{ name: 'capture_image', args: {}, id }] }),
    new ToolMessage({ content: JSON.stringify(FRAME), tool_call_id: id, name: 'capture_image' }),
  ];
}

/** Every PDF block the model was actually handed, across all calls. */
function pdfBlocksSeen(seen: BaseMessage[][]): unknown[] {
  return seen
    .flat()
    .flatMap((message) => (Array.isArray(message.content) ? (message.content as unknown[]) : []))
    .filter(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { mime_type?: string }).mime_type === PDF_MIME
    );
}

/** Every camera frame the model was handed — the sibling's own injection, proving it fired. */
function frameBlocksSeen(seen: BaseMessage[][]): unknown[] {
  return seen
    .flat()
    .flatMap((message) => (Array.isArray(message.content) ? (message.content as unknown[]) : []))
    .filter(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { image_url?: { url?: string } }).image_url?.url === FRAME_DATA_URL
    );
}

async function runAgent(middleware: unknown[], history: BaseMessage[], threadId: string) {
  const model = new CapturingChatModel();
  const agent = new GthLangChainAgent(vi.fn(), createResolvers());
  await agent.init('api', apiConfig(model, middleware));
  const runConfig: RunnableConfig = { configurable: { thread_id: threadId } };
  await agent.invoke(history, runConfig);
  return model;
}

const BOTH = ['binary-content-injection', 'frontend-image-injection'];
const BOTH_REVERSED = ['frontend-image-injection', 'binary-content-injection'];

describe('CFG-72 — a beforeModel sibling must not shadow the binary attachment', () => {
  it('THE MEASUREMENT — a PDF read on this turn reaches the model even though the camera middleware appended first', async () => {
    const model = await runAgent(
      BOTH,
      [new HumanMessage('Take a photo and read test.pdf'), ...captureRound(), ...pdfRound()],
      'cfg72-same-step'
    );

    // The sibling fired (this is the shadow, present and doing its job)...
    expect(frameBlocksSeen(model.seenMessages)).toHaveLength(1);
    // ...and the attachment still reached the model. Measured at 0 before this fix.
    expect(pdfBlocksSeen(model.seenMessages)).toHaveLength(1);
  });

  it('the fix does not depend on which order the two middlewares are configured in', async () => {
    const model = await runAgent(
      BOTH_REVERSED,
      [new HumanMessage('Take a photo and read test.pdf'), ...captureRound(), ...pdfRound()],
      'cfg72-reversed'
    );

    expect(frameBlocksSeen(model.seenMessages)).toHaveLength(1);
    expect(pdfBlocksSeen(model.seenMessages)).toHaveLength(1);
  });

  it('THE REPLAYED HISTORY — a capture several messages back still gets re-injected at the tail, and still does not shadow', async () => {
    // RC-31: a fresh AG-UI run replays the whole history into an empty graph, and the sibling's
    // idempotency guard is keyed on the graph THREAD, so a capture from several messages back is
    // re-injected — at the tail, on top of this turn's tool result. No same-step coincidence needed.
    const model = await runAgent(
      BOTH,
      [
        new HumanMessage('Take a photo'),
        ...captureRound(),
        new AIMessage('I see a workbench.'),
        new HumanMessage('Now read test.pdf'),
        ...pdfRound(),
      ],
      'cfg72-replayed'
    );

    // The capture is four messages back and is still re-injected at the tail on this fresh run...
    expect(frameBlocksSeen(model.seenMessages)).toHaveLength(1);
    // ...and the PDF read on THIS turn still reaches the model.
    expect(pdfBlocksSeen(model.seenMessages)).toHaveLength(1);
  });

  it('CONTROL — with no sibling configured the attachment reaches the model exactly as CFG-69 left it', async () => {
    const model = await runAgent(
      ['binary-content-injection'],
      [new HumanMessage('Read test.pdf'), ...pdfRound()],
      'cfg72-no-sibling'
    );

    expect(frameBlocksSeen(model.seenMessages)).toEqual([]);
    expect(pdfBlocksSeen(model.seenMessages)).toHaveLength(1);
  });

  it('CONTROL — a real user message after the tool result still ends the run, and no attachment is rebuilt (CFG-69 unchanged)', async () => {
    // The shape that must stay closed: the SAME message shape as the shadow case — a tool round
    // with a HumanMessage sitting on the end of it — but the HumanMessage is the user's, so the
    // model call is not the continuation of that read and the attachment must not be rebuilt.
    const model = await runAgent(
      BOTH,
      [
        new HumanMessage('Read test.pdf'),
        ...pdfRound(),
        new AIMessage('a one page invoice'),
        new HumanMessage('Did it work?'),
      ],
      'cfg72-user-message-boundary'
    );

    expect(pdfBlocksSeen(model.seenMessages)).toEqual([]);
  });
});

describe('CFG-72 — the marker itself', () => {
  it('a marked message is recognised, an unmarked one is not, and marking preserves the content', () => {
    const plain = new HumanMessage('hello');
    expect(isMiddlewareInjected(plain)).toBe(false);

    const marked = markMiddlewareInjected(new HumanMessage('hello'));
    expect(isMiddlewareInjected(marked)).toBe(true);
    expect(marked.content).toBe('hello');
  });

  it('the marker survives the two serialisers a persisted conversation actually goes through', async () => {
    // A hand-rolled `JSON.parse(JSON.stringify(...))` here would test JSON, not LangChain. The
    // replayed-history half of this node depends on the mark still being there after a checkpoint
    // round trip, so both real paths are exercised: the stored-message mapping persistence uses,
    // and the serde every `BaseCheckpointSaver` writes through — the SQLite saver gth runs for a
    // session included. A mark that silently dropped at either boundary would leave the shadow
    // standing in production while the in-process cells above stayed green.
    const marked = markMiddlewareInjected(new HumanMessage('hello'));

    const stored = mapStoredMessagesToChatMessages(
      JSON.parse(JSON.stringify(mapChatMessagesToStoredMessages([marked])))
    );
    expect(isMiddlewareInjected(stored[0])).toBe(true);

    const serde = new MemorySaver().serde;
    const [type, bytes] = await serde.dumpsTyped({ messages: [marked] });
    const revived = (await serde.loadsTyped(type, bytes)) as { messages: BaseMessage[] };
    expect(revived.messages[0].getType()).toBe('human');
    expect(isMiddlewareInjected(revived.messages[0])).toBe(true);
  });

  it('is duck-typed: a foreign message object from another @langchain/core copy is still read (RC-21)', () => {
    // No `instanceof`, no class identity — a second core copy in a consumer's tree must not make a
    // marked message look unmarked, which would put the shadow straight back.
    const foreign = { additional_kwargs: { gth_middleware_injected: true } } as never;
    expect(isMiddlewareInjected(foreign)).toBe(true);
  });

  it('CONTROL — an unrelated additional_kwargs entry does not read as marked', () => {
    const message = new HumanMessage({ content: 'hello', additional_kwargs: { audio: {} } });
    expect(isMiddlewareInjected(message)).toBe(false);
  });
});
