/**
 * EXT-161 — **where a context window comes from, and which source wins when they disagree.**
 *
 * The ruled order is ollama, then models.dev, then the LangChain profile, then nothing. The
 * disagreement cells are the ones that carry weight: two sources AGREEING proves nothing about
 * precedence, so every precedence test here feeds deliberately conflicting numbers and asserts
 * which one lands.
 *
 * The tail of the file pins the contract the whole feature rests on — **an unknown window resolves
 * to `null`, never to a guess** — as a discriminating pair (a known window resolves to a number in
 * the same harness), so a miswired harness cannot pass it by answering `null` to everything.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_WINDOW_ORIGIN_LABELS,
  readProfileContextWindow,
  resolveContextWindow,
  resolveContextWindowSource,
  UNKNOWN_CONTEXT_WINDOW,
} from '#src/core/contextWindow.js';
import { getDebugLogBuffer } from '#src/utils/debugUtils.js';
import type { ProviderCatalog } from '#src/providers/modelCatalog.js';

/** A models.dev slice carrying one model id at one context limit. */
const catalogWith = (models: Record<string, number>): ProviderCatalog => ({
  providerId: 'anthropic',
  providerKey: 'anthropic',
  fetchedAt: Date.now(),
  models: Object.fromEntries(
    Object.entries(models).map(([id, context]) => [id, { limit: { context } }])
  ),
});

/** A chat model that reports a LangChain profile window, and nothing else. */
const modelWithProfile = (maxInputTokens: number): unknown => ({ profile: { maxInputTokens } });

/**
 * Run `work` and hand back its result together with the debug-log lines it appended.
 *
 * Read off the REAL ring buffer rather than a mocked `debugLog`, because the buffer is the thing
 * the claim is about: `debugUtils.ts` fills it whether or not debug logging is switched on, and
 * `/debug-dump` (GS2-46) serialises it verbatim, so a line that reaches it is a line a maintainer
 * can actually get at. A mocked `debugLog` would pin only that some function was called, which is
 * true of a signal wired to a surface nobody reads.
 *
 * The slice is taken from the length recorded BEFORE the call, so the assertion is about the lines
 * this resolution emitted and never about buffer contents some earlier cell left behind.
 */
const withDebugLines = async <T>(
  work: () => Promise<T>
): Promise<{ result: T; lines: string[] }> => {
  const before = getDebugLogBuffer().length;
  const result = await work();
  return { result, lines: getDebugLogBuffer().slice(before) };
};

/** The empty-resolution signal, matched on its opening words rather than the whole sentence. */
const EMPTY_RESOLUTION_SIGNAL = /Context window unknown for provider/;

/** Just the signal lines out of a debug-log slice. */
const signalsIn = (lines: string[]): string[] =>
  lines.filter((line) => EMPTY_RESOLUTION_SIGNAL.test(line));

describe('EXT-161 — models.dev outranks the LangChain profile (RULED)', () => {
  it('takes the catalog number when the two DISAGREE', async () => {
    // The measured case this ruling exists for: `@langchain/deepseek`'s own table reports a
    // 1,000,000-token window for `deepseek-chat`. A profile is a table compiled into a provider
    // package and moves only when that package is republished; the catalog refreshes on a 24h TTL.
    // So the profile can be wrong as well as absent, and wrong-and-confident means no preventive
    // compaction at all — exactly what this node exists to prevent.
    const catalogReader = vi.fn(async () => catalogWith({ 'deepseek-chat': 128_000 }));
    const reading = await resolveContextWindow(modelWithProfile(1_000_000), {
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      catalogReader,
    }).read();

    expect(reading).toEqual({ tokens: 128_000, origin: 'models.dev' });
    // Naming the loser explicitly: a test asserting only `128000` would still pass if the profile
    // tier had been deleted rather than outranked.
    expect(readProfileContextWindow(modelWithProfile(1_000_000))).toBe(1_000_000);
  });

  it('falls through to the profile when the catalog has no entry for the model', async () => {
    const catalogReader = vi.fn(async () => catalogWith({ 'some-other-model': 128_000 }));
    const reading = await resolveContextWindow(modelWithProfile(64_000), {
      providerId: 'anthropic',
      modelId: 'a-model-the-catalog-never-heard-of',
      catalogReader,
    }).read();
    expect(reading).toEqual({ tokens: 64_000, origin: 'profile' });
  });

  it('falls through to the profile when the catalog is unavailable altogether', async () => {
    // Offline, on-prem no-egress, or a cold cache: `getProviderCatalog` degrades to null and the
    // backstop takes over rather than the resolution failing.
    const catalogReader = vi.fn(async () => null);
    const reading = await resolveContextWindow(modelWithProfile(64_000), {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      catalogReader,
    }).read();
    expect(reading).toEqual({ tokens: 64_000, origin: 'profile' });
  });

  it('survives a catalog reader that throws, and still reaches the profile', async () => {
    const catalogReader = vi.fn(async () => {
      throw new Error('models.dev exploded');
    });
    const reading = await resolveContextWindow(modelWithProfile(64_000), {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      catalogReader,
    }).read();
    expect(reading).toEqual({ tokens: 64_000, origin: 'profile' });
  });

  it('never reaches the network from the runtime path: the catalog read is cache-only', async () => {
    // The resolution sits in front of the first model call of a session, and a cold fetch there is
    // bounded only by the catalog timeout — fast on a good link, and on a poor one experienced as
    // the agent hanging before it said anything. It would also write the slice into the user's home
    // from a unit run.
    const catalogReader = vi.fn(async () => catalogWith({ 'claude-sonnet-4-5': 200_000 }));
    await resolveContextWindow(undefined, {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      catalogReader,
    }).read();
    expect(catalogReader).toHaveBeenCalledWith(
      'anthropic',
      expect.objectContaining({ cacheOnly: true })
    );
  });

  it('lets an explicit caller opt back into fetching (this is what `gth init` does)', async () => {
    const catalogReader = vi.fn(async () => catalogWith({ 'claude-sonnet-4-5': 200_000 }));
    await resolveContextWindow(undefined, {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      catalogReader,
      catalogOptions: { cacheOnly: false },
    }).read();
    expect(catalogReader).toHaveBeenCalledWith(
      'anthropic',
      expect.objectContaining({ cacheOnly: false })
    );
  });
});

describe('EXT-161 — ollama outranks both, because it is the number the request carries', () => {
  it('takes num_ctx over a catalog entry and a profile that both disagree', async () => {
    const ollama = {
      _llmType: () => 'ollama',
      numCtx: 16_384,
      profile: { maxInputTokens: 999_999 },
    };
    const catalogReader = vi.fn(async () => catalogWith({ 'gemma4:12b': 262_144 }));
    const reading = await resolveContextWindow(ollama, {
      providerId: 'ollama',
      modelId: 'gemma4:12b',
      catalogReader,
    }).read();

    expect(reading).toEqual({ tokens: 16_384, origin: 'ollama' });
    // models.dev deliberately has no ollama entry, so the catalog must not even be consulted.
    expect(catalogReader).not.toHaveBeenCalled();
  });
});

describe('EXT-161 — an unknown window is reported as unknown, and never guessed', () => {
  /**
   * **The discriminating pair.** "Unknown yields null" is an assertion about ABSENCE and would pass
   * against a harness that resolved nothing at all, so the known case runs in the same harness and
   * must produce a number.
   */
  it('resolves a number when a source knows, and null when none does', async () => {
    const catalogReader = vi.fn(async () => catalogWith({ known: 200_000 }));

    const known = await resolveContextWindow(undefined, {
      providerId: 'anthropic',
      modelId: 'known',
      catalogReader,
    }).read();
    const unknown = await resolveContextWindow(undefined, {
      providerId: 'anthropic',
      modelId: 'unknown',
      catalogReader,
    }).read();

    expect(known).toEqual({ tokens: 200_000, origin: 'models.dev' });
    expect(unknown).toEqual({ tokens: null, origin: 'unknown' });
  });

  it('never answers 4097, the value LangChain guesses for a model it does not recognise', async () => {
    // The whole reason there is no `?? DEFAULT` on this path: `fraction: 0.8` over a 4097 default
    // compacts at roughly 3.3k tokens, silently, on any model outside the table.
    //
    // The catalog reader is injected — a slice that has never heard of the model — so this cell
    // reads the catalog tier and still gets no number, and never touches the developer's real
    // `~/.gsloth/model-catalog/` the way the default reader would.
    const catalogReader = vi.fn(async () => catalogWith({ 'some-other-model': 128_000 }));
    const reading = await resolveContextWindow(
      {},
      { providerId: 'openai', modelId: 'nope', catalogReader }
    ).read();
    expect(catalogReader).toHaveBeenCalledTimes(1);
    expect(reading.tokens).toBeNull();
    expect(reading.tokens).not.toBe(4097);
  });

  it.each([
    ['a model with no profile at all', {}],
    ['undefined', undefined],
    ['a profile with no maxInputTokens', { profile: {} }],
    ['a profile whose window is zero', { profile: { maxInputTokens: 0 } }],
    ['a profile whose window is negative', { profile: { maxInputTokens: -1 } }],
    [
      'a profile getter that throws',
      {
        get profile(): never {
          throw new Error('nope');
        },
      },
    ],
  ])('reads no window from %s', (_label, llm) => {
    expect(readProfileContextWindow(llm)).toBeNull();
  });

  it('keeps UNKNOWN_CONTEXT_WINDOW answering null', async () => {
    expect(await UNKNOWN_CONTEXT_WINDOW()).toBeNull();
  });

  it('describes every origin, so /status can never print a bare enum value', () => {
    for (const origin of ['ollama', 'models.dev', 'profile', 'unknown'] as const) {
      expect(CONTEXT_WINDOW_ORIGIN_LABELS[origin]).toMatch(/\S/);
    }
  });
});

/**
 * [[EXT-168]] — **an empty resolution is the one outcome that used to leave no trace at all.**
 *
 * The fixtures are the measured groq case rather than invented ids, because that is what makes the
 * branch reachable rather than theoretical: `@langchain/groq`'s profile table carries 17 ids, of
 * which only the two `openai/gpt-oss-*` are still served, so a live model like `allam-2-7b` has no
 * backstop entry — and the models.dev tier above it is read cache-only at runtime, so an unfilled
 * catalog cache is enough to leave both tiers empty.
 *
 * Every cell here is paired with a control in which a source DOES resolve, because "a line was
 * logged" is an assertion about presence and would pass just as well against an emission that fired
 * on every resolution — at which point it would say nothing about whether the window was known.
 */
describe('EXT-168 — an empty resolution says so, instead of going quiet', () => {
  it('logs the provider, the model and the consequence when NO source knows the window', async () => {
    // A cold catalog slice that has heard of a different model: the cache-miss shape, not an outage.
    const catalogReader = vi.fn(async () => catalogWith({ 'openai/gpt-oss-120b': 131_072 }));
    const { result, lines } = await withDebugLines(() =>
      resolveContextWindow({}, { providerId: 'groq', modelId: 'allam-2-7b', catalogReader }).read()
    );

    expect(result).toEqual({ tokens: null, origin: 'unknown' });
    const signals = signalsIn(lines);
    expect(signals).toHaveLength(1);
    // Both identifiers, and they are distinct strings — a line carrying only the model id would not
    // tell a maintainer which provider's tables to go and look at.
    expect(signals[0]).toContain('groq');
    expect(signals[0]).toContain('allam-2-7b');
    // The consequence, which is the part that makes the line worth reading: nothing will fire.
    expect(signals[0]).toMatch(/no preventive compaction threshold will be derived/);
  });

  it('CONTROL: stays quiet when models.dev resolves the window', async () => {
    const catalogReader = vi.fn(async () => catalogWith({ 'allam-2-7b': 4096 }));
    const { result, lines } = await withDebugLines(() =>
      resolveContextWindow({}, { providerId: 'groq', modelId: 'allam-2-7b', catalogReader }).read()
    );

    expect(result).toEqual({ tokens: 4096, origin: 'models.dev' });
    expect(signalsIn(lines)).toEqual([]);
  });

  it('CONTROL: stays quiet when the profile backstop resolves the window', async () => {
    // The two ids that still have a groq profile entry are exactly the case this control stands
    // for: models.dev missed, the backstop caught it, and nothing is wrong.
    const catalogReader = vi.fn(async () => catalogWith({ 'some-other-model': 131_072 }));
    const { result, lines } = await withDebugLines(() =>
      resolveContextWindow(modelWithProfile(131_072), {
        providerId: 'groq',
        modelId: 'openai/gpt-oss-120b',
        catalogReader,
      }).read()
    );

    expect(result).toEqual({ tokens: 131_072, origin: 'profile' });
    expect(signalsIn(lines)).toEqual([]);
  });

  it('says it ONCE a session, not before every model call', async () => {
    // The resolution is memoised and the guard reads it before every model call, so an emission
    // that escaped the memo would fill the ring buffer that `/debug-dump` exists to hand over.
    const catalogReader = vi.fn(async () => catalogWith({}));
    const resolved = resolveContextWindow(
      {},
      { providerId: 'groq', modelId: 'allam-2-7b', catalogReader }
    );
    const { lines } = await withDebugLines(async () => {
      await Promise.all([resolved.source(), resolved.source(), resolved.read(), resolved.read()]);
    });

    expect(signalsIn(lines)).toHaveLength(1);
  });
});

describe('EXT-161 — one resolution, shared by the guard and /status', () => {
  it('asks the catalog once however many times either reader is called', async () => {
    const catalogReader = vi.fn(async () => catalogWith({ m: 200_000 }));
    const resolved = resolveContextWindow(undefined, {
      providerId: 'anthropic',
      modelId: 'm',
      catalogReader,
    });

    const [a, b, c, d] = await Promise.all([
      resolved.source(),
      resolved.source(),
      resolved.read(),
      resolved.read(),
    ]);

    expect(catalogReader).toHaveBeenCalledTimes(1);
    expect([a, b]).toEqual([200_000, 200_000]);
    // The two readers cannot disagree, because they share the one memoised promise — a `/status`
    // describing a threshold the guard is not enforcing is the failure this shape rules out.
    expect(c).toEqual(d);
    expect(c.tokens).toBe(a);
  });

  it('resolveContextWindowSource is the same resolution with the provenance dropped', async () => {
    const catalogReader = vi.fn(async () => catalogWith({ m: 200_000 }));
    const source = resolveContextWindowSource(undefined, {
      providerId: 'anthropic',
      modelId: 'm',
      catalogReader,
    });
    expect(await source()).toBe(200_000);
  });
});

/**
 * EXT-185 — **the cold-cache path, where the backstop decides alone.**
 *
 * The runtime reads the catalog cache-only, so on a machine whose slice was never filled tier 2
 * answers nothing and the profile table decides unchallenged — the one path where that table's
 * measured overstatements (up to 3.2x on this repo's pinned `@langchain/openrouter`) can set a
 * threshold nothing will ever cross.
 *
 * The number is RULED to stand: declining it would drop the window for every id whose profile entry
 * is right and change nothing for the wrong ones, which already fire no compaction. What the path
 * was missing is the signal, so these cells are about the signal.
 *
 * **Every cell here pairs with one that differs only in the temperature of the cache.** The reading
 * is identical on both sides — same tokens, same `profile` origin — so an assertion that could not
 * tell cold from warm would pass on both and pin nothing.
 */
describe('EXT-185 — a cold catalog cache says so when the profile decides', () => {
  /** The cold-cache signal, matched on the fact it asserts rather than on the whole sentence. */
  const COLD_CATALOG_SIGNAL = /no models\.dev slice is cached for/;
  const coldSignalsIn = (lines: string[]): string[] =>
    lines.filter((line) => COLD_CATALOG_SIGNAL.test(line));

  it('says so when the catalog is ABSENT and the profile supplies the window', async () => {
    // `null` from the reader is the cold cache exactly: `getProviderCatalog` under `cacheOnly`
    // returns what is on disk, and on a machine that has never run `gth init` or `gth models`
    // there is nothing on disk to return.
    const catalogReader = vi.fn(async () => null);
    const { result, lines } = await withDebugLines(() =>
      resolveContextWindow(modelWithProfile(262_000), {
        providerId: 'openrouter',
        modelId: 'qwen/qwen3-30b-a3b-thinking-2507',
        catalogReader,
      }).read()
    );

    expect(result).toEqual({ tokens: 262_000, origin: 'profile' });
    const signals = coldSignalsIn(lines);
    expect(signals).toHaveLength(1);
    // The three things that make the line worth reading: which number is in force, whose table it
    // came from, and the one command that puts the catalog back in front of it.
    expect(signals[0]).toContain('262000');
    expect(signals[0]).toContain('qwen/qwen3-30b-a3b-thinking-2507');
    expect(signals[0]).toMatch(/gth models --refresh/);
  });

  it('CONTROL: stays quiet when the catalog ANSWERED and simply has no row for the model', async () => {
    // The discriminating half. A warm catalog that does not cover this id reaches the profile by
    // the same branch and returns the same reading — so a signal that fired here would be telling
    // a user with a perfectly good cache to go and fill it.
    const catalogReader = vi.fn(async () => catalogWith({ 'some-other-model': 131_072 }));
    const { result, lines } = await withDebugLines(() =>
      resolveContextWindow(modelWithProfile(262_000), {
        providerId: 'openrouter',
        modelId: 'qwen/qwen3-30b-a3b-thinking-2507',
        catalogReader,
      }).read()
    );

    expect(result).toEqual({ tokens: 262_000, origin: 'profile' });
    expect(coldSignalsIn(lines)).toEqual([]);
  });

  it('CONTROL: stays quiet for a provider models.dev does not carry at all', async () => {
    // Reachable rather than hypothetical: ollama configured through its OpenAI-compatible shim
    // reports `openai` from `_llmType()`, so tier 1 is skipped and tier 2 is entered with
    // `providerId: 'ollama'` — for which `getProviderCatalog` returns null because there is no
    // models.dev slice to have, cache or no cache. Refreshing would never produce one.
    const catalogReader = vi.fn(async () => null);
    const { result, lines } = await withDebugLines(() =>
      resolveContextWindow(modelWithProfile(16_384), {
        providerId: 'ollama',
        modelId: 'gemma4:12b',
        catalogReader,
      }).read()
    );

    expect(result).toEqual({ tokens: 16_384, origin: 'profile' });
    expect(coldSignalsIn(lines)).toEqual([]);
  });

  it('leaves the empty-resolution line alone when nothing knows the model', async () => {
    // A cold cache AND no profile entry is the unknown case, which already has its own line. Two
    // lines for one resolution would make the ring buffer harder to read, not easier.
    const catalogReader = vi.fn(async () => null);
    const { result, lines } = await withDebugLines(() =>
      resolveContextWindow(
        {},
        {
          providerId: 'openrouter',
          modelId: 'qwen/qwen3-30b-a3b-thinking-2507',
          catalogReader,
        }
      ).read()
    );

    expect(result).toEqual({ tokens: null, origin: 'unknown' });
    expect(coldSignalsIn(lines)).toEqual([]);
    expect(signalsIn(lines)).toHaveLength(1);
  });

  it('says it once a session, not before every model call', async () => {
    const catalogReader = vi.fn(async () => null);
    const resolved = resolveContextWindow(modelWithProfile(262_000), {
      providerId: 'openrouter',
      modelId: 'qwen/qwen3-30b-a3b-thinking-2507',
      catalogReader,
    });
    const { lines } = await withDebugLines(async () => {
      await Promise.all([resolved.source(), resolved.source(), resolved.read(), resolved.read()]);
    });

    expect(coldSignalsIn(lines)).toHaveLength(1);
  });
});
