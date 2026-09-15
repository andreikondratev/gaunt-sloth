/**
 * @packageDocumentation
 * [[EXT-92]] scope (a) — **a wait that lasts long enough to be noticed says what it is waiting on.**
 *
 * ## What already narrates a wait, and why this is not a fourth renderer
 *
 * Three renderers already speak during a wait, and each of them stays exactly as it is:
 *
 * - the Ink status bar's spinner row (`app/tui/components/StatusBar.tsx`), one line in the pinned
 *   dock that reads `Thinking… (Esc to interrupt)` for the whole time a turn is running;
 * - `utils/ProgressIndicator.ts`, the plain surface's per-second dots, constructed around the
 *   non-streaming model call in `runtime/singleShot.ts`, `runtime/conversation.ts` and
 *   `core/GthAbstractAgent.ts`;
 * - the `statusUpdate` channel itself, which already emits `Thinking...` at
 *   {@link StatusLevel.INFO} from `GthAbstractAgent`'s streaming path.
 *
 * Between them the **model call** is narrated on every surface, so this module adds nothing there.
 * What none of them covers is a wait that is *not* the model answering the turn — and the one this
 * node measured is the rating call, which holds the turn for up to
 * `RATER_DEFAULT_TIMEOUT_MS` (30s, `core/shell/rater.ts`) while the TUI's spinner says `Thinking…` and the plain
 * surface says nothing whatever. The TUI case is worse than silence: the existing renderer is
 * actively **mislabelling** the wait as the model thinking, so a user watching a rated `auto`
 * session sees the product report the wrong activity for half a minute and then, on a timeout,
 * a warning about a rater they were never told had been consulted.
 *
 * So the fix is a **label for a renderer that already exists**, not a new place to draw. The signal
 * travels on the existing `statusUpdate` channel and lands in the two places that already own a
 * wait: `displayInfo` on the plain surfaces, and the status bar's own spinner row on the TUI, which
 * swaps its hardcoded text for this one while the activity is live. The TUI costs **zero new rows**,
 * which is most of the answer to the node's own constraint below.
 *
 * ## Why it cannot become a banner people learn to ignore
 *
 * The node forbids "a per-call banner people learn to ignore", and the three properties that keep
 * this from being one are structural rather than a matter of taste:
 *
 * 1. **It is emitted only after a real wait crosses {@link WAIT_NARRATION_THRESHOLD_MS}.** A wait
 *    that resolves quickly emits nothing at all, so the signal is evidence that something is
 *    actually taking time rather than decoration attached to an event.
 * 2. **Exactly one per wait episode.** {@link narrateWait} arms a single timer and disarms it on
 *    settle; it never repeats, never counts up and never re-fires for the same await. This is
 *    [[EXT-158]]'s bounded-count property arrived at from the other direction — there is no count
 *    to bound because there is no second emission.
 * 3. **On the TUI it replaces a row rather than adding one**, and the row it replaces was saying
 *    something false.
 *
 * ## Why there is no config rung, unlike [[EXT-178]]
 *
 * The recap took one because a recap **spends a model call**: the user's tokens, the user's money,
 * on every turn, which is a cost nobody consented to. A progress signal spends nothing — no model
 * call, no network, one string on a channel that is already open — and its failure direction is
 * benign: at worst a user sees one line they did not need, recoverable by not reading it. A rung
 * here would be a config key whose `off` position buys back nothing, and the in-repo precedent
 * agrees: neither the spinner nor `ProgressIndicator` has ever had one. The decision is
 * copied from neither; it is made on what the feature costs.
 */

import { StatusLevel } from '#src/core/types.js';

/**
 * How long a wait may last before it has to say what it is.
 *
 * **One second, which is the node's own "beyond about a second", and the argument for it is that
 * the threshold is protecting against the wrong failure if it is any longer.** The number is not
 * trying to find the point where a human notices a delay — people notice well under a second — it
 * is trying to separate *an operation that happened* from *an operation that is holding the turn*.
 * A rating that answers in 300ms is part of the command running and needs no commentary; one that
 * has not answered in a second is going to be seen as a stall, and on the measured evidence it may
 * hold the screen for another twenty-nine.
 *
 * **It is deliberately well below the cost of being wrong in either direction.** Too low and a
 * fast rating narrates itself for no reason — one extra line, the cheapest error available. Too
 * high and the module fails at the only case it was built for, because a threshold picked to
 * suppress chatter would have to sit at several seconds, and several seconds of silence on a
 * thirty-second budget is most of the defect still present. Given an asymmetry that steep the
 * number belongs at the low end, and the node's own wording puts it there.
 */
export const WAIT_NARRATION_THRESHOLD_MS = 1_000;

/**
 * The opening of every narration this module produces.
 *
 * Exported for the reason `RUN_RECAP_TITLE_PREFIX` and `OUTSTANDING_WORK_NOTICE_TITLE_PREFIX` are:
 * the message travels on `statusUpdate`, a channel that also carries ordinary chatter, and the TUI
 * has to pick these out of it to route them to the status bar rather than into the transcript. A
 * consumer keying on its own copy of the string finds out too late that the two have drifted.
 *
 * The words are chosen to be true on their own. A reader who sees the line with no idea what this
 * module is still learns the two things that matter: the run has not died, and here is what is
 * holding it.
 */
export const WAIT_NARRATION_PREFIX = 'Still working: ';

/** Every wait this module knows how to name. */
export const GTH_WAIT_ACTIVITIES = ['rating'] as const;

/** One of {@link GTH_WAIT_ACTIVITIES}. */
export type GthWaitActivity = (typeof GTH_WAIT_ACTIVITIES)[number];

/**
 * What each activity is called on screen.
 *
 * Phrased as the continuation of {@link WAIT_NARRATION_PREFIX} so the assembled line is one
 * sentence, and kept free of the word "thinking" on purpose: that word is the status bar's label
 * for the model answering the turn, and the whole point of this activity is that it is **not** that.
 */
const WAIT_ACTIVITY_LABEL: Record<GthWaitActivity, string> = {
  rating: 'rating this command',
};

/** The bare label for `activity`, without the prefix or any budget. */
export function waitActivityLabel(activity: GthWaitActivity): string {
  return WAIT_ACTIVITY_LABEL[activity];
}

/**
 * The line a surface shows for `activity`.
 *
 * `budgetMs`, when the caller knows one, is rendered as `(up to Ns)` — and it is the half that
 * answers the report this node was filed from. A person who is told only that the runtime is busy
 * still does not know whether to wait or to kill the session; a person told the wait is bounded at
 * thirty seconds knows exactly how long "stuck" would have to last before it is really stuck.
 * Rounded to whole seconds because a millisecond figure invites the reader to time it.
 */
export function waitNarrationMessage(
  activity: GthWaitActivity,
  options: { budgetMs?: number } = {}
): string {
  const label = waitActivityLabel(activity);
  const budget =
    typeof options.budgetMs === 'number' &&
    Number.isFinite(options.budgetMs) &&
    options.budgetMs > 0
      ? ` (up to ${Math.round(options.budgetMs / 1000)}s)`
      : '';
  return `${WAIT_NARRATION_PREFIX}${label}${budget}`;
}

/**
 * The narration carried by `message`, or `null` when it is ordinary status chatter.
 *
 * The TUI's status callback uses this to decide routing, so it is a **prefix test and nothing
 * more** — no attempt to parse the activity back out of the text. Reversing the rendering would
 * give the surface a second model of the wording, and the first thing that model does is drift.
 * What comes back is the sentence to display, which is all the status bar needs.
 */
export function readWaitNarration(message: string): string | null {
  return message.startsWith(WAIT_NARRATION_PREFIX) ? message : null;
}

/** The level a narration is emitted at; see {@link narrateWait}. */
export const WAIT_NARRATION_LEVEL = StatusLevel.INFO;

/**
 * Run `work`, and if it has not settled within the threshold, say once what is being waited on.
 *
 * `emit` is the surface's status callback, so the signal reaches whatever that surface already
 * does with an {@link StatusLevel.INFO} line — `displayInfo` on the plain surfaces, and on the
 * Ink TUI the status-bar routing described in this module's header.
 *
 * **The timer is armed before `work` is called and disarmed in `finally`**, so the three ways a
 * wait can end — resolve, reject, and the caller's own timeout racing it — all disarm it, and a
 * rejected wait cannot leave a live handle behind holding the process open. An emit that throws is
 * swallowed: narrating a wait is commentary, and commentary is never allowed to be the thing that
 * fails the operation it was describing.
 */
export async function narrateWait<T>(
  activity: GthWaitActivity,
  emit: (level: StatusLevel, message: string) => void,
  work: () => Promise<T>,
  options: { budgetMs?: number; thresholdMs?: number } = {}
): Promise<T> {
  const thresholdMs = options.thresholdMs ?? WAIT_NARRATION_THRESHOLD_MS;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    try {
      emit(WAIT_NARRATION_LEVEL, waitNarrationMessage(activity, { budgetMs: options.budgetMs }));
    } catch {
      // A surface that cannot take a status line is not a reason to fail the rating.
    }
  }, thresholdMs);
  try {
    return await work();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
}
