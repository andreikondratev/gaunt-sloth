/**
 * The retry posture this project owns, as one number.
 *
 * ## The ruling
 *
 * One unified retry count everywhere we retry — not a count per error class. Transport and network
 * errors retry. `invalid_request` and `auth_failed` never do; `rate_limited` backs off;
 * `provider_error` retries; `timeout` backs off and retries. The single count is deliberate and is
 * to be changed only on evidence that it does not work in some situation — at which point the
 * amendment is this one value, not a new table.
 *
 * ## Why naming it changes nothing observable, and why that is the point
 *
 * Six is the number already in force: it is `AsyncCaller`'s own default in `@langchain/core`, which
 * every model we build inherited silently. Naming it moves the number from an upstream default we
 * never chose into a value this project states, so a future change is a one-word edit here with a
 * test that moves with it, rather than an argument about what the runtime currently does. The
 * behaviour on the day it landed is identical by construction.
 *
 * Six retries means **seven attempts**. The backoff is p-retry's default — factor 2 from a one
 * second minimum, randomized — so a fully exhausted sequence spans roughly one to two minutes. A
 * provider's `retry-after` is honoured when it is longer than the computed delay.
 *
 * ## This is a ceiling, not a policy engine
 *
 * The count bounds how many times a retryable failure is re-sent. **Which failures are retryable is
 * decided upstream**, inside `AsyncCaller`'s failed-attempt handler, not here and not by
 * `GthTerminationCategory`'s posture table — see the reconciliation docblock in
 * `terminationReason.ts`, which is the seam where those two descriptions are made to agree.
 *
 * Upstream's classification matches the ruled posture row for row: a 400/401/403/404/409/413 class
 * status is thrown rather than retried, a 429 is split into stop (quota exhausted) / wait / capacity
 * with only the quota case non-retryable, and everything else — transport included — falls through
 * and is retried.
 *
 * ## Two upstream carve-outs, so the next reader does not rediscover them
 *
 * Both sit in `@langchain/core`'s async caller and both narrow the ruled "transport retries" row.
 * Neither is fixable from this module; they are recorded here because they are invisible from the
 * call site.
 *
 * 1. **A connection aborted mid-request does not retry.** The failed-attempt handler rethrows an
 *    error whose `code` is `ECONNABORTED`, and a throw from that handler aborts the retry loop
 *    outright rather than being caught as one more failed attempt. So one spelling of transport
 *    error is exempt from the row that says transport retries.
 * 2. **Transport detection is an exact-string enumeration.** A network error is recognised by
 *    matching the error's message against a fixed list of literals, and only when its `name` is
 *    `TypeError`. Node's fetch currently produces one of those literals, so it works today; a
 *    wording change upstream silently reclassifies transport as non-retryable, with no error
 *    anywhere and no test of ours that would notice. Enumerations of this shape fail by omission,
 *    so treat the list as a sample rather than a specification.
 *
 * ## Where the number reaches, per provider
 *
 * Every provider factory under `src/providers/` passes this value, but it only *does* something
 * where the provider routes its request through the model's `AsyncCaller`. Three groups:
 *
 * - **Enforced.** anthropic, openai, deepseek, huggingface, xai, groq, google-genai, vertexai, and
 *   openrouter's two wrapped paths all call through the caller, so the count bounds their retries.
 * - **Accepted but inert.** ollama takes the parameter — it is an ordinary chat-model parameter and
 *   the caller object is built — but every one of its chat paths calls the Ollama client directly,
 *   bypassing the caller, so nothing retries and the number has no effect. It is passed anyway for
 *   uniformity and so the value starts applying if upstream wires the caller in. See the note in
 *   `providers/ollama.ts`.
 * - **Unwrapped upstream path, not currently reachable.** `ChatOpenRouter` has a third streaming
 *   entry point that issues its request outside the caller, so nothing retries on it for any class.
 *   Reaching it requires a LangGraph stream-event handler that this project never registers, so it
 *   is closed to us today; it would be an upstream fix rather than one this module can make.
 *
 * A user's own explicitly configured value still wins everywhere — each factory treats this as a
 * default, not an override.
 */
export const GTH_MAX_RETRIES = 6;
