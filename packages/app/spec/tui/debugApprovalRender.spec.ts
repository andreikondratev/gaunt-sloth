import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resetToolDisplaySecretsCacheForTests,
  setToolDisplayConfig,
} from '@gaunt-sloth/core/core/toolDisplay.js';
import type { ResolvedApprovals } from '@gaunt-sloth/core/config.js';
import type {
  ApprovalDecisionCapture,
  RaterCallCapture,
} from '@gaunt-sloth/core/core/shell/approvalCapture.js';
import { renderApprovalDetails } from '#src/tui/debugRender.js';

/**
 * TUI-C27 — the `/debug` panel's **Auto-mode** tab.
 *
 * **Why four cases and not one.** The tab exists because "escalated" on its own does not say WHICH
 * layer of the gate stopped a command, and those need different answers: a deterministic floor
 * match, a rater verdict, a rating taken on a command the parser could not statically resolve, and
 * a declared list entry. A single "it shows the verdict" test cannot see that distinction — it
 * passes just as well against a renderer that prints one word for every branch. So each case is
 * asserted on its own, and each also asserts the OTHER stages' wording is absent, which is what
 * makes the control mutation (give every stage the same label) go red on all four.
 *
 * The stage sentences below are written out as literals rather than imported from the module under
 * test. Importing the label table would make it agree with itself, which is exactly the assertion
 * that cannot fail.
 */
const FLOOR_STAGE = 'decided by: the deterministic hardline floor, before any rating';
const RATER_STAGE = 'decided by: the auto-rater';
const DENY_STAGE = 'decided by: a declared deny entry';
const UNRATED_STAGE = 'decided by: the rung itself';

/** §5.3's two bounds, as a record arriving at the gate carries them. */
const BUDGET = {
  consecutiveRejections: 1,
  rejectionsSinceHuman: 1,
  maxConsecutive: 3,
  maxBeforeHuman: 5,
};

function capture(over: Partial<ApprovalDecisionCapture>): ApprovalDecisionCapture {
  return {
    at: '2026-09-18T10:00:00.000Z',
    tool: 'run_shell_command',
    rung: 'auto',
    budget: BUDGET,
    ...over,
  };
}

/** A rating call that answered. The prompt is required by the type and is never drawn on the tab. */
function rating(over: Partial<RaterCallCapture> = {}): RaterCallCapture {
  return {
    at: '2026-09-18T10:00:01.000Z',
    timeoutMs: 30000,
    negotiable: true,
    prompt: { system: 'the rater system prompt', user: 'the rater user prompt' },
    model: 'ollama/gemma3:12b',
    profile: 'sentry',
    durationMs: 1200,
    verdict: { outcome: 'destructive', reason: 'Discards uncommitted work in the tree' },
    ...over,
  };
}

/**
 * EXT-127's second model call, as a decided record carries it. `messages` is required by the type
 * and, like the rater's prompt, is never drawn on the tab.
 */
function alignment(
  over: Partial<NonNullable<ApprovalDecisionCapture['alignment']>> = {}
): NonNullable<ApprovalDecisionCapture['alignment']> {
  return {
    at: '2026-09-18T10:00:02.000Z',
    timeoutMs: 20000,
    profile: 'sentry',
    durationMs: 800,
    messages: [{ role: 'user', content: 'the alignment checker context' }],
    decision: { kind: 'suggest', reason: 'Wider than what the user asked for' },
    ...over,
  };
}

const APPROVALS: ResolvedApprovals = {
  rung: 'auto',
  rater: 'sentry',
  alignmentChecker: 'sentry',
  allow: [{}, {}] as never,
  deny: [{}] as never,
  escalate: [] as never,
  raterTimeoutMs: 30000,
} as ResolvedApprovals;

describe('TUI-C27 — renderApprovalDetails (the Auto-mode debug tab)', () => {
  it('opens with a description naming what the tab shows and where the rater prompt lives', () => {
    const out = renderApprovalDetails([], APPROVALS);
    // What it is, and the thing it exists to make legible.
    expect(out).toContain('Auto-mode');
    expect(out).toContain('WHICH STAGE decided it');
    // A tab that does NOT show something another surface does must say where that lives, so its
    // absence does not read as the data not being recorded (the panel's own description rule).
    expect(out).toContain('/debug-dump');
    expect(out).toContain('most recent');
  });

  it('lists the rater config in force above the calls', () => {
    const out = renderApprovalDetails([], APPROVALS);
    expect(out).toContain('=== RATER CONFIG ===');
    expect(out).toContain('rung in force: Auto (consults the rater)');
    expect(out).toContain('rater profile: sentry');
    expect(out).toContain('rater timeout: 30000 ms');
    expect(out).toContain('declared entries: 2 allow · 1 deny · 0 escalate');
    expect(out).toContain('(no tool call has been through the gate yet)');
  });

  it('says the rung consults no model when an unrated rung is in force', () => {
    const out = renderApprovalDetails([], { ...APPROVALS, rung: 'manual' });
    expect(out).toContain('rung in force: Manual (consults no model)');
  });

  // ── the four cases, each asserted separately ────────────────────────────────────────────────

  it('CASE 1 — a FLOORED call is attributed to the hardline floor, with the matched pattern', () => {
    const out = renderApprovalDetails(
      [
        capture({
          command: 'rm -rf /',
          stage: 'hardline-floor',
          action: 'reject',
          hardline: { description: 'deletes the filesystem root', pattern: 'rm[ \\t]+-rf[ \\t]+/' },
        }),
      ],
      APPROVALS
    );

    expect(out).toContain(FLOOR_STAGE);
    expect(out).toContain('hardline floor: deletes the filesystem root');
    // §8.1's resolution for this node: the diagnostic surface NAMES the pattern, because "a floor
    // matched" leaves nobody able to act on it. The refusal a user sees is unchanged.
    expect(out).toContain('matched pattern: rm[ \\t]+-rf[ \\t]+/');
    // No model was consulted, and the tab says so rather than leaving a blank.
    expect(out).toContain('rating: none — no model was consulted for this call');

    // …and it is not attributed to any other stage.
    expect(out).not.toContain(RATER_STAGE);
    expect(out).not.toContain(DENY_STAGE);
    expect(out).not.toContain(UNRATED_STAGE);
  });

  it('CASE 2 — a RATED call carries the outcome, the reason, and the model that produced it', () => {
    const out = renderApprovalDetails(
      [
        capture({
          command: 'git reset --hard',
          stage: 'rater',
          action: 'reject',
          rating: rating(),
        }),
      ],
      APPROVALS
    );

    expect(out).toContain(RATER_STAGE);
    expect(out).toContain('rating: destructive — Discards uncommitted work in the tree');
    expect(out).toContain('rater model: ollama/gemma3:12b');
    expect(out).toContain('profile: sentry');
    expect(out).toContain('1200 ms');
    expect(out).toContain('outcome: rejected');

    // The discriminator against CASE 3: this command parsed, so there is no shape report.
    expect(out).not.toContain('command not statically resolvable');
    expect(out).not.toContain(FLOOR_STAGE);
    expect(out).not.toContain(DENY_STAGE);
  });

  it('CASE 3 — an UNRESOLVABLE-COMMAND call is a rating that carries the parser’s shape report', () => {
    const out = renderApprovalDetails(
      [
        capture({
          command: 'sh -c "$(cat payload)"',
          stage: 'rater',
          action: 'escalate',
          // EXT-81 retired the abstain ACTION; what survives is the parser's own report, carried
          // into the rating as neutral context. So this shares CASE 2's stage and is told apart by
          // the block below — not by a stage of its own.
          parserUnresolved: {
            mechanism: 'substitution',
            mechanisms: ['substitution'],
            notes: ['The shell runs the output of the inner command.'],
          },
          // A preflight of a DIFFERENT kind sits on the same record, so rendering the preflight's
          // kind where the parser's mechanism belongs is an observable swap rather than a no-op.
          preflight: {
            kind: 'open-world',
            reason: 'a host literal sits in a fetch position',
            rewroteRating: false,
            floorApplied: true,
          },
          rating: rating(),
        }),
      ],
      APPROVALS
    );

    expect(out).toContain('command not statically resolvable: substitution');
    expect(out).toContain('note: The shell runs the output of the inner command.');
    // Still the rater's decision — the shape report is context, not an outcome of its own.
    expect(out).toContain(RATER_STAGE);
    // The preflight is reported beside it, with BOTH of its questions answered: whether the rating
    // sat below the floor, and whether the decision's readers applied the floor at all.
    expect(out).toContain('preflight: open-world — a host literal sits in a fetch position');
    expect(out).toContain('rewrote the rating: no');
    expect(out).toContain('applied to the decision: yes');

    expect(out).not.toContain(FLOOR_STAGE);
    expect(out).not.toContain(DENY_STAGE);
  });

  it('CASE 4 — a LIST-MATCHED call is attributed to the declared entry that decided it', () => {
    const out = renderApprovalDetails(
      [
        capture({
          command: 'curl https://example.test',
          stage: 'deny-list',
          action: 'reject',
          ruleMatch: { action: 'deny', entry: 'curl *', rate: false },
        }),
      ],
      APPROVALS
    );

    expect(out).toContain(DENY_STAGE);
    expect(out).toContain('list entry: deny — curl *');
    expect(out).toContain('rater kept on as a tripwire: no');
    // No model was involved, which is the whole difference from CASE 2 and CASE 3.
    expect(out).toContain('rating: none — no model was consulted for this call');

    expect(out).not.toContain(RATER_STAGE);
    expect(out).not.toContain(FLOOR_STAGE);
    expect(out).not.toContain(UNRATED_STAGE);
  });

  // ── the rest of the record ──────────────────────────────────────────────────────────────────

  it('distinguishes a fail-closed verdict from one the rater actually reached', () => {
    const out = renderApprovalDetails(
      [
        capture({
          command: 'npm publish',
          stage: 'rater',
          action: 'escalate',
          rating: rating({
            failClosed: 'timeout',
            verdict: { outcome: 'destructive', reason: 'Could not assess this command' },
            providerError: { status: 400, message: 'tool_choice is not supported' },
          }),
        }),
      ],
      APPROVALS
    );

    expect(out).toContain('fail-closed: timeout — the gate decided this, not the rater');
    expect(out).toContain('provider error: HTTP 400 — tool_choice is not supported');
  });

  it('draws the alignment check as its own block, not folded into the rating', () => {
    // EXT-127 puts a SECOND model call beside the rating, and the two can disagree — here the
    // rater says `destructive` while the checker says `suggest`. Collapsing them would leave the
    // surface unable to answer which of the two decided, which is the question the tab is for.
    const out = renderApprovalDetails(
      [
        capture({
          command: 'rm -r build dist',
          stage: 'rater',
          action: 'reject',
          rating: rating(),
          alignment: alignment({
            decision: {
              kind: 'suggest',
              reason: 'Wider than what the user asked for',
              suggestedCommand: 'rm -r build',
            },
          }),
        }),
      ],
      APPROVALS
    );

    expect(out).toContain('alignment check: suggest — Wider than what the user asked for');
    expect(out).toContain('suggested instead: rm -r build');
    expect(out).toContain('checker profile: sentry');
    // The rating is still its own line with its own outcome, so neither block is the other's label.
    expect(out).toContain('rating: destructive — Discards uncommitted work in the tree');
    // The checker's context is the archive's job, on the same footing as the rater's prompt.
    expect(out).not.toContain('the alignment checker context');
  });

  it('says the gate failed the alignment check closed, naming the CHECKER and not the rater', () => {
    const out = renderApprovalDetails(
      [
        capture({
          command: 'npm publish',
          stage: 'rater',
          action: 'escalate',
          rating: rating(),
          alignment: alignment({ decision: undefined, failClosed: 'timeout' }),
        }),
      ],
      APPROVALS
    );

    expect(out).toContain('alignment check: sent, but no decision was recorded');
    expect(out).toContain('fail-closed: timeout — the gate decided this, not the checker');
  });

  it('records the APPROVING branch, which relays nothing to anyone and so leaves no other trace', () => {
    const out = renderApprovalDetails(
      [
        capture({
          command: 'git status',
          stage: 'rater',
          action: 'approve',
          scope: 'once',
          rating: rating({ verdict: { outcome: 'safe', reason: 'Reads the working tree' } }),
        }),
      ],
      APPROVALS
    );

    expect(out).toContain('outcome: approved — the tool ran');
    expect(out).toContain('rating: safe — Reads the working tree');
    expect(out).toContain('granted for: once');
  });

  it('reports whether a person was actually reached', () => {
    const out = renderApprovalDetails(
      [capture({ stage: 'escalate-entry', action: 'reject', humanAnswer: 'no-human' })],
      APPROVALS
    );
    expect(out).toContain('a person was asked: no — nobody was at the keyboard');
  });

  /**
   * [[EXT-193]] — and the answer that came back unreadable, which reaches this tab from the
   * protocol surfaces. The label has to say what it is rather than leaving a reader to infer a
   * refusal from the `reject` on the line above: the whole point of the value is that the two are
   * different facts, and a tab that rendered nothing for it would put the inference back.
   */
  it('says when the answer came back in a form it could not read', () => {
    const out = renderApprovalDetails(
      [capture({ stage: 'escalate-entry', action: 'reject', humanAnswer: 'unrecognised' })],
      APPROVALS
    );
    expect(out).toContain(
      'a person was asked: asked, but the answer came back in a form this build could not read'
    );
    expect(out).not.toContain('a person was asked: yes, and they refused');
  });

  it('orders the calls most recent first, and numbers them so the order is not guessed at', () => {
    // The log hands them over oldest-first; the tab is an 8-row viewport, so the call a person
    // opened it about would otherwise be a scroll to the bottom of fifty records.
    const out = renderApprovalDetails(
      [
        capture({ command: 'first-command', stage: 'rater', action: 'approve', rating: rating() }),
        capture({ command: 'second-command', stage: 'rater', action: 'reject', rating: rating() }),
      ],
      APPROVALS
    );

    expect(out).toContain('=== GATED CALLS (2) — most recent first ===');
    expect(out.indexOf('second-command')).toBeLessThan(out.indexOf('first-command'));
    expect(out).toContain('── 1 of 2 ·');
    expect(out).toContain('── 2 of 2 ·');
  });

  it('does not draw the rater prompt or its raw answer — those are the archive’s job', () => {
    const out = renderApprovalDetails(
      [
        capture({
          stage: 'rater',
          action: 'reject',
          rating: rating({ rawResponse: { outcome: 'destructive', note: 'RAW-ANSWER-MARKER' } }),
        }),
      ],
      APPROVALS
    );
    expect(out).not.toContain('the rater system prompt');
    expect(out).not.toContain('the rater user prompt');
    expect(out).not.toContain('RAW-ANSWER-MARKER');
  });

  it('renders the record as MANY lines, so the panel’s viewport can window it', () => {
    // The neutraliser escapes newlines. Applied to the assembled block instead of per leaf, the
    // whole tab would arrive as one line and the panel would have nothing to scroll.
    const out = renderApprovalDetails(
      [capture({ command: 'git status', stage: 'rater', action: 'approve', rating: rating() })],
      APPROVALS
    );
    expect(out.split('\n').length).toBeGreaterThan(10);
  });
});

/**
 * **No payload below is a real key.** Both are synthetic, and every assertion is on the redacted
 * form or on the absence of a synthetic fragment — never on a secret read from the environment.
 */
const BEL = String.fromCharCode(7);

/** Matches `\bsk-[A-Za-z0-9_-]{16,}` and is otherwise nothing. */
const PROVIDER_SHAPED = 'sk-EXAMPLEONLYnotarealkey0000000';

/**
 * A **configured literal** secret carrying a control character — the only shape that can tell the
 * two orderings apart. The provider patterns anchor on printable ASCII the neutraliser leaves
 * alone, so an `sk-…` payload redacts on either side of the call and a control built on one would
 * be an assertion that cannot fail. A harvested literal is matched VERBATIM, so the instant the BEL
 * inside it becomes `\x07` the match is gone.
 */
const CONFIGURED_SECRET = `plan${BEL}literal-secret`;
const CONFIG_WITH_INLINE_SECRET = { llm: { apiKey: CONFIGURED_SECRET } };

describe('TUI-C27 — the Auto-mode tab reuses the GS2-47/GS2-54 on-screen redaction', () => {
  beforeEach(() => {
    // Drop anything an earlier spec in this worker registered: a leaked literal could make a
    // redaction assertion here pass for a reason that has nothing to do with this code.
    resetToolDisplaySecretsCacheForTests();
  });

  afterEach(() => {
    resetToolDisplaySecretsCacheForTests();
  });

  it('redacts a provider-key-shaped literal in the command the user ran', () => {
    const out = renderApprovalDetails(
      [
        capture({
          command: `curl -H "x: ${PROVIDER_SHAPED}" https://example.test`,
          stage: 'rater',
          action: 'reject',
          rating: rating(),
        }),
      ],
      APPROVALS
    );

    // The line actually rendered — without this anchor the negative below would pass against a
    // renderer that drew no command at all.
    expect(out).toContain('command: curl');
    expect(out).toContain('<redacted>');
    expect(out).not.toContain('EXAMPLEONLY');
  });

  it('redacts the rater’s reason as well as the command', () => {
    const out = renderApprovalDetails(
      [
        capture({
          command: 'deploy',
          stage: 'rater',
          action: 'reject',
          rating: rating({
            verdict: {
              outcome: 'attack',
              reason: `exfiltrates ${PROVIDER_SHAPED} to a third party`,
            },
          }),
        }),
      ],
      APPROVALS
    );

    expect(out).toContain('rating: attack — exfiltrates <redacted> to a third party');
    expect(out).not.toContain('EXAMPLEONLY');
  });

  it('redacts the alignment checker’s reason and its suggested command', () => {
    // The checker's sentence is model-authored and its suggested command is a command — both are
    // the same class of free text as the rater's reason, and both are rendered by a different
    // function, so the rater's coverage above says nothing about them.
    const out = renderApprovalDetails(
      [
        capture({
          command: 'deploy',
          stage: 'rater',
          action: 'reject',
          rating: rating(),
          alignment: alignment({
            decision: {
              kind: 'suggest',
              reason: `the key ${PROVIDER_SHAPED} does not belong here`,
              suggestedCommand: `deploy --token ${PROVIDER_SHAPED}`,
            },
          }),
        }),
      ],
      APPROVALS
    );

    expect(out).toContain('alignment check: suggest — the key <redacted> does not belong here');
    expect(out).toContain('suggested instead: deploy --token <redacted>');
    expect(out).not.toContain('EXAMPLEONLY');
  });

  it('redacts a configured literal BEFORE neutralisation rewrites its control character', () => {
    setToolDisplayConfig(CONFIG_WITH_INLINE_SECRET);
    const out = renderApprovalDetails(
      [
        capture({
          command: `echo ${CONFIGURED_SECRET} > note`,
          stage: 'rater',
          action: 'reject',
          rating: rating(),
        }),
      ],
      APPROVALS
    );

    // Redaction ran on the RAW string, so the literal still matched and the whole value became the
    // marker. Swap the two and every assertion below fails: the BEL is rewritten first, the literal
    // no longer matches, no provider pattern covers this payload, and the secret paints onto the
    // tab as `plan\x07literal-secret`.
    expect(out).toContain('command: echo <redacted> > note');
    expect(out).not.toContain('literal-secret');
    expect(out).not.toContain('\\x07');
  });

  it('neutralises a control character that is NOT part of a secret, rather than passing it through', () => {
    const out = renderApprovalDetails(
      [
        capture({
          command: `printf ${BEL}bell`,
          stage: 'rater',
          action: 'reject',
          rating: rating(),
        }),
      ],
      APPROVALS
    );
    expect(out).toContain('command: printf \\x07bell');
  });
});
