/**
 * [[EXT-180]] — make the deadline's `AbortSignal` **ambient**, so it can reach a provider client
 * that offers no parameter to hand one to.
 *
 * ## Why an ambient signal exists at all
 *
 * The normal way to bound a provider call is to pass `{ signal }` down to the client and let it
 * abort its own request. Every OpenAI-family client we use does that, and for them this module is
 * never consulted: {@link ambientSignalFetch} is only installed where a client cannot be told.
 *
 * `@langchain/ollama` is that case. Its chat path calls
 * `this.client.chat({ ...params, messages, stream: true })` with **no signal in the request**, and
 * the `ollama` JS client's public API has nowhere to put one — `chat(request)` forwards its argument
 * as the JSON body, and the only `AbortController` involved is one `processStreamableRequest`
 * constructs for itself. So the signal cannot be threaded through the call; it has to arrive by a
 * side channel.
 *
 * The side channel that works is the client's `fetch`. `ChatOllama` accepts a `fetch` field and
 * hands it straight to the `Ollama` constructor, and every request — including the one that stalls —
 * goes through it. Composing our signal onto that request's own signal is therefore the one place a
 * caller can reach the socket.
 *
 * ## Why the abort has to reach the `fetch` call itself
 *
 * This is the part that looks over-engineered until the failure is understood, and it is the reason
 * three simpler fixes do not work.
 *
 * `await client.chat(...)` suspends inside the client's `await fetch(...)`, which settles only when
 * **response headers** arrive. A provider that accepts the connection and never answers therefore
 * never returns a stream object at all:
 *
 * - the `for await` loop over the stream is never *entered*, so the `client.abort()` that sits in
 *   its body never runs;
 * - `stream.abort()` on the returned iterator cannot be registered, because there is no iterator
 *   yet;
 * - `client.abort()` iterates the client's list of ongoing streamed requests, and a request is
 *   pushed onto that list only *after* its headers arrive — so it is empty.
 *
 * Every one of those is a handle that exists only once the provider has answered, and a provider
 * that has answered is not the case being bounded. Aborting the in-flight `fetch` is the only route
 * that closes a socket which has produced nothing.
 *
 * ## Scope, stated rather than glossed
 *
 * The context is established by `raceCallDeadline`, so this covers **calls made under a call
 * deadline** — the sites that helper names. A caller that passes `{ signal }` straight to
 * `invoke()` without a deadline sets no context, and for ollama such a call still leaks its socket.
 * Closing *that* gap needs the signal read from the call options, which means overriding
 * `ChatOllama`'s stream methods or a fix upstream; it is a deliberate non-goal here, not an
 * oversight.
 *
 * `packages/core/spec/abortDrainsProcess.spec.ts` measures all of this from the server side, with a
 * control that pins it to this mechanism specifically.
 *
 * @module
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The ambient signal for the call currently running under a deadline.
 *
 * `AsyncLocalStorage` rather than an instance field or a module-level variable, because a single
 * chat model is shared across concurrent calls: a plain field would be overwritten by whichever
 * call started last, and the fetch would then compose the wrong call's signal onto the request.
 */
const callSignals = new AsyncLocalStorage<AbortSignal>();

/**
 * Run `fn` with `signal` as the ambient call signal, for `fn` and everything it awaits.
 *
 * @param signal The deadline's signal.
 * @param fn Starts the provider call. The context has to be live at the moment the client's
 *   `fetch` is invoked, which is why this wraps the *start* of the call rather than the `await` of
 *   its result.
 * @returns Whatever `fn` returns, unchanged.
 */
export function runWithCallSignal<T>(signal: AbortSignal, fn: () => T): T {
  return callSignals.run(signal, fn);
}

/**
 * The ambient call signal, or `undefined` outside any deadline.
 */
export function currentCallSignal(): AbortSignal | undefined {
  return callSignals.getStore();
}

/**
 * Wrap a `fetch` so that every request it makes is **also** aborted by the ambient call signal.
 *
 * The request's own signal is preserved rather than replaced. The `ollama` client aborts its
 * streamed requests through a controller of its own, and dropping that would trade one leak for
 * another — so the two are composed, and the request aborts when *either* fires.
 *
 * Outside a deadline there is no ambient signal and the call is passed through untouched, so
 * installing this on a client costs nothing when no deadline is running.
 *
 * @param base The fetch to delegate to. Defaults to the global one.
 * @returns A fetch with the same signature, safe to hand to a client constructor.
 */
export function ambientSignalFetch(base: typeof fetch = fetch): typeof fetch {
  return (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const ambient = currentCallSignal();
    if (!ambient) return base(input, init);
    const own = init?.signal;
    return base(input, { ...init, signal: own ? AbortSignal.any([own, ambient]) : ambient });
  };
}
