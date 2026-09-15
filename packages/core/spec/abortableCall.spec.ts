import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GthConfig } from '#src/config.js';
import {
  CALL_TIMED_OUT,
  raceCallDeadline,
  startCallDeadline,
  withCallDeadline,
} from '#src/runtime/abortableCall.js';
import { askStructured } from '#src/runtime/askStructured.js';
import { rateShellCommand } from '#src/core/shell/rater.js';
import { isFailClosed } from '#src/core/shell/rater.js';
import { runAlignmentCheck } from '#src/core/shell/alignment.js';
import type { AlignmentSubject } from '#src/core/shell/alignment.js';
import { isAlignmentFailClosed } from '#src/core/shell/alignment.js';

/**
 * [[EXT-179]] — **the signal has to REACH the provider call.**
 *
 * Every cell below asserts the same two things, because a fix here has exactly two ways to be
 * hollow and each assertion catches one of them:
 *
 * 1. `invoke` received an options object carrying a `signal` — this fails if a controller is
 *    created and the signal is never passed down, which is the failure the node warns about
 *    (a timeout that aborts nothing, behind a green suite).
 * 2. That same signal reads `aborted === true` once the budget has fired — this fails if the
 *    signal is threaded through but nothing ever aborts it.
 *
 * Both are asserted on **the object the provider call actually received**, never on one the test
 * built, so neither can pass by construction.
 *
 * What these cells deliberately do NOT claim is that the provider honours the signal — a fake
 * cannot show that, and asserting it here would be the substituted-component trap. The end-to-end
 * proof, against a real client and a real socket, is `abortDrainsProcess.spec.ts`.
 */

const Schema = z.object({ name: z.string() });

/** What one `invoke` call was given: the options object, captured by reference. */
interface SeenCall {
  opts?: { signal?: AbortSignal };
}

/**
 * A model whose structured `invoke` NEVER answers — the stalled provider this node is about — and
 * which records the options it was handed. The returned promise is left pending forever on purpose:
 * that is what forces the budget to be the thing that ends the call.
 */
function stalledStructuredModel(seen: SeenCall) {
  const structuredInvoke = vi.fn((_messages: unknown, opts?: { signal?: AbortSignal }) => {
    seen.opts = opts;
    return new Promise<never>(() => {});
  });
  return {
    structuredInvoke,
    model: {
      withStructuredOutput: vi.fn(() => ({ invoke: structuredInvoke })),
    } as unknown as BaseChatModel,
  };
}

/** The same, for the tool-calling (`bindTools`) shape the alignment checker uses. */
function stalledToolModel(seen: SeenCall) {
  const boundInvoke = vi.fn((_messages: unknown, opts?: { signal?: AbortSignal }) => {
    seen.opts = opts;
    return new Promise<never>(() => {});
  });
  return {
    boundInvoke,
    model: {
      bindTools: vi.fn(() => ({ invoke: boundInvoke })),
    } as unknown as BaseChatModel,
  };
}

/** Assert the two halves together — the whole point of these cells. */
function expectAbortReachedTheCall(seen: SeenCall): void {
  expect(seen.opts, 'invoke was called without any options object').toBeDefined();
  expect(
    seen.opts?.signal,
    'invoke received no `signal` — the signal never reached the provider call'
  ).toBeInstanceOf(AbortSignal);
  expect(
    seen.opts?.signal?.aborted,
    'the signal reached the call but was never aborted when the budget fired'
  ).toBe(true);
}

const BUDGET_MS = 25;

describe('[[EXT-179]] abortableCall — the shared race/abort mechanism', () => {
  it('returns the call value when the call wins, and never aborts the signal', async () => {
    let seenSignal: AbortSignal | undefined;
    const result = await withCallDeadline(10_000, (signal) => {
      seenSignal = signal;
      return Promise.resolve('answered');
    });
    expect(result).toBe('answered');
    expect(seenSignal?.aborted).toBe(false);
  });

  it('returns the sentinel and aborts the signal when the budget wins', async () => {
    let seenSignal: AbortSignal | undefined;
    const result = await withCallDeadline(BUDGET_MS, (signal) => {
      seenSignal = signal;
      return new Promise<never>(() => {});
    });
    expect(result).toBe(CALL_TIMED_OUT);
    expect(seenSignal?.aborted).toBe(true);
  });

  /**
   * The ordering cell, and the reason `startCallDeadline` resolves its sentinel BEFORE aborting.
   *
   * Here the call rejects the instant it is aborted — which is what a well-behaved provider client
   * does. If the abort were issued first, that rejection could settle the race ahead of the
   * sentinel and this would throw an `AbortError` instead of returning `CALL_TIMED_OUT`. At the
   * rater that difference re-files a timeout as a thrown call and moves a gate decision onto a
   * different [[EXT-171]] arm, so it is pinned here rather than left to the comment.
   */
  it('reports a timeout as the sentinel even when the abort rejects the call immediately', async () => {
    const result = await withCallDeadline(
      BUDGET_MS,
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        })
    );
    expect(result).toBe(CALL_TIMED_OUT);
  });

  /**
   * The abort we cause ourselves must not surface as an unhandled rejection — on modern Node that
   * is fatal, so the guard against a hang would have become a way to crash a healthy run.
   */
  it('does not leave the aborted call as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await withCallDeadline(
        BUDGET_MS,
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            );
          })
      );
      expect(result).toBe(CALL_TIMED_OUT);
      // Let any unhandled rejection be reported before we look.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it("propagates the call's own rejection, so a provider error still reaches the caller", async () => {
    await expect(
      withCallDeadline(10_000, () => Promise.reject(new Error('provider said no')))
    ).rejects.toThrow('provider said no');
  });

  /**
   * The multi-turn property the alignment checker depends on: ONE budget across many calls, so a
   * loop cannot silently multiply its wall-clock allowance by the turn count.
   *
   * Asserted two ways, because each catches a different half and the timing one alone is weak.
   * The **identity** assertion is deterministic: every turn is handed the very same `AbortSignal`,
   * which a `startCallDeadline` moved inside the loop could not produce. The **remainder**
   * assertion is the one that shows the clock kept running — the first turn eats most of the
   * budget, so a shared deadline leaves the stalled second turn only what is left (~150ms) while a
   * per-turn deadline would give it a fresh 400ms. The bound sits halfway between, so it is clear
   * of both by the same generous margin rather than being tuned to the passing side.
   */
  it('spends one shared budget across several races rather than restarting it per call', async () => {
    const BUDGET = 400;
    const FIRST_TURN = 250;
    const deadline = startCallDeadline(BUDGET);
    try {
      const signals: AbortSignal[] = [];
      const first = await raceCallDeadline(deadline, (signal) => {
        signals.push(signal);
        return new Promise<string>((resolve) => setTimeout(() => resolve('turn one'), FIRST_TURN));
      });
      expect(first).toBe('turn one');

      const started = Date.now();
      const second = await raceCallDeadline(deadline, (signal) => {
        signals.push(signal);
        return new Promise<never>(() => {});
      });
      expect(second).toBe(CALL_TIMED_OUT);
      expect(Date.now() - started).toBeLessThan((BUDGET + (BUDGET - FIRST_TURN)) / 2);
      expect(signals[1]).toBe(signals[0]);
      expect(deadline.signal.aborted).toBe(true);
    } finally {
      deadline.dispose();
    }
  });
});

describe('[[EXT-179]] site 1 — askStructured aborts its provider call on timeout', () => {
  it('passes a signal into invoke and aborts it when the budget fires', async () => {
    const seen: SeenCall = {};
    const { model } = stalledStructuredModel(seen);
    const config = { llm: model } as unknown as GthConfig;

    const result = await askStructured(Schema, {
      config,
      system: 's',
      user: 'u',
      timeoutMs: BUDGET_MS,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out/i);
    expectAbortReachedTheCall(seen);
  });
});

describe('[[EXT-179]] site 2 — the approvals rater aborts its rating call on timeout', () => {
  /**
   * The highest-stakes of the four: this is on the critical path of every gated shell command.
   *
   * The verdict assertion is as important as the signal assertion. [[EXT-171]] rules that a rating
   * the gate never obtained escalates, keyed on the call's own `FailClosedCause`. An abort must
   * land on that already-ruled `timeout` arm and must NOT invent a second path — so this asserts
   * the abort happened AND that the verdict is still the fail-closed timeout verdict, naming the
   * budget, exactly as before the call became abortable.
   */
  it('aborts the rating call, and still fails closed on the ruled timeout path', async () => {
    const seen: SeenCall = {};
    const { model } = stalledStructuredModel(seen);
    const config = {} as unknown as GthConfig;
    const captures: Array<{ failClosed?: string; verdict?: unknown }> = [];

    const verdict = await rateShellCommand('rm -rf /tmp/x', config, {
      model,
      timeoutMs: BUDGET_MS,
      onCapture: (capture) => captures.push(capture as { failClosed?: string }),
    });

    expectAbortReachedTheCall(seen);
    expect(isFailClosed(verdict)).toBe(true);
    expect(verdict.outcome).toBe('destructive');
    expect(verdict.reason).toContain(`${BUDGET_MS}ms`);
    // The cause is what EXT-171's escalate arm keys on. An abort is the timeout observed from the
    // other side, so the cause must still read `timeout` and never `threw`.
    expect(captures[0]?.failClosed).toBe('timeout');
  });
});

describe('[[EXT-179]] site 3 — the alignment checker aborts its in-flight turn on timeout', () => {
  const subject: AlignmentSubject = {
    command: 'rm -rf ./dist',
    outcome: 'destructive',
    reason: 'it deletes a directory',
  };

  it('aborts the turn in flight, and still fails closed', async () => {
    const seen: SeenCall = {};
    const { model } = stalledToolModel(seen);
    const config = {} as unknown as GthConfig;

    const decision = await runAlignmentCheck(subject, config, {
      model,
      userMessages: ['clear the dist folder'],
      timeoutMs: BUDGET_MS,
    });

    expectAbortReachedTheCall(seen);
    expect(isAlignmentFailClosed(decision)).toBe(true);
  });
});
