/**
 * [[EXT-92]] scope (a) — the wait-narration mechanism.
 *
 * **What these cells are for, and what they deliberately leave to their siblings.** This file owns
 * the properties the node's acceptance is written in — that a wait past the threshold produces
 * **exactly one** signal, that a wait under it produces none, and that the signal names what is
 * being awaited. It proves them on the module itself, with fake timers, so the answers are exact
 * rather than sampled.
 *
 * It cannot prove that the rating call is actually wrapped in this, and it does not try:
 * `GthLeanShellApprovalGate.spec.ts` drives the real runner through the real approval graph with
 * this module unmocked, which is the assertion that fails if someone removes the wrapper. A cell
 * here that mocked the runner would pass either way — the shape this repo has been bitten by
 * before, and the reason the two files are split the way they are.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { StatusLevel } from '#src/core/types.js';

describe('waitNarration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the message', () => {
    it('names the activity and opens with the shared prefix', async () => {
      const { waitNarrationMessage, WAIT_NARRATION_PREFIX } =
        await import('#src/core/waitNarration.js');

      const message = waitNarrationMessage('rating');

      expect(message.startsWith(WAIT_NARRATION_PREFIX)).toBe(true);
      // The literal, not the constant: an expectation written in terms of the value under test
      // holds for every value it could take and so asserts nothing about this one.
      expect(message).toBe('Still working: rating this command');
    });

    /**
     * The half that answers the report. A user told only that something is happening still does
     * not know whether thirty seconds of silence means "wait" or "this is wedged".
     */
    it('states the budget in whole seconds when the caller knows one', async () => {
      const { waitNarrationMessage } = await import('#src/core/waitNarration.js');

      expect(waitNarrationMessage('rating', { budgetMs: 30_000 })).toBe(
        'Still working: rating this command (up to 30s)'
      );
    });

    it('omits the budget rather than printing a nonsense one', async () => {
      const { waitNarrationMessage } = await import('#src/core/waitNarration.js');

      for (const budgetMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(waitNarrationMessage('rating', { budgetMs })).toBe(
          'Still working: rating this command'
        );
      }
    });

    /**
     * The status bar's own label for the model answering a turn is `Thinking…`, and the PTY suite
     * counts rows carrying that word to prove the reasoning panels. A label reusing it would be
     * indistinguishable from a thought at the terminal AND would red that suite, so the absence is
     * asserted rather than left to whoever writes the next activity.
     */
    it('never uses the word the model-thinking label owns', async () => {
      const { GTH_WAIT_ACTIVITIES, waitNarrationMessage } =
        await import('#src/core/waitNarration.js');

      for (const activity of GTH_WAIT_ACTIVITIES) {
        expect(waitNarrationMessage(activity).toLowerCase()).not.toContain('thinking');
      }
    });
  });

  describe('readWaitNarration', () => {
    it('recognises its own message and returns it whole', async () => {
      const { readWaitNarration, waitNarrationMessage } =
        await import('#src/core/waitNarration.js');
      const message = waitNarrationMessage('rating', { budgetMs: 30_000 });

      expect(readWaitNarration(message)).toBe(message);
    });

    it('declines ordinary status chatter, including a message that merely mentions the words', async () => {
      const { readWaitNarration } = await import('#src/core/waitNarration.js');

      expect(readWaitNarration('Loaded tools')).toBeNull();
      expect(readWaitNarration('')).toBeNull();
      // The prefix has to OPEN the message: a warning quoting a narration is not a narration, and
      // routing it to the status bar would silently swallow a warning the transcript must keep.
      expect(readWaitNarration('Rater warning: Still working: rating this command')).toBeNull();
    });
  });

  describe('narrateWait', () => {
    it('says nothing at all when the work settles inside the threshold', async () => {
      const { narrateWait, WAIT_NARRATION_THRESHOLD_MS } =
        await import('#src/core/waitNarration.js');
      const emit = vi.fn();

      const done = narrateWait('rating', emit, async () => 'verdict');
      await vi.advanceTimersByTimeAsync(WAIT_NARRATION_THRESHOLD_MS * 3);

      await expect(done).resolves.toBe('verdict');
      expect(emit).not.toHaveBeenCalled();
    });

    /**
     * The node's acceptance, in one cell: past the threshold, **exactly one** signal, naming what
     * is being awaited. The count is asserted after advancing well past the threshold, because
     * "one so far" and "one ever" are different claims and only the second is the property.
     */
    it('emits exactly one signal, naming the wait, once the threshold passes', async () => {
      const { narrateWait, WAIT_NARRATION_THRESHOLD_MS, WAIT_NARRATION_LEVEL } =
        await import('#src/core/waitNarration.js');
      const emit = vi.fn();
      let release!: (value: string) => void;

      const done = narrateWait(
        'rating',
        emit,
        () => new Promise<string>((resolve) => (release = resolve)),
        { budgetMs: 30_000 }
      );

      await vi.advanceTimersByTimeAsync(WAIT_NARRATION_THRESHOLD_MS - 1);
      expect(emit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(
        WAIT_NARRATION_LEVEL,
        'Still working: rating this command (up to 30s)'
      );
      expect(WAIT_NARRATION_LEVEL).toBe(StatusLevel.INFO);

      // Held open far longer than the threshold: still one. The signal is not a ticker.
      await vi.advanceTimersByTimeAsync(WAIT_NARRATION_THRESHOLD_MS * 50);
      expect(emit).toHaveBeenCalledTimes(1);

      release('verdict');
      await expect(done).resolves.toBe('verdict');
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('disarms on a rejection, so a failed wait never narrates after the fact', async () => {
      const { narrateWait, WAIT_NARRATION_THRESHOLD_MS } =
        await import('#src/core/waitNarration.js');
      const emit = vi.fn();

      const done = narrateWait('rating', emit, async () => {
        throw new Error('provider refused');
      });

      await expect(done).rejects.toThrow('provider refused');
      await vi.advanceTimersByTimeAsync(WAIT_NARRATION_THRESHOLD_MS * 3);
      expect(emit).not.toHaveBeenCalled();
    });

    /**
     * Commentary is never allowed to be the thing that fails the operation it was describing —
     * a surface whose status callback throws must still get its verdict.
     */
    it('survives a surface whose status callback throws', async () => {
      const { narrateWait, WAIT_NARRATION_THRESHOLD_MS } =
        await import('#src/core/waitNarration.js');
      const emit = vi.fn(() => {
        throw new Error('no status sink');
      });
      let release!: (value: string) => void;

      const done = narrateWait(
        'rating',
        emit,
        () => new Promise<string>((resolve) => (release = resolve))
      );
      await vi.advanceTimersByTimeAsync(WAIT_NARRATION_THRESHOLD_MS + 1);
      release('verdict');

      await expect(done).resolves.toBe('verdict');
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('honours an explicit threshold over the default', async () => {
      const { narrateWait } = await import('#src/core/waitNarration.js');
      const emit = vi.fn();
      let release!: (value: string) => void;

      const done = narrateWait(
        'rating',
        emit,
        () => new Promise<string>((resolve) => (release = resolve)),
        { thresholdMs: 10 }
      );

      await vi.advanceTimersByTimeAsync(11);
      expect(emit).toHaveBeenCalledTimes(1);

      release('verdict');
      await done;
    });
  });
});
