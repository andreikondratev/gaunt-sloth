/**
 * EXT-58 acceptance for spec §7 — what the model is told when a gated call is refused.
 *
 * The bar the spec sets: a rejection MUST name the moves available to the model, not merely the
 * refusal. It names those moves and nothing else — [[EXT-173]] removed the granted-alternative
 * clause, so the message never points the model at a different tool to call instead.
 */
import { describe, expect, it } from 'vitest';
import { buildRejectionMessage, REJECTION_MOVES } from '#src/core/shell/rejection.js';

describe('§7 rejection message', () => {
  it('names both moves, always', () => {
    const message = buildRejectionMessage({ source: 'user', toolName: 'run_shell_command' });
    expect(message).toContain('call the same command with a justification');
    expect(message).toContain('call a different command');
    expect(message).toContain(REJECTION_MOVES);
  });

  /**
   * [[EXT-106]] §5 — **the model is not offered a move it does not have.**
   *
   * *"Ask the user"* here meant the agent writes prose and the turn ends. That text never reaches
   * the gate, so the confirmation it asks for cannot arrive: the next call meets the identical
   * deterministic floor and is refused identically. A run that ends this way hands the user homework
   * that cannot be done, and the moves list is what taught the model to do it.
   *
   * Asserted on the substring rather than on the whole constant, because the failure to guard
   * against is the exit being *reworded* back in rather than restored verbatim.
   */
  it('[[EXT-106]] offers no "ask the user" exit — it does not reach the gate', () => {
    for (const source of ['user', 'rater'] as const) {
      const message = buildRejectionMessage({ source, toolName: 'run_shell_command' });
      expect(message.toLowerCase(), source).not.toContain('ask the user');
    }
    expect(REJECTION_MOVES.toLowerCase()).not.toContain('ask the user');
  });

  it('says who refused and what', () => {
    expect(buildRejectionMessage({ source: 'user', toolName: 'run_shell_command' })).toContain(
      'The user rejected your call to run_shell_command.'
    );
    expect(buildRejectionMessage({ source: 'rater', toolName: 'run_shell_command' })).toContain(
      'The auto-rater rejected your call to run_shell_command.'
    );
  });

  it('carries the rating explanation when one exists', () => {
    const message = buildRejectionMessage({
      source: 'user',
      toolName: 'run_shell_command',
      verdict: { outcome: 'destructive', reason: 'deletes a directory tree irreversibly' },
    });
    expect(message).toContain('Explanation: deletes a directory tree irreversibly');
  });

  it('omits the explanation at the unrated rungs, where there is no rating at all', () => {
    // manual / write consult no model, so there is nothing to quote — but the moves still apply.
    const message = buildRejectionMessage({ source: 'user', toolName: 'run_shell_command' });
    expect(message).not.toContain('Explanation:');
    expect(message).toContain(REJECTION_MOVES);
  });

  /**
   * [[EXT-173]] — §4.4's granted alternative is gone from §7's message. The negatives are paired
   * with the two things the message must STILL carry, because a `not.toContain` over a message that
   * had lost its reason and its moves would pass just as happily.
   */
  it('offers no alternative tool, while still carrying the reason and the moves', () => {
    const message = buildRejectionMessage({
      source: 'user',
      toolName: 'run_shell_command',
      verdict: {
        outcome: 'destructive',
        reason: 'rewrites a file in place',
      },
    });
    expect(message).toContain('Explanation: rewrites a file in place');
    expect(message).toContain(REJECTION_MOVES);
    expect(message).not.toContain('already approved at this level');
    expect(message).not.toContain('will not interrupt the user');
    expect(message).not.toContain('edit_file');
  });

  it('falls back to a generic target when no tool name is supplied', () => {
    expect(buildRejectionMessage({ source: 'rater' })).toContain(
      'The auto-rater rejected your command.'
    );
  });
});
