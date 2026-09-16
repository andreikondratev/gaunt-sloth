/**
 * @packageDocumentation
 * CFG-72 — the mark that says "a middleware appended this message to state in this step".
 *
 * A `beforeModel` hook that returns `{ messages }` writes into the graph's conversation, and every
 * such hook runs as its own graph node BEFORE the agent node where `wrapModelCall` sees the request
 * (langchain@1.5.x `ReactAgent`: the tools node routes back to the first `beforeModel` node, the
 * chain ends at the agent node, and the agent node builds its request from `state.messages`). So by
 * the time a `wrapModelCall` hook reads the tail, a sibling's appended message is already sitting on
 * the end of it — by composition, not by a race.
 *
 * That breaks any `wrapModelCall` hook that reasons about **message adjacency**: "the tool results
 * this model call continues from" is the trailing run of ToolMessages only while nothing else has
 * appended. The mark restores the distinction the tail alone no longer carries — a message a
 * middleware put there in this step, versus a message that is part of the conversation.
 *
 * **Why a property on the message rather than a `WeakSet` of message objects.** Object identity does
 * not survive the graph hop reliably, and it cannot survive a checkpoint/replay at all; worse, a
 * `WeakSet` living in one module copy is invisible to a second `@langchain/core` copy in a
 * consumer's tree, which is the RC-21 failure this codebase already carries a rule about.
 * `additional_kwargs` is plain data: it serialises with the message and is read without touching
 * class identity.
 *
 * **Why `additional_kwargs` is safe to write on a message bound for a provider** — measured, not
 * assumed, with `globalThis.fetch` replaced by a capture stub and no vendor call: neither
 * `@langchain/openai@1.5.13` nor `@langchain/anthropic@1.5.10` copies a HumanMessage's
 * `additional_kwargs` into the request body. The marked message reaches the wire as
 * `{"role":"user","content":"…"}`, byte-for-byte what it would be unmarked.
 *
 * **This is deliberately not keyed to one middleware.** Any middleware that appends to state in
 * `beforeModel` — gth's own, or one a user writes in a JS config — marks what it appends and is then
 * invisible to adjacency reasoning downstream. A middleware that does not mark still shadows; see
 * the seam comment on `collectTrailingBinaryContent` for why that residual is accepted rather than
 * closed by widening the window.
 */
import type { BaseMessage } from '@langchain/core/messages';

/**
 * The `additional_kwargs` key carrying the mark. Namespaced with the `gth_` prefix so it cannot
 * collide with a provider-specific key a converter does look for.
 */
export const MIDDLEWARE_INJECTED_KEY = 'gth_middleware_injected';

/**
 * Mark a message as appended to state by a middleware in this step, and return it.
 *
 * Call it on a message you are about to append from a `beforeModel` hook, at the point of
 * construction. Mutates the message rather than copying it: the caller has just built it and owns
 * it, and a copy would lose whatever subclass it is.
 *
 * Do NOT mark a message that is added to a REQUEST only (the `wrapModelCall` shape) — it never
 * enters state, so nothing downstream can meet it, and marking it would mean that if it ever did
 * leak into state a later adjacency walk would step straight over it instead of stopping. Unmarked
 * fails safe in that direction; marked does not.
 */
export function markMiddlewareInjected<T extends BaseMessage>(message: T): T {
  message.additional_kwargs = { ...message.additional_kwargs, [MIDDLEWARE_INJECTED_KEY]: true };
  return message;
}

/**
 * Whether this message carries the mark.
 *
 * Duck-typed on purpose — no `instanceof`, no class identity. A consumer resolving a second
 * `@langchain/core` copy across a `file:`-dep boundary (RC-21) must still read the mark, because a
 * marked message read as unmarked puts the shadow straight back.
 */
export function isMiddlewareInjected(message: BaseMessage | undefined | null): boolean {
  const kwargs = (message as { additional_kwargs?: Record<string, unknown> } | undefined | null)
    ?.additional_kwargs;
  return kwargs?.[MIDDLEWARE_INJECTED_KEY] === true;
}
