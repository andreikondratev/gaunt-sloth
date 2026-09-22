import { describe, expect, it } from 'vitest';
import { EventEncoder } from '@ag-ui/encoder';
import { EventType } from '@ag-ui/core';

/**
 * [[OPS-149]] — the AG-UI protocol surface, pinned against the **real** encoder.
 *
 * **Nothing from `@ag-ui/*` is mocked in this file, and that is its entire reason for existing.**
 * `apiAgUiModule.spec.ts` — the suite that covers the run path — stubs `EventEncoder` with a
 * `vi.fn()` and hand-writes its own `EventType` map. That stub is the right tool there: it lets
 * those cells assert on the *sequence* of events the run path emits without dragging a real
 * serializer into every case. But it means the entire suite **defines the protocol it is testing**,
 * so the two changes that would actually break a client both leave it green:
 *
 * - an upstream **rename of an event's wire value** (the stub map keeps answering `'RUN_STARTED'`
 *   however the shipped enum spells it), and
 * - a change to **how an event is serialized onto the wire** (the stub's `encode` is a spy; it
 *   never produces a frame at all).
 *
 * Those are exactly the failures a consumer sees first and we would see last. The cells below are
 * the counterweight: they construct the genuine `EventEncoder` the way `apiAgUiModule.ts`
 * constructs it, encode events built from the genuine `EventType`, and assert on the **complete
 * frame as a string** — prefix, JSON body, key order and the blank-line terminator included.
 *
 * **Exact equality throughout, never `toContain`.** A substring check survives precisely the
 * serialization change this file exists to catch, which would make it a cell that cannot fail.
 *
 * No event here carries a `null` or `undefined` field, because none of the run path's own encode
 * sites can: every optional field in `apiAgUiModule.ts` is attached by a conditional spread
 * (`...(failed ? { code } : {})`), so an absent value is an absent *key*. Pinning a null-bearing
 * frame would pin a shape this server does not emit.
 */

/** The `accept` header an AG-UI client sends; `apiAgUiModule.ts` passes `req.headers.accept`. */
const SSE_ACCEPT = 'text/event-stream';

describe('AG-UI protocol surface (real @ag-ui/* — not mocked)', () => {
  /**
   * The wire values of every event type the run path emits.
   *
   * This is the direct counterpart to the hand-written map in `apiAgUiModule.spec.ts`. The literals
   * on the right are the contract a client matches on; the values on the left come from the shipped
   * package. A rename upstream breaks this cell and nothing else in the suite.
   */
  it('spells each emitted event type exactly as the protocol does', () => {
    expect(EventType.RUN_STARTED).toBe('RUN_STARTED');
    expect(EventType.RUN_FINISHED).toBe('RUN_FINISHED');
    expect(EventType.RUN_ERROR).toBe('RUN_ERROR');
    expect(EventType.TEXT_MESSAGE_START).toBe('TEXT_MESSAGE_START');
    expect(EventType.TEXT_MESSAGE_CONTENT).toBe('TEXT_MESSAGE_CONTENT');
    expect(EventType.TEXT_MESSAGE_END).toBe('TEXT_MESSAGE_END');
    expect(EventType.TOOL_CALL_START).toBe('TOOL_CALL_START');
    expect(EventType.TOOL_CALL_ARGS).toBe('TOOL_CALL_ARGS');
    expect(EventType.TOOL_CALL_END).toBe('TOOL_CALL_END');
    expect(EventType.TOOL_CALL_RESULT).toBe('TOOL_CALL_RESULT');
    expect(EventType.REASONING_MESSAGE_START).toBe('REASONING_MESSAGE_START');
    expect(EventType.REASONING_MESSAGE_CONTENT).toBe('REASONING_MESSAGE_CONTENT');
    expect(EventType.REASONING_MESSAGE_END).toBe('REASONING_MESSAGE_END');
    expect(EventType.CUSTOM).toBe('CUSTOM');
    expect(EventType.STATE_SNAPSHOT).toBe('STATE_SNAPSHOT');
    expect(EventType.STATE_DELTA).toBe('STATE_DELTA');
  });

  /**
   * The run route writes this straight into the `Content-Type` response header, so it is as
   * wire-visible as the frames themselves — a client that negotiates on it stops reading the
   * stream if it changes.
   */
  it('negotiates the streaming content type the run route advertises', () => {
    expect(new EventEncoder({ accept: SSE_ACCEPT }).getContentType()).toBe('text/event-stream');
    // A client that sends no `accept` at all still gets SSE rather than a throw: `req.headers.accept`
    // is `string | undefined` and the run route passes it through unguarded.
    expect(new EventEncoder().getContentType()).toBe('text/event-stream');
  });

  /**
   * The first frame of every run, byte for byte.
   *
   * Built from the same fields `apiAgUiModule.ts` sends — `type`, `threadId`, `runId`, in that
   * order — so the pinned string is the literal text a client's SSE parser receives.
   */
  it('encodes a run-started frame exactly as it goes onto the wire', () => {
    const encoder = new EventEncoder({ accept: SSE_ACCEPT });

    expect(
      encoder.encode({
        type: EventType.RUN_STARTED,
        threadId: 'thread-1',
        runId: 'run-1',
      })
    ).toBe('data: {"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}\n\n');
  });

  /**
   * The two frames that carry the actual payload of a run: streamed assistant text, and the start
   * of a tool call. Together with the cell above they cover the three field shapes the run route
   * emits — a run-scoped frame, a message-scoped one, and a tool-scoped one.
   */
  it('encodes the streamed content and tool-call frames exactly', () => {
    const encoder = new EventEncoder({ accept: SSE_ACCEPT });

    expect(
      encoder.encode({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'message-1',
        delta: 'hello',
      })
    ).toBe('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"message-1","delta":"hello"}\n\n');

    expect(
      encoder.encode({
        type: EventType.TOOL_CALL_START,
        toolCallId: 'tool-call-1',
        toolCallName: 'read_file',
        parentMessageId: 'message-1',
      })
    ).toBe(
      'data: {"type":"TOOL_CALL_START","toolCallId":"tool-call-1","toolCallName":"read_file","parentMessageId":"message-1"}\n\n'
    );
  });

  /**
   * The framing itself, asserted apart from any one event: a frame is `data: `, one line of JSON,
   * and a blank line. A serializer that switched to multi-line JSON, added an `event:` line or
   * dropped the terminator would still satisfy a check that only looked for the type name.
   */
  it('frames each event as a single-line SSE record terminated by a blank line', () => {
    const frame = new EventEncoder({ accept: SSE_ACCEPT }).encode({
      type: EventType.RUN_FINISHED,
      threadId: 'thread-1',
      runId: 'run-1',
    });

    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    // Exactly the two trailing newlines — no others anywhere in the frame.
    expect(frame.split('\n')).toHaveLength(3);
    expect(JSON.parse(frame.slice('data: '.length))).toEqual({
      type: 'RUN_FINISHED',
      threadId: 'thread-1',
      runId: 'run-1',
    });
  });
});
