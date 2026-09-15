import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncCaller } from '@langchain/core/utils/async_caller';
import { GTH_MAX_RETRIES } from '#src/core/retryPolicy.js';

/**
 * EXT-92 scope (c) — the retry count this project states is the count that runs.
 *
 * ## What makes these tests the acceptance rather than a restatement
 *
 * The node asks for "a test that changing the constant changes behaviour", and explicitly rules out
 * one that reads the constant back. So **every expectation below is a hardcoded literal**, never
 * `GTH_MAX_RETRIES` or an expression over it. That is deliberate and it is the whole mechanism:
 * `expect(attempts).toBe(GTH_MAX_RETRIES + 1)` passes for every possible value of the constant and
 * therefore asserts nothing, whereas `expect(attempts).toBe(7)` fails the moment the number moves.
 *
 * If you are changing the count on purpose, these literals are what you update, and updating them
 * is the acknowledgement that behaviour changed. Do not reintroduce the constant on the right-hand
 * side to stop them failing — that converts the gate into a no-op.
 *
 * ## Why the timers are faked
 *
 * The retry delay is p-retry's default: doubling from one second, randomized. Exhausting six
 * retries is one to two minutes of real sleeping, which would make this the slowest file in the
 * suite and a timing-sensitive cell on slower CI runners. `AsyncCaller` exposes no knob to shorten
 * it, so the delays are advanced rather than waited out. The attempt COUNT is unaffected by faking
 * the clock — it is what is being measured.
 */
describe('GTH_MAX_RETRIES', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Drive a caller to exhaustion and report how many times the work was actually attempted.
   *
   * The error is a bare `Error`: upstream's failed-attempt handler exempts several shapes from
   * retrying (an abort, an `ECONNABORTED` code, a no-retry HTTP status, an exhausted quota), and an
   * error that tripped one of those would be attempted exactly once — which this file would then
   * report as a retry count of 1 and which would look like a broken constant rather than a badly
   * chosen fixture. A plain `Error` carries no code, no status and no rate-limit metadata, so it
   * falls through every carve-out and is retried. The `expect` below on the control case is what
   * keeps that assumption honest.
   */
  async function countAttempts(caller: AsyncCaller): Promise<number> {
    let attempts = 0;
    const settled = caller
      .call(async () => {
        attempts += 1;
        throw new Error('transient failure');
      })
      .then(
        () => 'resolved' as const,
        () => 'rejected' as const
      );
    await vi.runAllTimersAsync();
    expect(await settled).toBe('rejected');
    return attempts;
  }

  it('retries a transient failure six times, for seven attempts in total', async () => {
    const caller = new AsyncCaller({ maxRetries: GTH_MAX_RETRIES });

    // The literal is the gate. Change GTH_MAX_RETRIES and this fails.
    expect(await countAttempts(caller)).toBe(7);
  });

  /**
   * The differential. The test above would still pass if `maxRetries` were being ignored and seven
   * attempts came from somewhere else — upstream's own default is also 6, so the two are
   * indistinguishable on a single sample. Two other values prove the parameter is what decides, and
   * that a caller built from a DIFFERENT number behaves differently. Without this, "the constant is
   * in force" rests on a coincidence of defaults.
   */
  it('attempts exactly one more time than the count it was given', async () => {
    expect(await countAttempts(new AsyncCaller({ maxRetries: 0 }))).toBe(1);
    expect(await countAttempts(new AsyncCaller({ maxRetries: 2 }))).toBe(3);
  });

  it('is the value this project states, not an inherited default', () => {
    // A caller given no count at all falls back to the upstream default. Ours must be a choice we
    // made rather than that fallback showing through — they coincide today, and this records that
    // the coincidence is intentional rather than accidental.
    expect(GTH_MAX_RETRIES).toBe(6);
  });

  /**
   * END TO END: our factory → the real SDK class → its `AsyncCaller` → the attempts it makes.
   *
   * ## Why this test exists, and what is uncovered without it
   *
   * The tests above build an `AsyncCaller` by hand, and the per-provider breadth test
   * (`retryPolicyProviders.spec.ts`) asserts against MOCKED model constructors that build no caller
   * at all. So every one of them passes whether or not the number a factory sets actually reaches a
   * retry loop — the link in the middle is substituted away in both directions. That link is the
   * entire claim: the retry-policy docblock states nine providers are ENFORCED, meaning the count
   * bounds their real retries, and nothing else here would notice if a constructor silently dropped
   * the parameter.
   *
   * So this file mocks NOTHING. It builds a real `ChatOpenAI` through the real openai factory and
   * counts the attempts its own caller makes. A dummy key is fine because the failure is injected
   * before any request is issued — nothing here touches the network.
   */
  it('gives a provider built by our own factory the stated count, and it governs the attempts', async () => {
    const { processJsonConfig } = await import('#src/providers/openai.js');

    const model = await processJsonConfig({
      type: 'openai',
      apiKey: 'sk-test-not-a-real-key',
      model: 'gpt-4o',
    } as never);

    const caller = (model as unknown as { caller: AsyncCaller }).caller;

    // Literals, as everywhere in this file: both fail if GTH_MAX_RETRIES moves.
    expect(caller.maxRetries).toBe(6);
    expect(await countAttempts(caller)).toBe(7);
  });
});
