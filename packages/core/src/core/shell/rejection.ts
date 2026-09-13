/**
 * @module core/shell/rejection
 *
 * EXT-58 (spec §7) — **what the model is told when a gated tool call is refused.**
 *
 * A rejection returned to the model MUST name the moves available to it, not merely the refusal.
 * The pre-EXT-58 message was the bare string *"User rejected the shell command."*, which tells the
 * model it failed and nothing about what to do instead — so it either re-runs the identical call or
 * abandons a legitimate task silently. §7 fixes both ends: state the refusal, carry the explanation
 * when one exists, and name the moves it has (re-call with a justification, call a different
 * command) — see {@link REJECTION_MOVES} for why that list names nothing else.
 *
 * What this module deliberately does NOT do:
 *
 * - It does not decide anything. It renders a refusal that has already been decided elsewhere, and
 *   it never offers the model a different tool to call instead: steering a model off the shell is
 *   not a contest the gate wins, so the message names the moves and stops there.
 * - It does not serve a **halt** (§4.2). A halt is not a rejection and offers the model no moves,
 *   so it is an error (`AttackHaltError`) rather than a message — see `approvalStop.ts`.
 * - It does not serve a **deny-list** refusal. A deny entry is the user's own hardline, and
 *   "re-call the same command with a justification" is not a move the model has there; that message
 *   stays as it is, in `GthAgentRunner.decideToolApproval`.
 * - It does not serve a command the gate's parser could not READ. There is no such refusal:
 *   [[EXT-81]] rates that command instead of refusing it, so every rejection this module renders is
 *   a JUDGED one and "call the same command with a justification" is always a move the model has.
 */
import type { ShellSafetyVerdict } from '#src/core/shell/rater.js';

/** Who refused the call — the opening sentence and the moves both follow from this. */
export type RejectionSource =
  /** The human answered "no" at the escalation prompt (§6). */
  | 'user'
  /** The auto-rater refused during a negotiation (§5 / [[EXT-29]]). */
  | 'rater';

/**
 * The moves §7 requires a JUDGED rejection to name — and **only moves the model actually has.**
 *
 * [[EXT-106]] §5 — *"ask the user if there is no way around it"* was not one of them. It named no
 * mechanism, so the model did the only thing the sentence could mean: it wrote prose asking for a
 * confirmation and ended the turn. That text never reaches the gate. The confirmation cannot arrive,
 * the next call meets the identical deterministic floor, and the run ends having handed the user
 * homework that cannot be done — while the two remedies that would have worked (an `approvals.allow`
 * entry, or a different rung) went unnamed.
 *
 * **Removing it costs the model nothing it could use.** Where these two moves genuinely run out, §5.3
 * spends the negotiation bound and the call goes to a person through the gate — which is the
 * escalation the removed sentence was pantomiming. Do not restore it, in this or any other wording,
 * until there is a TOOL that escalates: the fault was never the phrasing, it was offering an exit
 * with nothing behind it.
 */
export const REJECTION_MOVES =
  'You may call the same command with a justification, or call a different command.';

/** Inputs to {@link buildRejectionMessage}. */
export interface RejectionMessageOptions {
  /** Who refused. */
  source: RejectionSource;
  /** The tool that was refused; defaults to a generic phrasing when absent. */
  toolName?: string;
  /**
   * The rating that accompanied the escalation, when one exists. Carries the explanation the model
   * is owed. Absent at the unrated rungs (`manual`, `write`), where there is no rating at all and
   * the descriptions of §4.5 are the only mechanism in play.
   */
  verdict?: ShellSafetyVerdict;
}

/**
 * Build the rejection message handed back to the model as the refused call's tool result.
 *
 * §7 shape, each part omitted when it does not apply:
 * 1. who refused what;
 * 2. the rater's explanation, when a rating exists;
 * 3. the moves — always.
 */
export function buildRejectionMessage(options: RejectionMessageOptions): string {
  const target = options.toolName ? `your call to ${options.toolName}` : 'your command';
  const opener =
    options.source === 'rater'
      ? `The auto-rater rejected ${target}.`
      : `The user rejected ${target}.`;

  const parts: string[] = [opener];
  const reason = options.verdict?.reason?.trim();
  if (reason) {
    parts.push(`Explanation: ${reason}`);
  }
  parts.push(REJECTION_MOVES);
  return parts.join(' ');
}
