import { describe, expect, it } from 'vitest';
import {
  recordHumanAnswer,
  type ApprovalDecisionCapture,
} from '@gaunt-sloth/core/core/shell/approvalCapture.js';
import type { PendingAttackHalt, PendingToolInterrupt } from '@gaunt-sloth/core/core/types.js';
import { createApprovalBridge, createAttackHaltBridge } from '#src/tui/approvalBridges.js';
import type { PendingApproval, PendingAttackBanner } from '#src/tui/types.js';

/**
 * [[EXT-110]] — **what each TUI bridge answers a prompt with when the session goes away, and what
 * the archive is therefore told.**
 *
 * ## Why this reaches for the production factories
 *
 * `abortPending` had no test at all until this file, on either bridge, which is how a teardown came
 * to be archived as a human refusal for as long as it was. The one existing e2e that drives the
 * approval bridge keeps a hand-written COPY of it beside the test, because the real one was private
 * to `tuiSessionModule` — and a copy agrees with whatever the original does, including being wrong.
 * So these import the very functions the session wires ([[EXT-110]] moved them to their own module
 * for exactly this), and assert on the reply that comes back out.
 *
 * ## And why the reply is then run through `recordHumanAnswer`
 *
 * A reply is only half the claim. The finding is about what lands in the `/debug-dump` archive, so
 * each case carries its reply on into core's single writer of that field and reads the record.
 * `approvalCapture.spec.ts` asserts the other half — the runner writing through that same funnel,
 * end to end into the written archive — so between them no step is asserted by a stand-in.
 */

const BUDGET = {
  consecutiveRejections: 0,
  rejectionsSinceHuman: 0,
  maxConsecutive: 3,
  maxBeforeHuman: 5,
};

function record(): ApprovalDecisionCapture {
  return {
    at: '2026-09-19T10:00:00.000Z',
    tool: 'run_shell_command',
    rung: 'auto',
    budget: BUDGET,
  };
}

const interrupt: PendingToolInterrupt = {
  name: 'run_shell_command',
  args: { command: 'rm -rf ./dist' },
};

const halt: PendingAttackHalt = {
  command: 'rm -rf ./dist',
  reason: 'The command structure evidences an injected instruction.',
};

describe('[[EXT-110]] a prompt torn down with nobody at the keyboard', () => {
  it('is answered by the approval bridge as a teardown, and archived as one', async () => {
    const bridge = createApprovalBridge();
    let emitted: PendingApproval | undefined;
    bridge.subscribe((r) => {
      emitted = r;
    });

    const pending = bridge.request(interrupt);
    expect(emitted).toBeDefined();

    // The session ends with the prompt still up. Nobody touched a key.
    bridge.abortPending();

    const reply = await pending;
    // Still fail-closed: the tool does not run. What changed is that the reply no longer claims to
    // be a decision, so nothing downstream can mistake it for one.
    expect(reply.type).toBe('teardown');

    const torn = record();
    recordHumanAnswer(torn, reply);
    expect(torn.humanAnswer).toBe('teardown');
  });

  it('is answered by the attack-halt bridge as a teardown, and archived as one', async () => {
    const bridge = createAttackHaltBridge();
    let emitted: PendingAttackBanner | undefined;
    bridge.subscribe((r) => {
      emitted = r;
    });

    const pending = bridge.request(halt);
    expect(emitted).toBeDefined();

    bridge.abortPending();

    const reply = await pending;
    // §6.1's polarity is intact: `run-anyway` is still the only value that runs anything, so this
    // halts the run exactly as `stop` did.
    expect(reply).toBe('teardown');
    expect(reply).not.toBe('run-anyway');

    const torn = record();
    recordHumanAnswer(torn, reply);
    expect(torn.humanAnswer).toBe('teardown');
  });

  /**
   * The negative half. Everything above is satisfied by a build that stopped recording human
   * answers altogether, which would be a worse archive than the broken one — so the same two
   * bridges are driven by a person instead of by a teardown, and the record must still name them.
   */
  it('does not stop the bridges recording a person who really did answer', async () => {
    const approvals = createApprovalBridge();
    let approval: PendingApproval | undefined;
    approvals.subscribe((r) => {
      approval = r;
    });
    const pendingApproval = approvals.request(interrupt);
    // A person at the dialog pressing *reject*, which is what the App's own controls send.
    void approval?.resolve({ type: 'reject', message: 'The user rejected this tool call.' });
    const approvalReply = await pendingApproval;
    expect(approvalReply.type).toBe('reject');
    const refused = record();
    recordHumanAnswer(refused, approvalReply);
    expect(refused.humanAnswer).toBe('reject');

    const banners = createAttackHaltBridge();
    let banner: PendingAttackBanner | undefined;
    banners.subscribe((r) => {
      banner = r;
    });
    const pendingBanner = banners.request(halt);
    banner?.resolve('stop');
    const bannerReply = await pendingBanner;
    expect(bannerReply).toBe('stop');
    const stopped = record();
    recordHumanAnswer(stopped, bannerReply);
    expect(stopped.humanAnswer).toBe('reject');

    // And the other side of a person's answer, so "record everything as a refusal" fails too.
    const ranAnyway = record();
    recordHumanAnswer(ranAnyway, 'run-anyway');
    expect(ranAnyway.humanAnswer).toBe('approve');
  });

  /**
   * A teardown after a person has already answered must not overwrite their answer. The bridges'
   * `resolve` is idempotent — the first answer wins — and that is what keeps the record honest in
   * the race this node is named after: a teardown that arrives a moment late.
   */
  it('leaves an answer that arrived first alone when the teardown races it', async () => {
    const bridge = createApprovalBridge();
    let emitted: PendingApproval | undefined;
    bridge.subscribe((r) => {
      emitted = r;
    });
    const pending = bridge.request(interrupt);
    void emitted?.resolve({ type: 'approve', scope: 'once' });
    bridge.abortPending();

    const reply = await pending;
    expect(reply.type).toBe('approve');
    const answered = record();
    recordHumanAnswer(answered, reply);
    expect(answered.humanAnswer).toBe('approve');
  });
});
