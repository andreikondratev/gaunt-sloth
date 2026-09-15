/**
 * @module runtime/abortableCall
 *
 * [[EXT-179]] — race a model call against a wall-clock budget **and abort the call when the budget
 * wins**, instead of abandoning it.
 *
 * ## Why this is one helper and not four threaded signals
 *
 * Four sites independently grew the same shape — `structured.invoke(...)` (or `bound.invoke(...)`)
 * raced against a `setTimeout` that resolves a `TIMEOUT` sentinel, with `clearTimeout` in a
 * `finally`: {@link import('./askStructured.js').askStructured}, the approvals rater
 * (`core/shell/rater.ts`), the alignment checker (`core/shell/alignment.ts`) and the eval judge
 * (`@gaunt-sloth/batch`'s `judge.ts`). All four had the same defect, and **the duplication is what
 * hid it**: each copy looked complete on its own, and a fix to any one of them reached none of the
 * others.
 *
 * So the *mechanism* is centralised here and the *meaning* stays at each call site. Each site keeps
 * its own sentinel handling, its own error text and its own failure semantics — the rater still
 * fails closed, the judge still fails the case, `askStructured` still returns `{ ok: false }`. What
 * they no longer each own is the part that is subtle and was wrong four times: creating the
 * controller, ordering the abort against the race, and keeping the abort from surfacing as an
 * unhandled rejection.
 *
 * ## What is and is not proven about the abort reaching the provider
 *
 * An `AbortSignal` that the provider client ignores leaves the original symptom exactly as it was,
 * with a green test over it. Measured at this commit against a local HTTP server that accepts the
 * request and never answers, observing the socket from the server side:
 *
 * - **`@langchain/openai` 1.5.13 (and the OpenAI-compatible clients built on it): honoured.** The
 *   signal tears the connection down — the server sees the request close unanswered, the socket
 *   count drops to zero, and a process that ends by draining (`process.exitCode`, no
 *   `process.exit`) exits instead of hanging. Without the signal that same process hangs until
 *   killed, which is the differential that makes this a measurement rather than an assertion.
 * - **`@langchain/ollama` 1.3.0: NOT honoured at the socket.** It reads the signal only at the
 *   consumption layer — `options.signal?.throwIfAborted()` and an early `return` out of the stream
 *   generator — and never passes it to the underlying fetch. The promise rejects promptly with
 *   `AbortError`, so every assertion here still passes, **but the HTTP request stays in flight and
 *   still holds the event loop open.** For that provider this module bounds the *wait*, not the
 *   *connection*; closing that gap needs a change in `@langchain/ollama` itself.
 *
 * That second bullet is the reason this doc names versions. A later bump can turn it from false to
 * true, and nothing in the unit suite can tell you it did.
 */

/**
 * The sentinel {@link raceCallDeadline} resolves to when the budget expired before the call
 * answered. A unique symbol, so no provider payload can ever be mistaken for it — the reason each
 * of the four sites used a `Symbol` rather than a string or `null` in the first place.
 */
export const CALL_TIMED_OUT: unique symbol = Symbol('gth-call-timed-out');

/** A started wall-clock budget: the signal to hand the call, and the promise that says it expired. */
export interface CallDeadline {
  /**
   * The signal to pass to the provider call. Aborted when — and only when — the budget expires.
   */
  readonly signal: AbortSignal;
  /**
   * Resolves to {@link CALL_TIMED_OUT} when the budget expires. Never rejects, so it can be raced
   * against a call without the loser becoming a rejection of its own.
   */
  readonly expired: Promise<typeof CALL_TIMED_OUT>;
  /**
   * Clear the timer. Call this in a `finally` on every exit from the budgeted region, including
   * the successful one: a timer left armed keeps the event loop alive for the rest of the budget,
   * which is a smaller version of the very hang this module exists to end.
   */
  dispose(): void;
}

/**
 * Start a wall-clock budget.
 *
 * **The ordering inside the timer callback is load-bearing.** The sentinel is resolved *before* the
 * controller is aborted, because aborting first can settle the in-flight call's promise ahead of
 * the sentinel — and then `Promise.race` yields the `AbortError` instead of {@link CALL_TIMED_OUT}.
 * At the rater that would silently re-file a timeout as a thrown call: the verdict's
 * `FailClosedCause` would become `'threw'` rather than `'timeout'`, moving a gate decision
 * [[EXT-171]] rules on onto a different arm, with the user-facing sentence changing to match. With
 * the sentinel resolved first the race is settled before the abort can be observed, so every site
 * keeps exactly the timeout path it had.
 *
 * The timer is deliberately **not** `unref`'d. It is the budget itself, not a backstop, and an
 * unref'd budget can be skipped entirely if nothing else is holding the loop — which would make the
 * timeout path untestable in exactly the conditions it exists for. {@link CallDeadline.dispose} is
 * what stops it outliving the call.
 *
 * @param timeoutMs The wall-clock budget in milliseconds.
 */
export function startCallDeadline(timeoutMs: number): CallDeadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof CALL_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      // Resolve first, abort second — see the doc above. Reordering these two lines is a
      // behaviour change at every call site, not a tidy-up.
      resolve(CALL_TIMED_OUT);
      controller.abort();
    }, timeoutMs);
  });
  return {
    signal: controller.signal,
    expired,
    dispose() {
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Run one provider call under an already-started budget, returning either the call's value or
 * {@link CALL_TIMED_OUT}.
 *
 * The deadline is passed in rather than started here so that a **multi-turn** caller can hold one
 * budget across many calls. The alignment checker's budget is one wall-clock budget for one gate
 * decision; starting a fresh one per turn would silently multiply it by the turn count, on exactly
 * the slow local models the budget exists to accommodate. Single-shot callers use
 * {@link withCallDeadline}, which starts and disposes one for them.
 *
 * **The call's own rejections still propagate.** Only the abort *this* module causes is swallowed;
 * a provider error, an auth failure or a transport failure rejects out of here as before, so each
 * site's existing `catch` arm keeps its meaning.
 *
 * @param deadline The budget from {@link startCallDeadline}.
 * @param start Starts the call, given the signal to pass to the provider. It is called exactly
 *   once. **The signal has to reach the provider invocation** — a `start` that ignores it produces
 *   a helper that times out and aborts nothing, which is the defect this module was written to fix.
 */
export async function raceCallDeadline<T>(
  deadline: CallDeadline,
  start: (signal: AbortSignal) => Promise<T>
): Promise<T | typeof CALL_TIMED_OUT> {
  const call = start(deadline.signal);
  // **The `Promise.race` below is also what keeps the abort from becoming an unhandled rejection**,
  // and that is worth stating because the obvious defensive line here is redundant. The losing
  // entrant still settles — and on the timeout path the entrant we lose is one WE abort, so it
  // settles as a rejection — but `race` subscribes to both entrants synchronously, which marks
  // them handled whenever they settle. An extra `call.catch(() => {})` therefore changes nothing;
  // it was tried here and no test could tell it apart from its absence.
  //
  // What this DOES depend on is that the call is raced rather than merely started: a refactor that
  // started the call and then only awaited `deadline.expired` would leave that rejection with no
  // subscriber, and an unhandled rejection is fatal on modern Node — the guard against a hang
  // would have become a way to crash a healthy run. `abortableCall.spec.ts` pins that.
  return Promise.race([call, deadline.expired]);
}

/**
 * The single-shot form: start a budget, run one call under it, and dispose the budget on every
 * exit — including the throwing one, which is why the `finally` is not optional.
 *
 * @param timeoutMs The wall-clock budget in milliseconds.
 * @param start As {@link raceCallDeadline}'s.
 */
export async function withCallDeadline<T>(
  timeoutMs: number,
  start: (signal: AbortSignal) => Promise<T>
): Promise<T | typeof CALL_TIMED_OUT> {
  const deadline = startCallDeadline(timeoutMs);
  try {
    return await raceCallDeadline(deadline, start);
  } finally {
    deadline.dispose();
  }
}
