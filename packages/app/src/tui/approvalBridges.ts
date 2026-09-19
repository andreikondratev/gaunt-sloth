/**
 * The two promise-based fan-outs between the runner's human-in-the-loop seams and the mounted Ink
 * `<App>`: the tool-approval prompt, and [[TUI-C68]]'s attack banner.
 *
 * ## Why they live in a module of their own
 *
 * [[EXT-110]] — because `abortPending` is the part of a session nobody can reach from a test while
 * it sits inside `tuiSessionModule`. That module pulls in Ink, `initConfig`, the runner, the
 * history store and the mouse plumbing, so a spec for the teardown answer has to mock a session in
 * order to ask a question about eighty lines of plain TypeScript — and the one spec that tried
 * instead kept a COPY of this bridge beside it and asserted against that. A copy passes whatever
 * the original does, which is exactly how a teardown came to be archived as a human refusal with a
 * green suite either side of it. These are the objects production wires; the specs import them
 * from here.
 *
 * @module
 */
import type {
  ApprovalOutcome,
  PendingAttackHalt,
  PendingToolInterrupt,
  ToolApprovalReply,
  AttackHaltReply,
} from '@gaunt-sloth/core/core/types.js';
import type { PendingApproval, PendingAttackBanner } from '#src/tui/types.js';

/**
 * Fan-out so the runner's tool-approval callback can reach the mounted React app. Modeled on
 * `createStatusBridge`, but promise-based: when the runner suspends on a
 * `run_shell_command` interrupt and calls the approval callback, the bridge creates a pending
 * record (the {@link @gaunt-sloth/core!core/types.PendingToolInterrupt | PendingToolInterrupt} plus a `resolve`), emits it to the subscribed
 * `<App>`, and hands the callback a Promise it awaits until the app resolves a decision.
 *
 * Fail-closed: if the session ends / the app unmounts while an approval is still pending, every
 * outstanding record is answered by `abortPending`, so a suspended run can never hang — and the
 * tool does not run, matching the readline path's "anything not o/s/a → reject" default.
 *
 * [[EXT-150]] — **and the answer comes back the other way.** The runner reports what a decision
 * LANDED as only after the callback above has returned (the write is attempted then), so the
 * decision promise cannot carry it. `report` is wired to `runner.setApprovalOutcomeCallback` and
 * settles a second promise per request, which is what `resolve` hands the App. The two are paired by
 * the `pending` object's identity rather than by arrival order: this bridge holds a SET of
 * outstanding records and the App a queue, so ordering is not a property either of them keeps, and a
 * mis-paired outcome would confirm one call's persistence on another call's dialog.
 */
export function createApprovalBridge() {
  const listeners = new Set<(record: PendingApproval) => void>();
  // Records that have been emitted but not yet resolved (used by abortPending on teardown).
  const outstanding = new Set<PendingApproval>();
  // [[EXT-150]] — how to settle the outcome promise of a request still waiting to hear one, keyed by
  // the interrupt the runner will name. Cleared as each is settled, so nothing accumulates.
  const awaitingOutcome = new Map<
    PendingToolInterrupt,
    (outcome: ApprovalOutcome | null) => void
  >();
  return {
    /** Wired to `runner.setToolApprovalCallback`: returns a Promise the runner awaits. */
    request: (pending: PendingToolInterrupt): Promise<ToolApprovalReply> =>
      new Promise<ToolApprovalReply>((resolve) => {
        let settled = false;
        // Created before the record so `resolve` can hand it back; the executor runs synchronously,
        // so `settleOutcome` is the real resolver by the time anything can call it.
        let settleOutcome: (outcome: ApprovalOutcome | null) => void = () => {};
        const outcome = new Promise<ApprovalOutcome | null>((settleIt) => {
          settleOutcome = settleIt;
        });
        awaitingOutcome.set(pending, (reported) => {
          awaitingOutcome.delete(pending);
          settleOutcome(reported);
        });
        const record: PendingApproval = {
          pending,
          resolve: (reply) => {
            if (!settled) {
              settled = true;
              outstanding.delete(record);
              resolve(reply);
            }
            // The same promise on every call, so the idempotent second `resolve` of a race is still
            // told the outcome rather than handed one that can never settle.
            return outcome;
          },
        };
        outstanding.add(record);
        for (const l of listeners) l(record);
      }),
    /**
     * [[EXT-150]] — wired to `runner.setApprovalOutcomeCallback`: hand the waiting request what its
     * answer actually landed as. An outcome for a request nobody is waiting on (teardown got there
     * first) is dropped, which is why the map entry is removed as it settles.
     */
    report: (outcome: ApprovalOutcome): void => {
      awaitingOutcome.get(outcome.pending)?.(outcome);
    },
    subscribe: (cb: (record: PendingApproval) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    /**
     * Answer every still-pending approval on teardown, so a suspended run can never hang.
     *
     * [[EXT-110]] — **and answer it as a teardown, not as a reject.** The call is still refused;
     * what changed is what the archive is told about WHO refused it. This used to send
     * `{ type: 'reject', message: 'Session ended before approval.' }`, which is the same shape a
     * person pressing *reject* sends — so a terminal closed with a prompt on screen was written
     * into the `/debug-dump` archive as a human having looked at that command and said no. That is
     * the strongest statement the archive makes, and it was being made about nobody.
     */
    abortPending: () => {
      for (const record of [...outstanding]) {
        record.resolve({ type: 'teardown', message: 'Session ended before approval.' });
      }
      // [[EXT-150]] — and tell everything still waiting that no outcome is coming. Fail-closed here
      // means `null`, which the App renders as *no persistence claim*: a surface that hung waiting
      // would be as bad as one that guessed, and guessing is what this node removes.
      for (const settle of [...awaitingOutcome.values()]) settle(null);
    },
  };
}

/**
 * [[TUI-C68]] §6.1 — the same fan-out for **attack halts**, so the runner's halt seam can reach the
 * mounted React app and a human can type their way past one.
 *
 * A second bridge rather than a widened approval one: the answers are different types, and keeping
 * them apart is what stops a surface returning an approval `scope` for a halt that must never carry
 * one.
 *
 * Fail-closed the same way: if the session ends while a banner is still up, `abortPending` answers
 * it so the suspended run cannot hang — and it answers with a value that does not run the command.
 */
export function createAttackHaltBridge() {
  const listeners = new Set<(record: PendingAttackBanner) => void>();
  const outstanding = new Set<PendingAttackBanner>();
  return {
    /** Wired to `runner.setAttackHaltCallback`: returns a Promise the runner awaits. */
    request: (halt: PendingAttackHalt): Promise<AttackHaltReply> =>
      new Promise<AttackHaltReply>((resolve) => {
        let settled = false;
        const record: PendingAttackBanner = {
          halt,
          resolve: (reply) => {
            if (settled) return;
            settled = true;
            outstanding.delete(record);
            resolve(reply);
          },
        };
        outstanding.add(record);
        for (const l of listeners) l(record);
      }),
    subscribe: (cb: (record: PendingAttackBanner) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    /**
     * Answer every still-open banner on teardown.
     *
     * [[EXT-110]] — with `teardown` rather than `stop`, for the reason the approval bridge above
     * sends a teardown reply. The run still ends: `run-anyway` is the only value that runs
     * anything, so the §6.1 polarity is untouched and every other value halts. What no longer
     * happens is the archive recording a person as having read an attack banner and refused it
     * when the session had already gone.
     */
    abortPending: () => {
      for (const record of [...outstanding]) record.resolve('teardown');
    },
  };
}
