/**
 * [[EXT-189]] — **a provider that answers 200 from a prompt it quietly cut down.**
 *
 * The whole difficulty of this behaviour is that the truncated call and the ordinary call are the
 * same shape: both return 200, both carry a usage envelope, both produce a plausible answer. A
 * detector that fires on the truncated one proves nothing on its own — so every cell here that
 * asserts a detection is paired with the **same payload on an endpoint that did not truncate**, and
 * that pair is the point of the file.
 *
 * The numbers are not invented. They are the live 2026-09-17 probe run, one identical
 * 35,991-character payload sent to seven endpoints; `estimatePromptTokens` reads that payload as a
 * floor of 35,991 / {@link ESTIMATE_CHARS_PER_TOKEN} = 10,283 tokens. The honest row is the one that
 * matters most: the same bytes to a 128,000-token endpoint came back reporting **21,912** input
 * tokens — MORE than the estimate, because the payload tokenises far worse than this module
 * assumes — which is the case a naive ratio detector gets wrong.
 */
import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  ESTIMATE_CHARS_PER_TOKEN,
  ESTIMATE_SAFETY_MARGIN,
  SILENT_TRUNCATION_MIN_ESTIMATE_TOKENS,
  estimatePromptTokens,
  promptTokensLookTruncated,
} from '#src/core/GthLangChainAgent.js';

/** The probe payload's size in characters — one payload, every endpoint below. */
const PAYLOAD_CHARACTERS = 35991;

/** What this module estimates that payload at, before the safety margin. */
const PAYLOAD_FLOOR_ESTIMATE = PAYLOAD_CHARACTERS / ESTIMATE_CHARS_PER_TOKEN;

/**
 * The measured run. `reported` is `usage.prompt_tokens` off the live 200 response, which
 * `@langchain/openrouter` maps verbatim onto `usage_metadata.input_tokens`.
 */
const MEASURED = {
  truncated: [
    { id: 'openai/gpt-3.5-turbo-0613', window: 4095, reported: 2363 },
    { id: 'undi95/remm-slerp-l2-13b', window: 6144, reported: 3571 },
    { id: 'gryphe/mythomax-l2-13b', window: 8192, reported: 4749 },
    { id: 'sao10k/l3-lunaris-8b', window: 8192, reported: 4777 },
    { id: 'deepseek/deepseek-r1-distill-llama-70b', window: 8192, reported: 4865 },
  ],
  /** Truncated in fact, but NOT detected — recorded as a known limit, not an oversight. */
  undetected: { id: 'google/gemma-2-27b-it', window: 8192, reported: 6508 },
  /** The negative control: the same bytes, no truncation, a 200 reporting the true size. */
  honest: { id: 'openai/gpt-4o-mini', window: 128000, reported: 21912 },
} as const;

/** A conversation whose only human turn is the probe payload, answered with a reported size. */
function conversationReporting(inputTokens: number): BaseMessage[] {
  return [
    new HumanMessage('x'.repeat(PAYLOAD_CHARACTERS)),
    new AIMessage({
      content: 'answered',
      usage_metadata: {
        input_tokens: inputTokens,
        output_tokens: 1,
        total_tokens: inputTokens + 1,
      },
    }),
  ];
}

describe('EXT-189 silent prompt truncation', () => {
  describe('the detector', () => {
    it.each(MEASURED.truncated)(
      'fires on $id, which reported $reported of an estimated 10283 tokens',
      ({ reported }) => {
        expect(promptTokensLookTruncated(PAYLOAD_FLOOR_ESTIMATE, reported)).toBe(true);
      }
    );

    // THE CONTROL. Same payload, same estimate, an endpoint that did not truncate. A detector that
    // fired here would fire on every large ordinary call and be worth nothing; this is the cell that
    // makes the five above mean something.
    it('stays silent on the same payload where nothing was truncated', () => {
      expect(promptTokensLookTruncated(PAYLOAD_FLOOR_ESTIMATE, MEASURED.honest.reported)).toBe(
        false
      );
      // ...and it is not a near miss: the honest call reported MORE than was estimated.
      expect(MEASURED.honest.reported).toBeGreaterThan(PAYLOAD_FLOOR_ESTIMATE);
    });

    it('does not fire on the one measured endpoint whose tokeniser hides the loss', () => {
      // Recorded so a later reader can tell "known and bounded" from "never noticed": this endpoint
      // DID truncate, and this predicate cannot see it. Raising the threshold to catch it would
      // spend the margin the control above depends on.
      expect(promptTokensLookTruncated(PAYLOAD_FLOOR_ESTIMATE, MEASURED.undetected.reported)).toBe(
        false
      );
    });

    it('says nothing about a prompt too small to judge', () => {
      const tiny = SILENT_TRUNCATION_MIN_ESTIMATE_TOKENS - 1;
      expect(promptTokensLookTruncated(tiny, 1)).toBe(false);
      // The same ratio above the floor is judged, so the cell above pins the FLOOR and not the ratio.
      expect(promptTokensLookTruncated(SILENT_TRUNCATION_MIN_ESTIMATE_TOKENS, 1)).toBe(true);
    });

    it('treats an absent or nonsensical count as no evidence', () => {
      expect(promptTokensLookTruncated(PAYLOAD_FLOOR_ESTIMATE, 0)).toBe(false);
      expect(promptTokensLookTruncated(PAYLOAD_FLOOR_ESTIMATE, Number.NaN)).toBe(false);
      expect(promptTokensLookTruncated(Number.NaN, 2363)).toBe(false);
    });
  });

  describe('the estimate refuses a truncated provider count as its anchor', () => {
    it('ignores the reported size and extrapolates from characters instead', () => {
      const messages = conversationReporting(MEASURED.truncated[0].reported);
      const estimate = estimatePromptTokens(messages);
      // Anchoring on 2,363 would have produced roughly that number plus the answer; refusing it
      // estimates the whole conversation from its characters, which is ~4x larger and is what keeps
      // the pre-call guard firing for the rest of the session.
      const wholeConversationCharacters = PAYLOAD_CHARACTERS + 'answered'.length;
      expect(estimate).toBe(
        Math.ceil((wholeConversationCharacters / ESTIMATE_CHARS_PER_TOKEN) * ESTIMATE_SAFETY_MARGIN)
      );
      expect(estimate).toBeGreaterThan(MEASURED.truncated[0].reported * 4);
    });

    // THE CONTROL for the cell above: an honest count on an identical conversation IS used, so the
    // assertion is about truncation and not about the estimator having stopped anchoring at all.
    it('still anchors on an honest count for the same conversation', () => {
      const messages = conversationReporting(MEASURED.honest.reported);
      const estimate = estimatePromptTokens(messages);
      expect(estimate).toBe(
        Math.ceil(
          (MEASURED.honest.reported + 'answered'.length / ESTIMATE_CHARS_PER_TOKEN) *
            ESTIMATE_SAFETY_MARGIN
        )
      );
    });

    it('falls back to an earlier honest anchor rather than to no anchor at all', () => {
      const half = 'y'.repeat(PAYLOAD_CHARACTERS);
      const messages: BaseMessage[] = [
        new HumanMessage(half),
        new AIMessage({
          content: 'first',
          usage_metadata: { input_tokens: 12000, output_tokens: 1, total_tokens: 12001 },
        }),
        new HumanMessage(half),
        new AIMessage({
          content: 'second',
          usage_metadata: { input_tokens: 2363, output_tokens: 1, total_tokens: 2364 },
        }),
      ];
      const estimate = estimatePromptTokens(messages);
      // The 2,363 is refused; the honest 12,000 two messages earlier is used, and only what followed
      // it is extrapolated.
      const afterAnchor = 'first'.length + PAYLOAD_CHARACTERS + 'second'.length;
      expect(estimate).toBe(
        Math.ceil((12000 + afterAnchor / ESTIMATE_CHARS_PER_TOKEN) * ESTIMATE_SAFETY_MARGIN)
      );
    });
  });
});
