/**
 * [[EXT-169]] — **a canary over the one prose arm that catches groq's uncoded context overflow.**
 *
 * This is not a second detector. [[EXT-163]] settled that groq's uncoded over-window 400 carries
 * nothing structural to key on, so the prose arm is the only carrier there can be. What was missing
 * is a way to **find out when that assumption stops holding**, because every other cell pinning it
 * asserts against a *recorded* fixture: groq can reword its message server-side and the whole suite
 * stays green while production silently reclassifies the overflow as `invalid_request`, which the
 * runner never compacts. The symptom in the field is a groq run that stops instead of compacting,
 * with nothing red and nothing logged.
 *
 * So the live cell below sends one deliberately over-window request to a small-window groq model
 * and reads what comes back. The assertion it makes is in `support/groqOverflowArm.ts`, together
 * with the argument for its shape — in short: it asserts on the **response body** and on **which
 * production arm matched**, and it refuses a body the TPM arm carried, because a groq rate
 * rejection classifies as `context_overflow` too and would otherwise satisfy a category-only check
 * exactly when the arm it guards had broken.
 *
 * ## Where a human sees it, and why here
 *
 * The filename carries the `xx-small` tier token, so this runs in the **groq leg of
 * `integration-tests-small.yml` and of the release workflow's `integration-tests-small` job** — the
 * only places in CI that hold `GROQ_API_KEY`. That release job is non-gating by design: its legs
 * report next to the manual deploy approval, so a provider outage informs the approver instead of
 * blocking a release. That is the right audience for a canary. The person approving a release is
 * the one who needs to know whether groq's overflow still classifies, because compaction on groq
 * depends on it, and it is a judgement call — a reworded groq message is not a reason to stop a
 * release, it is a reason to file the arm change.
 *
 * A red cell alone would only ever report *breakage*, so the check also writes one line per run to
 * `$GITHUB_STEP_SUMMARY` — the surface the eval gate and the post-publish smoke already use for the
 * same reason — carrying the status, the matched arms and **the sentence groq actually sent**. That
 * is what makes a drift visible before it becomes a failure, and it is written on the skip path too
 * so a leg with no key is legible rather than hiding inside a green tick.
 *
 * `process.stdout.write` rather than `console.log`: vitest intercepts `console` and its default
 * reporter shows captured output only for failing tests, so a `console.log` would be invisible in
 * exactly the passing and skipping cases this line exists for.
 *
 * ## Cost
 *
 * One request per run, `retry: 0` so a red cell is not three. The request is rejected at validation
 * for exceeding the model's window; the rejection body carries no `usage` block, which is
 * consistent with it not being billed but is not by itself proof of it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatGroq } from '@langchain/groq';
import { classifyThrownTermination } from '@gaunt-sloth/core/core/terminationReason.js';
import {
  assertLoadBearingArmFired,
  describeGroqRejection,
  LOAD_BEARING_ARM,
  observeGroqRejection,
  TPM_ARM,
} from './support/groqOverflowArm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * `allam-2-7b` — a 4096-token window, which is what makes the over-window request cheap to compose
 * and fast to reject. Override with `GROQ_CANARY_MODEL` when groq retires it; the assertion names
 * that case separately so a dead model never reads as a rewording.
 */
const CANARY_MODEL = process.env.GROQ_CANARY_MODEL || 'allam-2-7b';

/**
 * Comfortably past a 4096-token window, and deliberately not tuned to the edge: the point is an
 * unambiguous over-window rejection, not a measurement of where the window is. A model with a large
 * window would not overflow on this, which is why the model is pinned small rather than taken from
 * the run's own provider config.
 */
const OVERFLOW_PROMPT = 'overflow '.repeat(8000);

/** Write one line to stdout, and to the CI job summary when there is one. */
function report(line: string): void {
  process.stdout.write(`${line}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${line}\n`);
}

/**
 * Which provider this `pnpm run it <provider>` invocation selected, read off the config
 * `setup-config.js` writes for the run.
 *
 * A dependency on the runner's own output rather than on an env flag, deliberately: every leg of
 * the small-integration matrix carries `GROQ_API_KEY` on the step env, so a key-only gate would
 * fire this canary once per provider — seven live groq calls for one question. Reading the selected
 * config fires it once, in the groq leg, and needs nothing added to a workflow to stay correct.
 */
function selectedProviderType(): string | undefined {
  try {
    const raw = readFileSync(path.join(HERE, 'workdir', '.gsloth.config.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const llm = (parsed as { llm?: { type?: unknown } } | null)?.llm;
    return typeof llm?.type === 'string' ? llm.type : undefined;
  } catch {
    return undefined;
  }
}

const selected = selectedProviderType();
const hasKey = Boolean(process.env.GROQ_API_KEY);
const live = selected === 'groq' && hasKey;

if (!live) {
  const why =
    selected === 'groq'
      ? 'GROQ_API_KEY is not set'
      : `this run selected provider "${selected ?? 'unknown'}"`;
  report(`[[EXT-169]] groq overflow canary — SKIPPED (${why}); the arm was not exercised live.`);
}

describe.skipIf(!live)('[[EXT-169]] groq uncoded overflow — live canary over the prose arm', () => {
  // The default is a failure, so a cell that dies without reaching its own end — a timeout, a
  // process kill — still reports a verdict rather than leaving the summary silent, which is the
  // shape of the defect this node is about.
  let verdict = `[[EXT-169]] groq overflow canary — FAILED (the cell did not run to completion)`;
  afterAll(() => report(verdict));

  it(
    `classifies an over-window ${CANARY_MODEL} rejection by the '${LOAD_BEARING_ARM}' arm`,
    { retry: 0 },
    async () => {
      // `maxRetries: 0` so the run makes exactly one request. The key is read from the environment
      // by the wrapper; this file never names its value, and neither does anything it prints.
      const llm = new ChatGroq({ model: CANARY_MODEL, maxRetries: 0, temperature: 0 });

      let thrown: unknown;
      try {
        await llm.invoke(OVERFLOW_PROMPT);
      } catch (error) {
        thrown = error;
      }

      expect(
        thrown,
        `groq ACCEPTED an input far past ${CANARY_MODEL}'s window — the canary has lost its input, ` +
          `because there is no rejection to classify. Pick a smaller-window model.`
      ).toBeDefined();

      const observed = observeGroqRejection(thrown);
      // Written before the assertion, so the observation survives a red cell: what groq actually
      // sent is the thing a human needs in front of them when this goes red.
      report(`[[EXT-169]] groq overflow canary — OBSERVED ${describeGroqRejection(observed)}`);

      assertLoadBearingArmFired(observed);

      verdict =
        `[[EXT-169]] groq overflow canary — PASS: groq's over-window 400 is still classified by ` +
        `the '${LOAD_BEARING_ARM}' arm, and not by '${TPM_ARM}'.`;
    }
  );
});

/**
 * The two controls. Neither needs a key or a network, so both run in every leg and go red the
 * moment the assertion stops discriminating — which is what stops the live cell above from
 * degrading into a category check nobody notices.
 */
describe('[[EXT-169]] canary controls — offline, no key, no request', () => {
  /** The SDK's own error classes, reached through the client `ChatGroq` builds. Never sends. */
  const errorClasses = () => {
    const client = new ChatGroq({ apiKey: 'stub-never-sent', model: CANARY_MODEL, maxRetries: 0 })
      .client as unknown as {
      constructor: Record<
        'BadRequestError' | 'RateLimitError',
        new (
          status: number,
          body: { error: Record<string, unknown> },
          message: string | undefined,
          headers: Headers
        ) => Error
      >;
    };
    return client.constructor;
  };

  const headers = () => new Headers({ 'x-request-id': 'req_control' });

  /**
   * Recorded live on 2026-09-10 by [[EXT-163]] against `allam-2-7b`: the whole body of the uncoded
   * overflow 400.
   */
  const RECORDED_OVERFLOW = {
    error: {
      message: 'Please reduce the length of the messages or completion.',
      type: 'invalid_request_error',
      param: 'messages',
    },
  };

  /**
   * Public record, **not measured here** — groq's TPM rejection, which contains the substring the
   * `request too large` arm matches. Groq is not rate-limited on demand, so this control is
   * synthesised rather than live; the body wording is groq's published shape for a tokens-per-minute
   * refusal, and the only property the control depends on is that it carries that substring and not
   * the overflow sentence.
   */
  const TPM_REJECTION = {
    error: {
      message:
        'Request too large for model `allam-2-7b` in organization `org_redacted` service tier ' +
        '`on_demand` on tokens per minute (TPM): Limit 6000, Requested 20000, please reduce your ' +
        'message size and try again.',
      type: 'tokens',
      code: 'rate_limit_exceeded',
    },
  };

  it('CONTROL 1 — the recorded uncoded overflow satisfies the assertion, and stops doing so if the arm is removed', () => {
    // This cell pins a recorded fixture, which is exactly what EXT-169 says is not sufficient AS A
    // CANARY — a recording cannot notice groq rewording. It is sufficient as a control ON the
    // canary's assertion: the assertion asks production which arms matched, so deleting
    // `reduce the length of the messages` from the pattern list turns this red with no key and no
    // network, which is how the live cell above is known to be keyed on that arm and not on the
    // category it shares with a rate rejection.
    const { BadRequestError } = errorClasses();
    const error = new BadRequestError(400, RECORDED_OVERFLOW, undefined, headers());
    const observed = observeGroqRejection(error);

    expect(observed.matchedArms).toContain(LOAD_BEARING_ARM);
    expect(observed.matchedArms).not.toContain(TPM_ARM);
    expect(() => assertLoadBearingArmFired(observed)).not.toThrow();
  });

  it('CONTROL 2 — a TPM rate rejection classifies as an overflow, and is still refused by the assertion', () => {
    const { RateLimitError, BadRequestError } = errorClasses();
    const rateLimited = new RateLimitError(429, TPM_REJECTION, undefined, headers());

    // The trap, pinned rather than described: production really does call this a context overflow,
    // because `isContextOverflow` is consulted before the `status === 429` arm. A canary asserting
    // only the category would pass on this body.
    expect(classifyThrownTermination(rateLimited).category).toBe('context_overflow');

    // And the assertion refuses it anyway, naming the arm that carried it.
    expect(() => assertLoadBearingArmFired(observeGroqRejection(rateLimited))).toThrow(TPM_ARM);

    // The refusal is keyed on the arm, not merely on the 429: the same body at the overflow's own
    // status is still refused. Without this, narrowing the check to a status comparison would look
    // like a passing simplification.
    const at400 = new BadRequestError(400, TPM_REJECTION, undefined, headers());
    expect(() => assertLoadBearingArmFired(observeGroqRejection(at400))).toThrow(TPM_ARM);
  });
});
