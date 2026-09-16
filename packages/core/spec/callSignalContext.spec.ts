import { describe, expect, it, vi } from 'vitest';
import {
  ambientSignalFetch,
  currentCallSignal,
  runWithCallSignal,
} from '#src/runtime/callSignalContext.js';

/**
 * [[EXT-180]] — the fast cells over the ambient-signal bridge.
 *
 * These pin the composition and the propagation. **They cannot tell whether the composed signal
 * actually tears a socket down** — that is `abortDrainsProcess.spec.ts`'s ollama cell, measured
 * from the server side, and the reason this node exists at all is that assertions of this shape
 * stay green over a signal nobody honours. Read these as a description of the wiring, not as
 * evidence that it works.
 */
describe('[[EXT-180]] ambient call signal', () => {
  it('has no ambient signal outside a deadline', () => {
    expect(currentCallSignal()).toBeUndefined();
  });

  it('exposes the signal to everything the started call awaits', async () => {
    const signal = new AbortController().signal;
    const seen = await runWithCallSignal(signal, async () => {
      // An await boundary, because the client's fetch is several of them deep — a bridge that only
      // works synchronously would be useless here.
      await Promise.resolve();
      return currentCallSignal();
    });
    expect(seen).toBe(signal);
  });

  it('passes a request through untouched when no deadline is running', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const init = { method: 'POST' };
    await ambientSignalFetch(base as unknown as typeof fetch)('http://127.0.0.1/x', init);
    expect(base).toHaveBeenCalledWith('http://127.0.0.1/x', init);
    expect((base.mock.calls[0] as unknown[])[1]).not.toHaveProperty('signal');
  });

  it('uses the ambient signal when the request brought none', async () => {
    const controller = new AbortController();
    const base = vi.fn(async () => new Response('ok'));
    await runWithCallSignal(controller.signal, () =>
      ambientSignalFetch(base as unknown as typeof fetch)('http://127.0.0.1/x')
    );
    const passed = (base.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(passed.signal).toBe(controller.signal);
  });

  it("aborts on the request's OWN signal as well as the ambient one", async () => {
    // The `ollama` client aborts its streamed requests through a controller of its own. Replacing
    // that signal rather than composing with it would trade this node's leak for a different one,
    // and nothing downstream would report it.
    const own = new AbortController();
    const ambient = new AbortController();
    const base = vi.fn(async () => new Response('ok'));
    await runWithCallSignal(ambient.signal, () =>
      ambientSignalFetch(base as unknown as typeof fetch)('http://127.0.0.1/x', {
        signal: own.signal,
      })
    );
    const passed = (base.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(passed.signal).not.toBe(own.signal);
    expect(passed.signal?.aborted).toBe(false);
    own.abort();
    expect(passed.signal?.aborted).toBe(true);
  });

  it('aborts the composed signal when the AMBIENT one fires', async () => {
    const own = new AbortController();
    const ambient = new AbortController();
    const base = vi.fn(async () => new Response('ok'));
    await runWithCallSignal(ambient.signal, () =>
      ambientSignalFetch(base as unknown as typeof fetch)('http://127.0.0.1/x', {
        signal: own.signal,
      })
    );
    const passed = (base.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(passed.signal?.aborted).toBe(false);
    ambient.abort();
    expect(passed.signal?.aborted).toBe(true);
  });

  it('keeps the rest of the request init', async () => {
    const ambient = new AbortController();
    const base = vi.fn(async () => new Response('ok'));
    await runWithCallSignal(ambient.signal, () =>
      ambientSignalFetch(base as unknown as typeof fetch)('http://127.0.0.1/x', {
        method: 'POST',
        headers: { 'x-gth': '1' },
      })
    );
    const passed = (base.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(passed.method).toBe('POST');
    expect(passed.headers).toEqual({ 'x-gth': '1' });
  });
});
