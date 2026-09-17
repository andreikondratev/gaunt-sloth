/**
 * [[EXT-164]] — **OpenRouter's context overflow, pinned to the bytes OpenRouter actually sends.**
 *
 * `ChatOpenRouter` extends `BaseChatModel` with its own `fetch` implementation and inherits none of
 * `@langchain/openai`'s error mapping, so nothing types its errors. Recorded live on 2026-09-17
 * through `@langchain/openrouter` 0.4.13 with deliberately-oversized requests.
 *
 * ## The fork the node asked to settle: it is a THROWN HTTP 400, not a 200 with an error body
 *
 * Measured on **both** request paths — `stream: false` and `stream: true` — an overflow comes back
 * as HTTP 400 with `content-type: application/json`, never as a 200 whose body carries an error and
 * never as an SSE `error` event. `@langchain/openrouter` throws on `!response.ok` alone, so the
 * catch-based seam is the right and only hook for this cause.
 *
 * The other half of the fork is pinned below as the **residual**: the package reads `data.choices[0]`
 * without looking at `data.error`, so a 200 carrying an error body surfaces as
 * `No choices returned in response.` with the whole payload discarded — classified `unknown`, which
 * has no remedy and is therefore never compacted. Nothing here makes that shape an overflow, because
 * it is not necessarily one.
 *
 * ## One router, three upstreams, three different sentences — and only one structured field
 *
 * | routed to      | via id                       | `metadata.provider_error_code` | classified before this node |
 * |----------------|------------------------------|--------------------------------|-----------------------------|
 * | OpenAI         | `openai/gpt-3.5-turbo`       | `context_length_exceeded`      | yes                         |
 * | Anthropic      | `anthropic/claude-haiku-4.5` | ABSENT                         | yes                         |
 * | Amazon Bedrock | `anthropic/claude-3-haiku`   | ABSENT                         | **no** — `invalid_request`  |
 *
 * That table is the node's thesis demonstrated by the router itself: the message text varies by
 * which upstream was routed to, and the two ids differing only in model name reached *different
 * vendors*. `anthropic/claude-3-haiku` is served on OpenRouter by Amazon Bedrock alone, whose
 * `Input is too long for requested model.` matched no arm at all.
 *
 * **OpenRouter's own fields are not a mechanism, and that is a measurement, not an opinion.** Its
 * top-level `message` is the constant `Provider returned error` and its `code` is `400` for every
 * provider-side failure alike, and it sets `provider_error_code` for only one of the three
 * upstreams. So the carrier is the UPSTREAM's prose, held verbatim in `metadata.raw` — the same
 * conclusion [[EXT-162]] reached for google and [[EXT-163]] for groq, reached a third time from a
 * third direction.
 *
 * ## Two things are pinned here, and they are different claims
 *
 * 1. **The arm** `'input is too long for'` closes the measured Bedrock gap. Delete it and only the
 *    Bedrock cells go red; the other two upstreams classify without it, which is what makes them the
 *    differential control rather than more of the same evidence.
 * 2. **The structured read** of `metadata` in `errorText` changes no classification today, and the
 *    cells that pin it say so by construction: they hold the metadata with the message stripped back
 *    to OpenRouter's bare `Provider returned error`. Today that text reaches the classifier anyway,
 *    because `OpenRouterError.fromResponse` appends ` | metadata: <json>` to the message — an
 *    upstream FORMATTING choice that `providerErrorNotice.ts` exists to undo on screen. If upstream
 *    stops appending it, every OpenRouter overflow silently becomes `invalid_request`. The canary
 *    below fails on the day that changes, instead of detection quietly reverting.
 *
 * No request is ever made: bodies are the recorded bytes, `fetch` is stubbed where a cell drives the
 * real model, and the API key is a placeholder. `user_id` and the upstream `request_id` are redacted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatOpenRouter, OpenRouterError } from '@langchain/openrouter';
import {
  classifyThrownTermination,
  contextOverflowPatternsMatching,
  isContextOverflow,
} from '#src/core/terminationReason.js';
import { PROVIDER_ERROR_METADATA_SEPARATOR } from '#src/core/providerErrorNotice.js';

/** Recorded 2026-09-17 — `openai/gpt-3.5-turbo`, 29666 tokens into a 16385-token window. */
const OPENAI_UPSTREAM_OVERFLOW = {
  error: {
    message: 'Provider returned error',
    code: 400,
    metadata: {
      raw:
        '{\n  "error": {\n    "message": "This model\'s maximum context length is 16385 tokens. ' +
        'However, your messages resulted in 29666 tokens. Please reduce the length of the ' +
        'messages.",\n    "type": "invalid_request_error",\n    "param": "messages",\n    ' +
        '"code": "context_length_exceeded"\n  }\n}',
      provider_name: 'OpenAI',
      is_byok: false,
      provider_error_code: 'context_length_exceeded',
    },
  },
  user_id: 'user_redacted',
};

/** Recorded 2026-09-17 — `anthropic/claude-haiku-4.5` pinned to the Anthropic provider. */
const ANTHROPIC_UPSTREAM_OVERFLOW = {
  error: {
    message: 'Provider returned error',
    code: 400,
    metadata: {
      raw:
        '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: ' +
        '254245 tokens > 200000 maximum"},"request_id":"req_redacted"}',
      provider_name: 'Anthropic',
      is_byok: false,
    },
  },
  user_id: 'user_redacted',
};

/**
 * Recorded 2026-09-17 — `anthropic/claude-3-haiku`, which OpenRouter serves from Amazon Bedrock and
 * nowhere else. The gap this node closes: no `provider_error_code`, and a sentence sharing no
 * substring with either of the other two.
 */
const BEDROCK_UPSTREAM_OVERFLOW = {
  error: {
    message: 'Provider returned error',
    code: 400,
    metadata: {
      raw: '{"message":"Input is too long for requested model."}',
      provider_name: 'Amazon Bedrock',
      is_byok: false,
    },
  },
  user_id: 'user_redacted',
};

/** Recorded 2026-09-17 — an ordinary OpenRouter 400: the model id does not exist. */
const UNKNOWN_MODEL_400 = {
  error: {
    message: 'openai/gpt-3.5-turbo-does-not-exist is not a valid model ID',
    code: 400,
  },
  user_id: 'user_redacted',
};

/** Recorded 2026-09-17 — a deliberately invalid key. Never the real one, and never asserted by value. */
const REJECTED_KEY_401 = { error: { message: 'User not found.', code: 401 } };

/** Recorded 2026-09-17 — a routing failure: the only provider serving the id was excluded. */
const ROUTING_404 = {
  error: {
    message:
      'No allowed providers are available for the selected model. Providers serving ' +
      "anthropic/claude-3-haiku: amazon-bedrock, but your request's provider.only preference " +
      'permits only: anthropic.',
    code: 404,
    metadata: {
      available_providers: ['amazon-bedrock'],
      requested_providers: ['anthropic'],
      routing_funnel: [{ step: 'Initial Endpoints', endpoint_count: 1 }],
      failed_routing_step: 'Filter by Allowed Providers',
    },
  },
};

/** The package's own factory, over the recorded bytes — never a hand-drawn imitation of its shape. */
function recorded(body: unknown, status: number): Promise<OpenRouterError> {
  return OpenRouterError.fromResponse(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  ) as Promise<OpenRouterError>;
}

const UPSTREAMS = [
  ['OpenAI', OPENAI_UPSTREAM_OVERFLOW] as const,
  ['Anthropic', ANTHROPIC_UPSTREAM_OVERFLOW] as const,
  ['Amazon Bedrock', BEDROCK_UPSTREAM_OVERFLOW] as const,
];

describe('[[EXT-164]] the measured shape — a thrown HTTP 400, on both request paths', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Drive the REAL `ChatOpenRouter` over a stubbed global fetch; nothing leaves the process. */
  async function invokeAgainst(status: number, body: unknown): Promise<unknown> {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
    const llm = new ChatOpenRouter({
      apiKey: 'stub-never-sent',
      model: 'openai/gpt-3.5-turbo',
      maxRetries: 0,
    });
    try {
      await llm.invoke('hi');
    } catch (error) {
      return error;
    }
    throw new Error('expected the model call to throw');
  }

  it('the 400 is thrown by the package and reaches the classifier as a context overflow', async () => {
    // End to end over the package's own request path: `!response.ok` -> `fromResponse` -> throw.
    const error = await invokeAgainst(400, OPENAI_UPSTREAM_OVERFLOW);
    expect(OpenRouterError.isInstance(error)).toBe(true);
    expect((error as OpenRouterError).statusCode).toBe(400);
    expect(classifyThrownTermination(error).category).toBe('context_overflow');
  });

  it('RESIDUAL: a 200 carrying an error body is not recoverable — the package discards the payload', async () => {
    // The other half of the node's fork. `_generate` reads `data.choices[0]` and never looks at
    // `data.error`, so an overflow reported inside a 200 arrives as a message that says nothing
    // about it. `unknown` has no remedy, so the compact-and-retry seam declines — correctly, on the
    // evidence it is given. Making this classify as an overflow would be a guess: a 200 with an
    // error body is not necessarily a context overflow.
    const error = await invokeAgainst(200, {
      id: 'gen-stub',
      object: 'chat.completion',
      error: { message: 'Provider returned error', code: 400, metadata: BEDROCK_UPSTREAM_OVERFLOW },
      choices: [],
    });
    expect((error as Error).message).toBe('No choices returned in response.');
    expect(isContextOverflow(error)).toBe(false);
    expect(classifyThrownTermination(error)).toEqual({
      category: 'unknown',
      detail: 'OpenRouterError',
    });
  });
});

describe('[[EXT-164]] every measured upstream classifies as a context overflow', () => {
  it.each(UPSTREAMS)('routed to %s', async (_provider, body) => {
    const error = await recorded(body, 400);
    expect(isContextOverflow(error)).toBe(true);
    expect(classifyThrownTermination(error)).toEqual({
      category: 'context_overflow',
      detail: 'OpenRouterError',
    });
  });

  it("OpenRouter's own fields are identical across all three and carry nothing", async () => {
    // The cell that says why prose is the mechanism here: strip the upstream envelope and the three
    // overflows are indistinguishable from each other AND from an unrelated 400.
    for (const [, body] of UPSTREAMS) {
      const error = await recorded(body, 400);
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe(400);
      expect(error.message.split(PROVIDER_ERROR_METADATA_SEPARATOR)[0]).toBe(
        'Provider returned error'
      );
    }
  });
});

describe('[[EXT-164]] the new arm is load-bearing for the Bedrock upstream alone', () => {
  it('Bedrock is carried by the new arm and by nothing else', async () => {
    // Delete `'input is too long for'` and this is the cell that goes red. Nothing structural could
    // have decided it: the response carries no `provider_error_code` at all.
    const error = await recorded(BEDROCK_UPSTREAM_OVERFLOW, 400);
    expect(contextOverflowPatternsMatching(error)).toEqual(['input is too long for']);
  });

  it.each([
    [
      'OpenAI',
      OPENAI_UPSTREAM_OVERFLOW,
      ['context_length_exceeded', 'maximum context length', 'reduce the length of the messages'],
    ] as const,
    ['Anthropic', ANTHROPIC_UPSTREAM_OVERFLOW, ['prompt is too long']] as const,
  ])(
    'CONTROL: %s classifies without the new arm, so its cells survive the deletion',
    async (_provider, body, arms) => {
      const error = await recorded(body, 400);
      expect(contextOverflowPatternsMatching(error)).toEqual(arms);
      expect(contextOverflowPatternsMatching(error)).not.toContain('input is too long for');
    }
  );

  it("the arm requires the continuation, so a tool's own input-length rejection is still a tool error", () => {
    // Why the arm is not the bare `'input is too long'`: `isContextOverflow` is consulted BEFORE
    // the `ToolException` arm, so the shorter form would send a tool's validation failure off to
    // history compaction. This is the boundary, asserted rather than assumed.
    const toolFailure = Object.assign(new Error('Input is too long, maximum 500 characters.'), {
      name: 'ToolException',
    });
    expect(isContextOverflow(toolFailure)).toBe(false);
    expect(classifyThrownTermination(toolFailure)).toEqual({
      category: 'tool_error',
      detail: 'ToolException',
    });
  });
});

describe('[[EXT-164]] the structured envelope, not the serialized message, is what detection rests on', () => {
  /**
   * The recorded metadata with the message cut back to what OpenRouter itself wrote — i.e. the same
   * error object upstream would throw if it stopped appending ` | metadata: <json>`.
   */
  function metadataOnly(body: typeof BEDROCK_UPSTREAM_OVERFLOW): OpenRouterError {
    return new OpenRouterError('Provider returned error', 400, 400, body.error.metadata, {});
  }

  it.each(UPSTREAMS)(
    'routed to %s: still classified with the metadata read off the object alone',
    (_provider, body) => {
      // Red when `errorText`'s read of `metadata` is removed; green on all three today, because
      // `fromResponse` happens to put the same text in the message. That difference is the point:
      // these cells pin the hardening, the recorded cells above pin today's behaviour.
      const error = metadataOnly(body);
      expect(error.message).not.toContain(PROVIDER_ERROR_METADATA_SEPARATOR);
      expect(isContextOverflow(error)).toBe(true);
      expect(classifyThrownTermination(error).category).toBe('context_overflow');
    }
  );

  it('CONTROL: the bare message with no metadata is an ordinary invalid request', () => {
    // Proves the cells above are carried by the metadata and not by `Provider returned error`.
    const error = new OpenRouterError('Provider returned error', 400, 400, undefined, {});
    expect(isContextOverflow(error)).toBe(false);
    expect(classifyThrownTermination(error)).toEqual({
      category: 'invalid_request',
      detail: '400',
    });
  });

  it('CANARY: upstream still appends the serialized metadata to the message', async () => {
    // Not a requirement — a dependency. While this holds, the metadata reaches the classifier twice
    // and the hardening above is redundant. When it stops holding, THIS cell is what says so,
    // instead of every OpenRouter overflow quietly reverting to `invalid_request`.
    const error = await recorded(BEDROCK_UPSTREAM_OVERFLOW, 400);
    expect(error.message).toContain(PROVIDER_ERROR_METADATA_SEPARATOR);
    expect(error.message).toContain('Input is too long for requested model.');
  });
});

describe('[[EXT-164]] ordinary openrouter errors are not overflows', () => {
  it('the recorded unknown-model 400 is an invalid request', async () => {
    const error = await recorded(UNKNOWN_MODEL_400, 400);
    expect(isContextOverflow(error)).toBe(false);
    expect(classifyThrownTermination(error)).toEqual({
      category: 'invalid_request',
      detail: '400',
    });
  });

  it('the recorded rejected-key 401 is an auth failure', async () => {
    const error = await recorded(REJECTED_KEY_401, 401);
    expect(isContextOverflow(error)).toBe(false);
    expect(classifyThrownTermination(error)).toEqual({ category: 'auth_failed', detail: '401' });
  });

  it('the recorded routing 404 is not an overflow — and is recorded as unclassified', async () => {
    // Pinned as MEASURED, not as desired. No arm covers a 404: it is past the 429/401/403/408/5xx
    // statuses, its prose matches nothing, and `status === 400` is false, so it lands on `unknown`.
    // That is a real gap in the taxonomy's status coverage, and it belongs to whoever owns the
    // taxonomy rather than to this node's detector.
    const error = await recorded(ROUTING_404, 404);
    expect(isContextOverflow(error)).toBe(false);
    expect(classifyThrownTermination(error)).toEqual({
      category: 'unknown',
      detail: 'OpenRouterError',
    });
  });
});
