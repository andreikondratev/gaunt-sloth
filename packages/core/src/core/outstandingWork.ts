/**
 * @packageDocumentation
 * [[EXT-158]] — the turn ended cleanly and the checklist still had work on it. Say so; do nothing.
 *
 * A model that stops mid-task produces a turn that is, at every input a runtime can see,
 * indistinguishable from one that finished: text, no tool calls, no error. The only marker this
 * failure ever had in a transcript was a human typing *"continue"*. This module gives it a
 * machine-readable one — the newest `gth_checklist` call still carrying a `pending` or
 * `in_progress` item at the moment a turn ends — and turns it into a sentence the user reads.
 *
 * ## IT REPORTS. IT NEVER ACTS. (Andrew, 2026-09-16 — "remove nudge and file a new node.")
 *
 * **Nothing here may re-invoke the model**, at any budget, opt-in or otherwise: no
 * `jumpTo: 'model_request'`, no injected `HumanMessage`, no retry. That is not a simplification of
 * a nudge, it is the ruling. The apparatus a nudge needs — a per-episode budget, an error
 * classification that keeps it off a rate-limited turn, a message that would commit to the
 * transcript as an ordinary user turn and destroy the *"continue"* marker retroactively — exists to
 * contain re-invocation, and none of it applies to a sentence rendered to a human. A future reader
 * adding "just a small nudge, opt-in" here is re-opening a decision that was made against the
 * evidence, not filling a gap.
 *
 * ## WHY THIS IS A SEPARATE PATH FROM `terminationNotice.ts`, and not a category in it
 *
 * The neighbouring module says *why a run ended*, keyed on {@link GthTerminationReason} — a closed
 * taxonomy of causes, each classified by a site that watched the run stop. This is a different kind
 * of fact: it is about the **message history**, not about the ending, and it is true or false
 * independently of what ended the turn. Folding it in would mean either inventing a 23rd category
 * for a state that is not a cause (and that every posture consumer would then have to answer for),
 * or hanging a history-derived field off a value whose whole contract is that it was committed by
 * the site that saw the failure. So: one module beside the other, and the two are composed at each
 * surface rather than merged.
 *
 * They do compose in one direction, and {@link shouldAnnounceOutstandingWork} is where:
 * **this speaks only for the `completed` stop.** Every other category is already announced by
 * `shouldAnnounceTermination`, and a turn the provider rate-limited is not a turn that stopped with
 * work outstanding — it is a turn that was refused, which EXT-159 already says in its own words.
 *
 * ## A SECOND CONSUMER IS EXPECTED
 *
 * [[EXT-178]] will render an end-of-turn recap on the same `completed` stop. It is not built and
 * nothing here is built toward it — but {@link detectOutstandingWork} is a pure function of a
 * message list, deliberately callable with no runner, no agent and no surface, so a second consumer
 * can ask the same question without going through this module's notice. Whether the two end up as
 * one sentence or two surfaces is an open question recorded on both nodes.
 *
 * ## THE BOUND, AND IT IS NOT A DEFECT
 *
 * **The checklist is optional.** `gth_checklist`'s own description tells the model to *"skip it for
 * a single trivial step"*, so this can only ever claim stops **where a checklist exists and has
 * non-completed items**. A stop with no checklist is silent here, by construction and for ever.
 */

import type { BaseMessage } from '@langchain/core/messages';
import type { GthTerminationReason } from '#src/core/terminationReason.js';
import { displayNotice } from '#src/utils/consoleUtils.js';
import { debugLog } from '#src/utils/debugUtils.js';

/**
 * The tool name the lean agent uses to record its checklist. Matches
 * `packages/agent/src/tools/gthChecklistTool.ts`.
 *
 * Kept as a local literal rather than imported, exactly as `app/src/tui/viewModel.ts` keeps its
 * own: `core` cannot import `agent` (the dependency runs the other way), and the *name* is the
 * stable half of the contract anyway. A rename would have to move all three, which is what
 * [[rename-token-grep-whole-repo]] is about.
 */
export const CHECKLIST_TOOL_NAME = 'gth_checklist';

/** One checklist item's status, mirroring `ChecklistStatus` in the tool. */
export type ChecklistItemStatus = 'pending' | 'in_progress' | 'completed';

/** One item of a checklist, as the model's own tool-call arguments carried it. */
export interface ChecklistSnapshotItem {
  content: string;
  status: ChecklistItemStatus;
}

/**
 * A checklist that still had work on it when the turn ended.
 *
 * Counts, not prose. {@link outstandingWorkNotice} renders these and never the item text — see
 * that function for why.
 */
export interface GthOutstandingWork {
  /** How many items were neither `completed` nor absent: `pending` + `in_progress`. */
  outstanding: number;
  /** How many items were `completed`. */
  completed: number;
  /** How many items the newest checklist call carried in total. */
  total: number;
  /** How many of {@link outstanding} were `in_progress` (at most one — the tool enforces it). */
  inProgress: number;
  /**
   * The structural identity of this stalled state: every item's status and content, in order.
   *
   * **This is what makes "do not fire again for the same stalled state" mean what it says.** A
   * stuck model re-emits `gth_checklist` with identical items, so anything derived from a call
   * count, a timestamp or a message index treats non-progress as progress and the notice becomes
   * the banner nobody reads. A signature over the items themselves changes only when the checklist
   * does — which is [[EXT-36]]'s definition of progress, reused rather than reinvented.
   */
  signature: string;
  /**
   * True when this exact signature has already been announced on this agent instance, so the
   * surface should stay quiet.
   *
   * Computed where the fact is recorded (the agent holds the last-announced signature, because the
   * agent is what lives across the turns of one session) rather than at each surface, so six
   * surfaces cannot come to disagree about what "again" means.
   */
  repeat: boolean;
}

/**
 * How many times one unchanged stalled state may be announced.
 *
 * A named constant because scope (3) asks for one and because the alternative — the number `1`
 * inlined in a comparison — is a threshold nobody can find. Raising it must move behaviour, and
 * `outstandingWork.spec.ts` asserts exactly that, so this cannot be quietly widened into the
 * repeating banner the node forbids.
 */
export const OUTSTANDING_WORK_NOTICE_MAX_PER_SIGNATURE = 1;

/**
 * The opening of the notice title, exported for the same reason
 * `TERMINATION_NOTICE_TITLE_PREFIX` is: two surfaces put this into a channel that also carries
 * other messages, and a consumer keying on a copy of the string finds out too late that the two
 * have drifted.
 */
export const OUTSTANDING_WORK_NOTICE_TITLE_PREFIX = 'Checklist not finished: ';

/**
 * The sentence that marks the notice as the runtime's own.
 *
 * **§(3) of the node, and it is load-bearing.** The one reliable way to find this failure in a
 * transcript is a human typing *"continue"*; anything the product emits that could be mistaken for
 * the user's own words destroys that marker retroactively, across every future report. This notice
 * never enters the message history at all — but it does land in the session log and in
 * `/debug-dump`, so it says what it is in words, once, in every place it is carried.
 */
export const OUTSTANDING_WORK_AUTOMATED_MARKER =
  'Automated observation from the gth runtime — not a message from the user or the model.';

/** Read a property off an unknown value without asserting anything about its shape. */
function field(source: unknown, key: string): unknown {
  if (!source || (typeof source !== 'object' && typeof source !== 'function')) return undefined;
  return (source as Record<string, unknown>)[key];
}

/**
 * The LangChain message-type token, duck-typed.
 *
 * `getType()` with an `_getType()` fallback, the idiom `core/runStats.ts` already uses, rather
 * than `AIMessage.isInstance` or `instanceof`. A dependency major can split `@langchain/core` into
 * two copies in one process, and a class predicate then answers `false` for a message that is an
 * `AIMessage` in every sense that matters here ([[dep-major-can-split-a-singleton]]). The token is
 * a string on the message itself and survives that.
 */
function messageType(message: unknown): string | undefined {
  const get = field(message, 'getType');
  if (typeof get === 'function') {
    const type: unknown = (get as () => unknown).call(message);
    if (typeof type === 'string') return type;
  }
  const legacy = field(message, '_getType');
  if (typeof legacy === 'function') {
    const type: unknown = (legacy as () => unknown).call(message);
    if (typeof type === 'string') return type;
  }
  return undefined;
}

/** The `tool_calls` array on a message, or an empty list for anything carrying none. */
function toolCallsOf(message: unknown): unknown[] {
  const calls = field(message, 'tool_calls');
  return Array.isArray(calls) ? calls : [];
}

/**
 * Parse one `gth_checklist` tool call's **arguments** into items, or `null` when it carries none.
 *
 * **The args are the contract; the observation is not.** `formatChecklist` renders the list into
 * markdown prose that the model reads back, and that prose is free to change wording at any time —
 * a reader keyed on it is keyed on a display string. The args are the tool's declared zod schema,
 * which is the thing a caller may rely on.
 *
 * Structural and defensive at every step: an arg object from the wire may be anything at all, and
 * a malformed one must yield "no checklist" rather than a throw on the path that explains a stop.
 * A status outside the three literals is not coerced — the item is dropped, because a checklist
 * whose statuses we guessed at is worse evidence than no checklist.
 */
export function parseChecklistToolArgs(args: unknown): ChecklistSnapshotItem[] | null {
  const items = field(args, 'items');
  if (!Array.isArray(items)) return null;
  const rows: ChecklistSnapshotItem[] = [];
  for (const raw of items) {
    const content = field(raw, 'content');
    const status = field(raw, 'status');
    if (
      typeof content === 'string' &&
      (status === 'pending' || status === 'in_progress' || status === 'completed')
    ) {
      rows.push({ content, status });
    }
  }
  return rows.length > 0 ? rows : null;
}

/**
 * The newest parseable `gth_checklist` call in a message list, or `null`.
 *
 * Walks backwards and stops at the first one, because the tool is whole-list-replace: the newest
 * call IS the checklist, and an older one is a superseded state rather than more information.
 */
export function latestChecklistInMessages(
  messages: readonly BaseMessage[] | undefined
): ChecklistSnapshotItem[] | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const call of toolCallsOf(messages[i])) {
      if (field(call, 'name') !== CHECKLIST_TOOL_NAME) continue;
      const items = parseChecklistToolArgs(field(call, 'args'));
      if (items) return items;
    }
  }
  return null;
}

/**
 * Did this turn end with no tool calls?
 *
 * The last message being an AI message that requested nothing is what "the turn ended" looks like
 * in the graph's own state: had it requested a tool, the tool node would have run and a
 * `ToolMessage` would sit after it. A history ending in a `ToolMessage` is a turn that stopped
 * somewhere else — mid-drain, on an abort, on a suspend — and those are terminations with their own
 * categories and their own notices, not this one.
 */
function endedWithoutToolCalls(messages: readonly BaseMessage[] | undefined): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  return messageType(last) === 'ai' && toolCallsOf(last).length === 0;
}

/** The structural identity of a checklist state — every status and content, in order. */
function signatureOf(items: readonly ChecklistSnapshotItem[]): string {
  return items.map((item) => `${item.status} ${item.content}`).join('');
}

/**
 * **The detector.** A turn that ended with no tool calls while the newest `gth_checklist` call
 * still carried a `pending` or `in_progress` item; `null` for anything else.
 *
 * A pure function of the message list — no runner, no agent, no surface, no I/O — so it is unit
 * testable on its own and callable by the second consumer [[EXT-178]] will bring.
 *
 * `repeat` is left `false` here: whether this state has been announced before is a property of the
 * session, which a pure function of one message list cannot know. The agent fills it in.
 */
export function detectOutstandingWork(
  messages: readonly BaseMessage[] | undefined
): GthOutstandingWork | null {
  if (!endedWithoutToolCalls(messages)) return null;
  const items = latestChecklistInMessages(messages);
  if (!items) return null;
  const outstanding = items.filter((item) => item.status !== 'completed');
  if (outstanding.length === 0) return null;
  return {
    outstanding: outstanding.length,
    completed: items.length - outstanding.length,
    total: items.length,
    inProgress: outstanding.filter((item) => item.status === 'in_progress').length,
    signature: signatureOf(items),
    repeat: false,
  };
}

/** A rendered outstanding-work notice: a title and the body lines under it. */
export interface GthOutstandingWorkNotice {
  /** **The carrier.** The fact travels as this value; the strings are derived from it. */
  work: GthOutstandingWork;
  title: string;
  lines: string[];
}

/**
 * Render the fact for a surface that shows a title and body lines.
 *
 * ## COUNTS ONLY — the item text is never rendered here
 *
 * Checklist `content` is **model-authored text on its way to a terminal**, which is why the TUI's
 * own reader runs it through `neutralizeUntrustedText` before it reaches a panel. Rendering counts
 * sidesteps that class entirely rather than depending on a neutraliser staying correct, and it also
 * keeps the notice to three short lines — which is the other half of scope (3): a notice long
 * enough to skim past is a notice nobody reads. A consumer that wants the items has
 * {@link detectOutstandingWork} and must neutralise them itself.
 *
 * ## IT STATES THE OBSERVATION, NEVER THE CONCLUSION
 *
 * "The checklist still lists N items as not completed" is a fact. "The agent stopped early" is a
 * diagnosis, and it is one nobody can currently support: how often a turn **legitimately** ends
 * with items outstanding — a model finishing a sub-step and handing back — is the number [[BATCH-5]]
 * owns and nobody has taken. [[GS2-80]] is the standing proof that it is not near zero. Wording
 * this as a verdict would turn every legitimate hand-back into an apparent defect, which is a worse
 * failure than the silence it replaces.
 */
export function outstandingWorkNotice(work: GthOutstandingWork): GthOutstandingWorkNotice {
  const plural = work.outstanding === 1 ? 'item' : 'items';
  return {
    work,
    title: `${OUTSTANDING_WORK_NOTICE_TITLE_PREFIX}${work.outstanding} of ${work.total} ${plural} not marked completed`,
    lines: [
      `The turn ended without further tool calls while ${work.completed} of ${work.total} checklist items were marked completed` +
        (work.inProgress > 0 ? ' and one was still in progress.' : '.'),
      'If there is more to do, ask the agent to continue; if the work is finished, the checklist was simply not updated.',
      OUTSTANDING_WORK_AUTOMATED_MARKER,
    ],
  };
}

/**
 * Is this fact worth telling the person watching?
 *
 * **Gated positively on `completed`, and the positive form is the point.** Writing this as
 * "any category `shouldAnnounceTermination` declines" would read as the natural complement and
 * would be a defect: that function also declines `suspended`, which is a run parked on a
 * tool-approval interrupt — with its checklist outstanding *by construction*, since the work is
 * mid-flight. Every gated tool call would draw this notice. Matching `completed` excludes it for
 * free, and excludes anything a later category adds for the same reason.
 *
 * Every other ending is already announced in its own words by `displayTermination`, and none of
 * them is "stopped with work outstanding": a `rate_limited` turn was refused, a `provider_error`
 * turn faulted, a `cancelled` turn was stopped by the user. Adding a second sentence about the
 * checklist to any of those is two things speaking about one stop, which is the failure this node
 * and [[EXT-178]] are both trying to avoid.
 *
 * A `null` reason is **not** treated as `completed`. The taxonomy's contract is that an absent
 * reason means a site nobody classified, and inferring an ordinary completion from it would spend
 * that signal on a guess.
 */
export function shouldAnnounceOutstandingWork(
  work: GthOutstandingWork | null | undefined,
  reason: GthTerminationReason | null | undefined
): boolean {
  if (!work || work.repeat) return false;
  return reason?.category === 'completed';
}

/** One line for the debug log, stating the fact and that it is the runtime's own. */
export function outstandingWorkLogLine(work: GthOutstandingWork): string {
  return (
    `EXT-158 outstanding-work: outstanding=${work.outstanding} completed=${work.completed} ` +
    `total=${work.total} inProgress=${work.inProgress} repeat=${work.repeat} (automated)`
  );
}

/**
 * Say it on a console surface (the readline session and the non-interactive verbs), and write the
 * same fact to the debug log either way.
 *
 * Returns whether anything was shown, so a caller can tell "said nothing because the turn had
 * nothing outstanding" from "said nothing because this state was already announced".
 *
 * `tone: 'warn'` with the default gate rather than `displayTermination`'s `gate: 'always'`, and
 * deliberately: that notice carries the reason code a user quotes in a bug report and has nowhere
 * else to find it, while this one is an observation about a run the user can see. A surface turned
 * down to errors-only asked for less output, and this is output it may have.
 *
 * Fail-soft in the strongest sense: reporting a stop must never become a second one.
 */
export function displayOutstandingWork(
  work: GthOutstandingWork | null | undefined,
  reason: GthTerminationReason | null | undefined
): boolean {
  try {
    if (!work) return false;
    debugLog(outstandingWorkLogLine(work));
    if (!shouldAnnounceOutstandingWork(work, reason)) return false;
    const notice = outstandingWorkNotice(work);
    displayNotice(notice.title, notice.lines, { tone: 'warn' });
    return true;
  } catch {
    return false;
  }
}
