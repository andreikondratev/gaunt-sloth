import { describe, expect, it } from 'vitest';
import type { RequestPermissionOutcome } from '@agentclientprotocol/sdk/experimental/v2';
import {
  recordHumanAnswer,
  type ApprovalDecisionCapture,
  type ApprovalHumanAnswer,
} from '@gaunt-sloth/core/core/shell/approvalCapture.js';
import { decisionForOutcome } from '#src/modules/acp/acpPermissions.js';

/**
 * [[EXT-193]] — **what an ACP permission outcome tells the `/debug-dump` archive**, and the safety
 * polarity underneath it, asserted apart from each other.
 *
 * ## The finding
 *
 * `decisionForOutcome` answered every non-approval with `{ type: 'reject' }`. [[EXT-110]] made that
 * value the archive's human-answer evidence, so a client that cancelled a request, or answered with
 * an option id this build never offered, was archived as **a person having considered the command
 * and refused it** — the strongest statement this record makes, and on those branches a false one.
 *
 * ## Why the two questions are asserted separately
 *
 * The ticket is about what the archive SAYS and never about what the gate DOES, and the two are
 * easy to conflate because until now one field carried both. So:
 *
 * - the archive half runs each outcome through core's single writer of that field — the production
 *   `recordHumanAnswer`, not a local re-implementation of its table — and reads the record;
 * - the polarity half asserts which outcomes produce an APPROVAL, which is the whole safety
 *   property in a form no rewording of the archive's vocabulary can satisfy by accident. It is
 *   phrased as "only an explicit allow runs a tool" rather than "everything else is a reject",
 *   because the correct fix gives the non-answers their own reply arms — and a test spelled
 *   `type === 'reject'` would then red on the right implementation while staying green on the
 *   defective one it was written to catch.
 *
 * The runner's half of that polarity — every arm that is not `approve` refusing the call — is
 * pinned where the runner is: `packages/core/spec/approvalCapture.spec.ts` drives it into the
 * written archive, and the ACP cells in `packages/agent/spec/acpSessionMode.spec.ts` drive a real
 * client through a real gate. Between the three, no step is asserted by a stand-in.
 */

const BUDGET = {
  consecutiveRejections: 0,
  rejectionsSinceHuman: 0,
  maxConsecutive: 3,
  maxBeforeHuman: 5,
};

/** A capture record in the state the gate hands to `recordHumanAnswer`. */
function record(): ApprovalDecisionCapture {
  return {
    at: '2026-09-19T10:00:00.000Z',
    tool: 'run_shell_command',
    rung: 'auto',
    budget: BUDGET,
  };
}

/** One answer a client can send back, and the two facts it settles. */
interface OutcomeCase {
  /** What the case is, in the words a dump reader would use. */
  readonly name: string;
  /** A short token for what actually came off the wire, for the set assertions below. */
  readonly wire: string;
  readonly outcome: RequestPermissionOutcome;
  /** What the archive must say about the human. */
  readonly archived: ApprovalHumanAnswer;
}

/**
 * Every shape the wire can carry, including the two the handler used to collapse.
 *
 * The outcome union has **three** arms, not two: `cancelled`, `selected`, and a catch-all for a
 * custom or future `outcome` string (`@agentclientprotocol/sdk` v2). The third is why the fifth row
 * exists — a variant this build has never seen is not a cancel, so it cannot borrow the cancel's
 * answer, and calling it a teardown would say the prompt was never answered when it may well have
 * been.
 */
const CASES: readonly OutcomeCase[] = [
  {
    name: 'the client cancelled the request, or the connection went away under it',
    wire: 'cancelled',
    outcome: { outcome: 'cancelled' },
    archived: 'teardown',
  },
  {
    name: 'the client answered in a dialect this build has never seen',
    wire: '_zed/deferred',
    outcome: { outcome: '_zed/deferred' } as RequestPermissionOutcome,
    archived: 'unrecognised',
  },
  {
    name: 'the user chose Allow once',
    wire: 'allow-once',
    outcome: { outcome: 'selected', optionId: 'allow-once' },
    archived: 'approve',
  },
  {
    name: 'the user chose Allow and remember',
    wire: 'allow-always',
    outcome: { outcome: 'selected', optionId: 'allow-always' },
    archived: 'approve',
  },
  {
    name: 'the user chose Reject once',
    wire: 'reject-once',
    outcome: { outcome: 'selected', optionId: 'reject-once' },
    archived: 'reject',
  },
  {
    name: 'the user chose Reject and remember',
    wire: 'reject-always',
    outcome: { outcome: 'selected', optionId: 'reject-always' },
    archived: 'reject',
  },
  {
    name: 'the client selected an option id this build never offered',
    wire: 'maybe-later',
    outcome: { outcome: 'selected', optionId: 'maybe-later' },
    archived: 'unrecognised',
  },
];

/** What the archive ends up saying about one outcome, through the production writer. */
function archiveOf(outcome: RequestPermissionOutcome): ApprovalHumanAnswer | undefined {
  const captured = record();
  recordHumanAnswer(captured, decisionForOutcome(outcome));
  return captured.humanAnswer;
}

describe('[[EXT-193]] what an ACP permission outcome tells the archive about the human', () => {
  it.each(CASES)('$name is archived as $archived', ({ outcome, archived }) => {
    expect(archiveOf(outcome)).toBe(archived);
  });

  /**
   * **The constraint the whole node reduces to**, asserted over the set rather than row by row: a
   * human refusal is recorded for a refusal option this code recognises, and for nothing else.
   *
   * Stated this way it also carries the half that the cheapest passing implementation breaks. Every
   * other assertion here is satisfied by a handler that simply stops recording refusals on this
   * surface, which would be a worse archive than the broken one — and this cell reds on it, because
   * the expected list is not empty.
   */
  it('records a human refusal for exactly the two refusal options, and for nothing else', () => {
    const refusals = CASES.filter((c) => archiveOf(c.outcome) === 'reject').map((c) => c.wire);

    expect(refusals).toEqual(['reject-once', 'reject-always']);
  });

  /**
   * A cancel and an unreadable answer are **different facts and stay different values.** A cancel
   * ended a prompt with nobody's answer on it; an option id we cannot read came back from a client
   * that answered. Collapsing either into the other would tell an incident review that a prompt
   * nobody answered and a prompt answered illegibly are the same event — the mistake [[EXT-110]]
   * was filed about, one value along.
   */
  it('keeps a cancel and an unreadable answer apart', () => {
    expect(archiveOf({ outcome: 'cancelled' })).not.toBe(
      archiveOf({ outcome: 'selected', optionId: 'maybe-later' })
    );
  });

  /**
   * The transcript line the agent is handed still says WHICH of the three happened. The prose
   * already distinguished them while the type collapsed them, and the unknown-outcome branch is the
   * one place it did not: every non-`selected` outcome was described as a cancellation, so a client
   * answering in a future dialect was reported to the agent as having cancelled.
   */
  it('names what could not be read instead of reporting it as a cancellation', () => {
    const future = decisionForOutcome({ outcome: '_zed/deferred' } as RequestPermissionOutcome);

    expect(future).toMatchObject({ type: 'unrecognised' });
    expect((future as { message?: string }).message).toContain('_zed/deferred');
    expect((future as { message?: string }).message).not.toContain('cancelled');
  });
});

describe('[[EXT-193]] the ACP gate polarity, pinned apart from the archive vocabulary', () => {
  /**
   * **Only an explicit allow runs anything.** `approve` is the one arm of `ToolApprovalReply` that
   * lets a tool run — every other arm is refused by the runner — so naming the inputs that produce
   * it states the safety property exactly, and states it in terms that survive any later edit to
   * what the archive is told.
   */
  it('produces an approval for the two allow options and for no other answer', () => {
    const approving = CASES.filter((c) => decisionForOutcome(c.outcome).type === 'approve').map(
      (c) => c.wire
    );

    expect(approving).toEqual(['allow-once', 'allow-always']);
  });

  /**
   * And the property that keeps a refusal nobody made from outliving the session: neither a
   * teardown nor an unreadable answer can carry a scope, so neither can record a standing allow or
   * deny entry for the next session to inherit. Asserted on the value rather than trusted to the
   * type, because a spec file here is not type-checked.
   */
  it('lets no answer but a real one carry a scope', () => {
    const scoped = CASES.filter(
      (c) => (decisionForOutcome(c.outcome) as { scope?: string }).scope !== undefined
    ).map((c) => c.wire);

    expect(scoped).toEqual(['allow-always', 'reject-always']);
  });
});
