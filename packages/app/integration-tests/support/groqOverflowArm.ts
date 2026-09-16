/**
 * [[EXT-169]] — reading a live groq rejection well enough to say **which arm classified it**.
 *
 * ## Why this is not `expect(category).toBe('context_overflow')`
 *
 * Groq's context overflow is an uncoded 400 whose entire message is one English sentence groq's
 * server composes. Nothing structural on that response identifies it — no `code`, and a `type` of
 * `invalid_request_error` that every groq 400 carries — so the only thing classifying it is the
 * prose arm `reduce the length of the messages` in core's context-overflow pattern list. If groq
 * rewords that sentence, production reclassifies the overflow as `invalid_request`, which the
 * runner never compacts: a run stops instead of compacting, with nothing red and nothing logged.
 *
 * **The category alone cannot detect that**, because the adjacent arm `request too large` catches a
 * groq **TPM rate rejection** — and `isContextOverflow` is consulted *before* the `status === 429`
 * arm, so a rate rejection classifies as `context_overflow` too. A check asserting only the
 * category therefore keeps passing after the prose arm has stopped matching, for as long as the
 * account is busy enough to be rate-limited. It passes for the wrong reason at precisely the moment
 * the thing it guards has broken, which makes it an assertion that cannot fail for the defect it
 * claims to watch.
 *
 * So the assertion here reads the **response body** and the **named arm**, and it rejects a body the
 * TPM arm carried. Do not "simplify" it back to the category: the category is the one property the
 * two causes share.
 *
 * ## Why the arm list comes from core rather than from a constant here
 *
 * `contextOverflowPatternsMatching` is asked which production patterns matched. A local copy of the
 * sentence would still match a body after the production arm had been deleted, so the check would
 * stay green over a removed arm — the failure this exists to catch, reintroduced one layer up.
 * {@link LOAD_BEARING_ARM} is only the *name* of what to look for in that answer; the answer itself
 * is always production's.
 */
import {
  classifyThrownTermination,
  contextOverflowPatternsMatching,
} from '@gaunt-sloth/core/core/terminationReason.js';

/**
 * The arm that carries groq's uncoded overflow, and the only thing that does. Named here so a
 * failure can say which arm it was looking for; the set it is looked up in is production's.
 */
export const LOAD_BEARING_ARM = 'reduce the length of the messages';

/**
 * The adjacent arm a groq **TPM rate rejection** lands on. A body this arm carried must never
 * satisfy the canary — it is the wrong-reason pass the whole design is built to exclude.
 */
export const TPM_ARM = 'request too large';

/** The status groq answers an over-window request with. A rate rejection is 429 or 413, never 400. */
export const OVERFLOW_STATUS = 400;

/** What a groq rejection tells us, reduced to the fields a classification could have read. */
export interface GroqRejection {
  /** The HTTP status, as the SDK error carries it. */
  status: number | undefined;
  /** `error.message` from the response body — the sentence groq's server composed. */
  bodyMessage: string;
  /** `error.type` from the body. Every groq 400 carries `invalid_request_error`. */
  bodyType: string | undefined;
  /** `error.code` from the body, absent on the uncoded overflow shape. */
  bodyCode: string | undefined;
  /** `error.param` from the body. */
  bodyParam: string | undefined;
  /** The production context-overflow arms this error's text matches, in list order. */
  matchedArms: readonly string[];
  /** What production would classify this rejection as. */
  category: string;
  /** Rate/quota response headers, for the question of whether a rejected request was billed. */
  rateLimit: Readonly<Record<string, string>>;
}

/** Read a property off an unknown value without asserting anything about its shape. */
function field(source: unknown, key: string): unknown {
  if (!source || (typeof source !== 'object' && typeof source !== 'function')) return undefined;
  return (source as Record<string, unknown>)[key];
}

/** A property as a string, or undefined for anything that is not one. */
function stringField(source: unknown, key: string): string | undefined {
  const value = field(source, key);
  return typeof value === 'string' ? value : undefined;
}

/** The response headers worth recording, read defensively off whatever the SDK hung them on. */
function rateLimitHeaders(error: unknown): Record<string, string> {
  const wanted = [
    'x-request-id',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-tokens',
    'x-ratelimit-reset-tokens',
    'retry-after',
  ];
  const holder = field(error, 'headers');
  const read = (name: string): string | undefined => {
    if (holder instanceof Headers) return holder.get(name) ?? undefined;
    return stringField(holder, name);
  };
  const out: Record<string, string> = {};
  for (const name of wanted) {
    const value = read(name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Reduce a thrown groq rejection to {@link GroqRejection}.
 *
 * The SDK hangs the parsed body on `error`, so the sentence is at `error.error.message`; a re-wrap
 * that replaces the top-level message leaves it there. The top-level message is the fallback,
 * because it is the serialised body and still contains the sentence.
 *
 * Nothing here reads, stores or returns a credential: the fields are the response body's own and
 * the headers are an explicit allow-list of rate/quota values. The raw error is deliberately never
 * returned or printed — a serialised SDK error is the shape that has leaked a live key before.
 */
export function observeGroqRejection(error: unknown): GroqRejection {
  const body = field(error, 'error');
  const inner = field(body, 'error') ?? body;
  const bodyMessage = stringField(inner, 'message') ?? stringField(error, 'message') ?? '';
  const status = field(error, 'status');
  return {
    status: typeof status === 'number' ? status : undefined,
    bodyMessage,
    bodyType: stringField(inner, 'type'),
    bodyCode: stringField(inner, 'code'),
    bodyParam: stringField(inner, 'param'),
    matchedArms: contextOverflowPatternsMatching(error),
    category: classifyThrownTermination(error).category,
    rateLimit: rateLimitHeaders(error),
  };
}

/**
 * One line a human can read in a job summary: the arms, the status, and groq's actual sentence.
 *
 * The rate/quota headers ride along because they are what a reader needs to interpret a red cell.
 * The one failure this canary cannot distinguish from the outside is a busy account: if the run was
 * refused for tokens-per-minute rather than for window size, the remaining-token header is the
 * evidence for that, and `x-request-id` is what groq support would be quoted. Nothing here is a
 * credential — the headers are an explicit allow-list of rate values and a request id.
 *
 * An over-window 400 carries **none** of the rate headers, only a request id, so their appearing at
 * all is itself a sign the response came off the rate-limiting path rather than the window check.
 */
export function describeGroqRejection(observed: GroqRejection): string {
  const arms = observed.matchedArms.length > 0 ? observed.matchedArms.join(' | ') : '(none)';
  const headers = Object.entries(observed.rateLimit)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  return (
    `status=${observed.status ?? 'none'} category=${observed.category} ` +
    `code=${observed.bodyCode ?? 'none'} param=${observed.bodyParam ?? 'none'} ` +
    `arms=[${arms}] sentence=${JSON.stringify(observed.bodyMessage)}` +
    (headers.length > 0 ? ` ${headers}` : '')
  );
}

/** Whether the body says the model itself is gone, rather than that the input was too long. */
function modelIsGone(observed: GroqRejection): boolean {
  if (observed.bodyCode === 'model_decommissioned') return true;
  return /decommission|no longer supported|does not exist/i.test(observed.bodyMessage);
}

/**
 * Assert that this rejection was classified by {@link LOAD_BEARING_ARM} and by nothing else that
 * could have stood in for it. Throws with a diagnostic naming the case; returns nothing on success.
 *
 * The branches are ordered so the failure message distinguishes causes with **different urgency**,
 * because a single `toContain` reds identically for all of them and leaves the reader to guess:
 *
 * - the canary's model is gone — a maintenance chore, not a groq rewording;
 * - the rejection was a rate limit rather than an overflow — the canary measured nothing, and
 *   must not be read as evidence either way;
 * - groq reworded and **nothing** classifies it — urgent: production has silently stopped
 *   compacting on groq;
 * - groq reworded but another arm now carries it — informational: compaction still works, and the
 *   arm this guards is no longer load-bearing;
 * - the sentence is still there but no production arm matched it — the arm was removed from the
 *   pattern list. This is the branch the arm-removal control lands on.
 */
export function assertLoadBearingArmFired(observed: GroqRejection): void {
  const detail = describeGroqRejection(observed);
  const sentencePresent = observed.bodyMessage.toLowerCase().includes(LOAD_BEARING_ARM);
  const armFired = observed.matchedArms.includes(LOAD_BEARING_ARM);
  const tpmArmFired = observed.matchedArms.includes(TPM_ARM);

  if (modelIsGone(observed)) {
    throw new Error(
      `[[EXT-169]] MAINTENANCE, not a groq rewording: the canary model no longer exists, so this ` +
        `run measured nothing about the overflow arm. Pick another small-window groq model and set ` +
        `GROQ_CANARY_MODEL (or change the default). ${detail}`
    );
  }

  if (tpmArmFired && !armFired) {
    throw new Error(
      `[[EXT-169]] REJECTED: this rejection was classified by the '${TPM_ARM}' arm — a groq TPM ` +
        `rate rejection, not a context overflow. It classifies as context_overflow all the same, ` +
        `which is exactly why this canary may not accept it: doing so would let a busy account ` +
        `hide a broken overflow arm. Re-run when the account is quiet. ${detail}`
    );
  }

  if (observed.status !== OVERFLOW_STATUS) {
    throw new Error(
      `[[EXT-169]] REJECTED: expected the over-window rejection to be an HTTP ${OVERFLOW_STATUS}, ` +
        `got ${observed.status ?? 'no status'}. A 429 or 413 here is a rate or size limit rather ` +
        `than an overflow, so the run proves nothing about the arm. ${detail}`
    );
  }

  if (!sentencePresent && observed.matchedArms.length === 0) {
    throw new Error(
      `[[EXT-169]] URGENT — groq reworded its over-window message and NOTHING in the ` +
        `context-overflow pattern list matches it. Production is now classifying a groq context ` +
        `overflow as invalid_request, which the runner never compacts: a groq run stops instead of ` +
        `compacting, with nothing red and nothing logged. Add an arm for the sentence below. ` +
        `${detail}`
    );
  }

  if (!sentencePresent) {
    throw new Error(
      `[[EXT-169]] INFORMATIONAL — groq reworded its over-window message, but another arm still ` +
        `classifies it, so compaction still works. The arm this canary guards is no longer what ` +
        `carries groq, so update the arm and the node rather than treating this as an outage. ` +
        `${detail}`
    );
  }

  if (!armFired) {
    throw new Error(
      `[[EXT-169]] the sentence groq sent still contains '${LOAD_BEARING_ARM}', but no production ` +
        `arm matched it — the arm has been removed from or altered in the context-overflow pattern ` +
        `list. Restore it: without it an uncoded groq overflow is an invalid_request, never ` +
        `compacted. ${detail}`
    );
  }

  if (tpmArmFired) {
    throw new Error(
      `[[EXT-169]] ambiguous: '${TPM_ARM}' matched this body as well, so the classification cannot ` +
        `be attributed to '${LOAD_BEARING_ARM}' alone. ${detail}`
    );
  }

  if (observed.category !== 'context_overflow') {
    throw new Error(
      `[[EXT-169]] the arm matched but the rejection did not classify as context_overflow — ` +
        `something ahead of the prose arms is deciding first. ${detail}`
    );
  }
}
