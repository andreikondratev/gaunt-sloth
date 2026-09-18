/**
 * EXT-161 — **the threshold in force, and who decided it.**
 *
 * Three things can name the number, in order: the session (`/autocompact`), the `autocompact`
 * config key, and the window-derived default. This file pins that order with DISAGREEING values at
 * every step — two sources agreeing would prove nothing — and pins the two answers that must never
 * be a number: an unknown window with no absolute threshold, and the off switch.
 */
import { describe, expect, it } from 'vitest';
import {
  AutocompactController,
  DEFAULT_AUTOCOMPACT_SEED_FRACTION,
  resolveAutocompactConfig,
  seedAutocompactThreshold,
} from '#src/core/compactionThreshold.js';
import { parseTokenBudget, TokenBudgetError } from '#src/config/tokenBudget.js';
import type { ContextWindowReading } from '#src/core/contextWindow.js';
import { getDebugLogBuffer } from '#src/utils/debugUtils.js';

/** A stand-in for the session's one memoised window resolution. */
const windowOf = (reading: ContextWindowReading) => ({ read: async () => reading });

/** The guard's own default rule, as the wiring site supplies it: the window less the reserve. */
const RESERVE = 2048;
const defaultThreshold = (window: number) => window - Math.min(RESERVE, Math.floor(window * 0.25));

const controller = (config: unknown, reading: ContextWindowReading) =>
  new AutocompactController({
    config: resolveAutocompactConfig(config),
    window: windowOf(reading),
    defaultThreshold,
  });

const KNOWN: ContextWindowReading = { tokens: 200_000, origin: 'models.dev', check: 'checked' };
const UNKNOWN: ContextWindowReading = { tokens: null, origin: 'unknown', check: 'checked' };

/**
 * [[EXT-187]] — the cold-cache reading: the profile table decided alone, so the number is real and
 * nothing was in a position to contradict it. Same shape as {@link KNOWN} but for the provenance,
 * which is what makes it usable as the discriminating half of a pair.
 */
const UNCHECKED: ContextWindowReading = { tokens: 262_000, origin: 'profile', check: 'unchecked' };

/**
 * [[OPS-125]] — the debug-log lines this controller wrote while `work` ran.
 *
 * Slices the shared ring buffer rather than mocking `debugLog`, which is what
 * `contextWindowSources.spec.ts` does for EXT-168's signal: the buffer is the surface
 * `/debug-dump` actually reads, so a spec that asserted on a mock would pass over a line that
 * never reached a user.
 */
const withDebugLines = async <T>(
  work: () => Promise<T>
): Promise<{ result: T; lines: string[] }> => {
  const before = getDebugLogBuffer().length;
  const result = await work();
  return { result, lines: getDebugLogBuffer().slice(before) };
};

/**
 * The inert-budget signal, matched on its opening words rather than the whole sentence — the
 * wording is copy and will be edited; what this file pins is that the line fires exactly when the
 * state does.
 */
const INERT_BUDGET_SIGNAL = /The configured automatic-compaction threshold /;

/** Just this node's signal lines out of a debug-log slice. */
const budgetSignalsIn = (lines: string[]): string[] =>
  lines.filter((line) => INERT_BUDGET_SIGNAL.test(line));

describe('EXT-161 — reading the `autocompact` config key', () => {
  it('is ON when the key is absent (RULED: on by default)', () => {
    expect(resolveAutocompactConfig(undefined)).toEqual({ enabled: true, budget: null });
    expect(resolveAutocompactConfig(null)).toEqual({ enabled: true, budget: null });
  });

  it.each([
    ['false', false, { enabled: false, budget: null }],
    ['true', true, { enabled: true, budget: null }],
    ['{ enabled: false }', { enabled: false }, { enabled: false, budget: null }],
  ])('reads %s as %o', (_label, input, expected) => {
    expect(resolveAutocompactConfig(input)).toEqual(expected);
  });

  it.each([
    ['a count', 300000, 300000],
    ['a suffixed string', '300K', 300000],
    ['a fractional million', '0.9M', 900000],
    ['the object form', { threshold: '300K' }, 300000],
  ])('reads %s as a %s-token budget', (_label, input, tokens) => {
    expect(resolveAutocompactConfig(input)).toEqual({
      enabled: true,
      budget: { kind: 'tokens', tokens },
    });
  });

  it('reads a percentage as a fraction, unresolved until a window is known', () => {
    expect(resolveAutocompactConfig('80%')).toEqual({
      enabled: true,
      budget: { kind: 'fraction', fraction: 0.8 },
    });
  });

  it('raises the shared parser’s error for a malformed threshold, naming the text', () => {
    // NOT coerced, not defaulted: 2.0 is a breaking config line with no back-compat coercion, and
    // a threshold that silently became a number would be one the user cannot see.
    expect(() => resolveAutocompactConfig('300G')).toThrow(TokenBudgetError);
    expect(() => resolveAutocompactConfig({ threshold: 'nonsense' })).toThrow(/"nonsense"/);
  });
});

describe('EXT-161 — precedence: session, then config, then the derived default', () => {
  it('uses the window-derived default when nothing is configured', async () => {
    const status = await controller(undefined, KNOWN).status();
    expect(status).toMatchObject({
      enabled: true,
      thresholdTokens: defaultThreshold(200_000),
      thresholdOrigin: 'default',
      window: 200_000,
      windowOrigin: 'models.dev',
    });
  });

  it('lets a CONFIGURED threshold beat the derived default they disagree about', async () => {
    const status = await controller(50_000, KNOWN).status();
    // The default for this window is 197952; the config says 50000. The config must win, or the
    // key does nothing.
    expect(defaultThreshold(200_000)).not.toBe(50_000);
    expect(status.thresholdTokens).toBe(50_000);
    expect(status.thresholdOrigin).toBe('config');
  });

  it('lets a SESSION override beat a disagreeing config, and says so in the provenance', async () => {
    const c = controller(50_000, KNOWN);
    c.setSessionBudget(parseTokenBudget('300K'));
    const status = await c.status();

    expect(status.thresholdTokens).toBe(300_000);
    // The provenance must MOVE. A `/status` that still called a hand-typed number
    // config-derived would send the next diagnosis to the wrong place entirely.
    expect(status.thresholdOrigin).toBe('session');
    expect(c.sessionOverride).toEqual({ kind: 'tokens', tokens: 300_000 });
  });

  it('keeps a session override in force across repeated reads', async () => {
    // The guard asks before EVERY model call, so an override that decayed would silently revert.
    const c = controller(undefined, KNOWN);
    c.setSessionBudget(parseTokenBudget('120K'));
    for (let turn = 0; turn < 4; turn++) {
      expect(await c.threshold()).toBe(120_000);
    }
    expect((await c.status()).thresholdOrigin).toBe('session');
  });

  it('resolves a percentage against the window', async () => {
    const status = await controller('80%', KNOWN).status();
    expect(status.thresholdTokens).toBe(160_000);
    expect(status.thresholdOrigin).toBe('config');
    // The resolved config carries an ABSOLUTE number whichever form was written, so nothing
    // downstream has to know about the string.
    expect(typeof status.thresholdTokens).toBe('number');
  });

  it('lands the same absolute number whichever input form named it', async () => {
    const forms = [160000, '160000', '160K', '0.16M', '80%'];
    const resolved = await Promise.all(forms.map((form) => controller(form, KNOWN).threshold()));
    expect(resolved).toEqual([160_000, 160_000, 160_000, 160_000, 160_000]);
  });
});

describe('EXT-161 — the answers that must never be a number', () => {
  /**
   * **The discriminating pair the node asks for.** "An unknown window yields no trigger" is an
   * assertion about absence and would pass in a harness that resolved nothing at all, so the known
   * window runs through the same controller shape and must produce a number.
   */
  it('yields NO trigger for an unknown window, while a known one still yields a threshold', async () => {
    const unknown = await controller(undefined, UNKNOWN).status();
    const known = await controller(undefined, KNOWN).status();

    expect(unknown.thresholdTokens).toBeNull();
    expect(unknown.thresholdOrigin).toBe('none');
    // Never the LangChain guess.
    expect(unknown.thresholdTokens).not.toBe(4097);

    expect(known.thresholdTokens).toBe(defaultThreshold(200_000));
    expect(known.thresholdOrigin).toBe('default');
  });

  it('yields no trigger for a PERCENTAGE with no window — a share of nothing is not a number', async () => {
    expect(await controller('80%', UNKNOWN).threshold()).toBeNull();
  });

  it('still fires an ABSOLUTE threshold on a model whose window nobody knows', async () => {
    // The user named the number themselves, so it needs no window. This is the one case where an
    // unknown window still protects the session, and it is why the config key is worth having.
    const status = await controller('300K', UNKNOWN).status();
    expect(status.thresholdTokens).toBe(300_000);
    expect(status.thresholdOrigin).toBe('config');
    expect(status.window).toBeNull();
  });

  it('yields no trigger at all when the off switch is set, even with a known window', async () => {
    const status = await controller(false, KNOWN).status();
    expect(status.enabled).toBe(false);
    expect(status.thresholdTokens).toBeNull();
    expect(status.thresholdOrigin).toBe('none');
    // The window is still REPORTED — `/status` can say what the model holds even with compaction
    // off, which is what makes turning it back on an informed choice.
    expect(status.window).toBe(200_000);
  });

  it('off beats an explicitly configured threshold', async () => {
    const status = await controller({ enabled: false, threshold: '300K' }, KNOWN).status();
    expect(status.thresholdTokens).toBeNull();
  });

  it('REFUSES a session override while the off switch is set: nothing recorded, status unchanged', async () => {
    // RULED: `/autocompact 300K` under `autocompact: false` changes nothing. Recording the budget
    // would only make the next status describe a threshold that can never fire.
    for (const off of [false, { enabled: false, threshold: '300K' }]) {
      const c = controller(off, KNOWN);
      const before = await c.status();
      c.setSessionBudget(parseTokenBudget('300K'));
      expect(c.sessionOverride).toBeNull();
      expect(await c.status()).toEqual(before);
      expect((await c.status()).enabled).toBe(false);
    }
    // The discriminating half: the same call on a controller that is ON is recorded, so a
    // controller that ignored every setSessionBudget could not pass this cell.
    const on = controller(undefined, KNOWN);
    on.setSessionBudget(parseTokenBudget('300K'));
    expect(on.sessionOverride).toEqual({ kind: 'tokens', tokens: 300_000 });
    expect((await on.status()).thresholdOrigin).toBe('session');
  });
});

describe('EXT-161 — the threshold `gth init` seeds', () => {
  it('is a fixed share of the resolved window, and tracks the window', () => {
    expect(seedAutocompactThreshold(200_000)).toBe(
      Math.floor(200_000 * DEFAULT_AUTOCOMPACT_SEED_FRACTION)
    );
    // Tracking is the point: a different model's window must seed a different number, or the seed
    // is a constant wearing a function's clothes.
    expect(seedAutocompactThreshold(500_000)).toBeGreaterThan(
      seedAutocompactThreshold(200_000) as number
    );
  });

  it.each([[null], [0], [-1], [Number.NaN]])('seeds nothing for the unusable window %s', (w) => {
    // Seeding a guess would put a number in the user's config that looks chosen and was not.
    expect(seedAutocompactThreshold(w as number | null)).toBeNull();
  });

  it('leaves room below the window for the answer', () => {
    const window = 200_000;
    expect(seedAutocompactThreshold(window) as number).toBeLessThan(window);
  });
});

/**
 * [[EXT-187]] — **the status carries the window's check state out to `/status`, on every branch.**
 *
 * The status is the only thing the surfaces see, so a reading that knows it was unchecked and a
 * status that drops the fact would leave this node's whole point inside core. Four branches leave
 * {@link AutocompactController.status}; a field added to three of them is the shape that goes
 * unnoticed, so all four are walked here.
 *
 * The other half of the node is the RULING that this file's arithmetic is blind to that state: an
 * unchecked window resolves a percentage exactly as a checked one does. That is asserted rather
 * than assumed, because "honour it as today" is a decision that looks identical to never having
 * considered the question.
 */
describe('EXT-187 — the check state reaches the status, and changes no number', () => {
  it.each([
    ['config off', false],
    ['a percentage budget', '80%'],
    ['an absolute budget', '300K'],
    ['nothing configured, so the derived default', undefined],
  ])('carries windowCheck through the %s branch', async (_label, config) => {
    expect((await controller(config, UNCHECKED).status()).windowCheck).toBe('unchecked');
    // The control: the same branch over a checked reading reports the other value, so a status that
    // hardcoded `'unchecked'` — or dropped the field and compared `undefined` to `undefined` — is
    // not what made the line above pass.
    expect((await controller(config, KNOWN).status()).windowCheck).toBe('checked');
  });

  it('RULED: resolves a percentage against an unchecked window exactly as against a checked one', async () => {
    // The node's real design question, pinned as behaviour. Refusing the budget here was the live
    // alternative; the argument for honouring it is at the `resolveTokenBudget` seam in
    // `compactionThreshold.ts`. What this cell forbids is the number quietly changing.
    const unchecked = await controller('80%', UNCHECKED).status();
    expect(unchecked.thresholdTokens).toBe(Math.floor(262_000 * 0.8));
    expect(unchecked.thresholdOrigin).toBe('config');
    expect(unchecked.enabled).toBe(true);

    // The discriminator, and the measurement this node was filed on: the same 80% over the window
    // models.dev actually reports for that id is a threshold less than a third the size. The
    // setting is honoured either way — the difference is one the user can now see, not one the
    // arithmetic makes for them.
    const real = await controller('80%', { ...UNCHECKED, tokens: 81_920 }).status();
    expect(real.thresholdTokens).toBe(Math.floor(81_920 * 0.8));
    expect(unchecked.thresholdTokens as number).toBeGreaterThan(
      3 * (real.thresholdTokens as number)
    );
  });
});

/**
 * [[OPS-125]] — **three states used to answer `thresholdOrigin: 'none'`, and one of them was a
 * user being ignored.**
 *
 * Every cell below is written as one of the three, because a single assertion that "the unknown
 * window yields no threshold" is satisfied by all three at once and is exactly the coverage that
 * let them collapse in the first place. What each cell has to show is that the state it names is
 * *different from the other two*, which is why the statuses are compared as the `(enabled,
 * thresholdOrigin)` pair a caller actually reads rather than one field at a time.
 *
 * The signal cells come in pairs for the reason EXT-168's do: "a line was written" is an assertion
 * about presence, and would pass just as well against an emission that fired on every status.
 */
describe('OPS-125 — an explicit budget that cannot resolve is its own state, and says so', () => {
  /** How a caller tells the three apart: the two fields together, never either alone. */
  const stateOf = (status: { enabled: boolean; thresholdOrigin: string }) =>
    `${status.enabled ? 'on' : 'off'}/${status.thresholdOrigin}`;

  it('CASE 1 — compaction switched off: no threshold, and the state says the user asked for that', async () => {
    const status = await controller({ enabled: false, threshold: '80%' }, UNKNOWN).status();
    expect(status.enabled).toBe(false);
    expect(status.thresholdTokens).toBeNull();
    expect(status.thresholdOrigin).toBe('none');
  });

  it('CASE 2 — nothing configured and no window: no threshold, and nobody asked for one', async () => {
    const status = await controller(undefined, UNKNOWN).status();
    expect(status.enabled).toBe(true);
    expect(status.thresholdTokens).toBeNull();
    expect(status.thresholdOrigin).toBe('none');
  });

  it('CASE 3 — a percentage against no window: no threshold, and the state says a setting was ignored', async () => {
    const status = await controller('80%', UNKNOWN).status();
    expect(status.enabled).toBe(true);
    expect(status.thresholdTokens).toBeNull();
    expect(status.thresholdOrigin).toBe('unresolved-budget');
    // The budget is still carried, so a surface can name what the user wrote back to them.
    expect(status.budget).toEqual({ kind: 'fraction', fraction: 0.8 });
  });

  it('gives the three DISTINCT states — the whole defect was that it did not', async () => {
    const states = await Promise.all(
      [
        controller({ enabled: false, threshold: '80%' }, UNKNOWN),
        controller(undefined, UNKNOWN),
        controller('80%', UNKNOWN),
      ].map(async (c) => stateOf(await c.status()))
    );
    expect(new Set(states).size).toBe(3);
    // The three configs differ only in the `autocompact` key, over one identical unknown-window
    // reading — so nothing but this module's own branching can be what separated them.
    expect(states).toEqual(['off/none', 'on/none', 'on/unresolved-budget']);
  });

  it('a SESSION `/autocompact 80%` against no window reaches the same state', async () => {
    // The config key is the silent path, but the command shares this seam, and a state that only
    // existed for one of them would be a second answer to the same question.
    const c = controller(undefined, UNKNOWN);
    c.setSessionBudget(parseTokenBudget('80%'));
    expect((await c.status()).thresholdOrigin).toBe('unresolved-budget');
  });

  it('an ABSOLUTE budget against no window is NOT this state — it still fires', async () => {
    // The asymmetry the state is about: a percentage needs the window, a count does not. A status
    // that labelled every budget over an unknown window as unresolved would be worse than `'none'`,
    // because it would report a threshold that IS enforced as ignored.
    const status = await controller('300K', UNKNOWN).status();
    expect(status.thresholdOrigin).toBe('config');
    expect(status.thresholdTokens).toBe(300_000);
  });

  it('changes NO number — the three states still yield no threshold, as ruled', async () => {
    // The node forbids widening what the threshold does. This is a labelling change, and a cell
    // that did not say so would let a later edit turn the new state into a fallback number.
    for (const config of [{ enabled: false, threshold: '80%' }, undefined, '80%']) {
      expect(await controller(config, UNKNOWN).threshold()).toBeNull();
    }
    // Never the LangChain guess, on any of them.
    expect(await controller('80%', UNKNOWN).threshold()).not.toBe(4097);
  });

  it('writes one debug line naming the setting and the consequence', async () => {
    const { lines } = await withDebugLines(() => controller('80%', UNKNOWN).status());
    const signals = budgetSignalsIn(lines);
    expect(signals).toHaveLength(1);
    // What the user wrote, read back in their own form — a line that did not name the setting
    // would not tell a maintainer which key is inert.
    expect(signals[0]).toContain('80%');
    // The consequence, which is what makes the line worth reading.
    expect(signals[0]).toMatch(/no preventive compaction will happen this session/);
    // The remedy that actually works here, and the fact that makes it the remedy.
    expect(signals[0]).toMatch(/absolute threshold needs no window/);
  });

  it('writes it ONCE, however many times the guard asks', async () => {
    // `threshold()` is read before every model call. An ungated line would be written per turn into
    // a 1000-entry ring buffer and would evict every other diagnostic in the session — and a spec
    // that read the status once could not tell.
    const c = controller('80%', UNKNOWN);
    const { lines } = await withDebugLines(async () => {
      for (let turn = 0; turn < 5; turn++) await c.threshold();
      await c.status();
    });
    expect(budgetSignalsIn(lines)).toHaveLength(1);
  });

  it('CONTROL: silent when the same percentage resolves normally', async () => {
    const { result, lines } = await withDebugLines(() => controller('80%', KNOWN).status());
    expect(result.thresholdTokens).toBe(160_000);
    expect(result.thresholdOrigin).toBe('config');
    expect(budgetSignalsIn(lines)).toEqual([]);
  });

  it('CONTROL: silent when compaction is simply OFF, even with a percentage configured', async () => {
    // **The regression a careless fix produces.** A user who set `enabled: false` asked for
    // silence; `{ enabled: false, threshold: "80%" }` carries case 3's exact config shape under
    // case 1's state, so a signal keyed on the budget alone — or on any rewrite that computes the
    // state before the off switch is consulted — fires here and takes the silence away.
    for (const off of [{ enabled: false, threshold: '80%' }, false]) {
      const { result, lines } = await withDebugLines(() => controller(off, UNKNOWN).status());
      expect(result.enabled).toBe(false);
      expect(result.thresholdOrigin).toBe('none');
      expect(budgetSignalsIn(lines)).toEqual([]);
    }
  });

  it('CONTROL: silent when nothing was configured — that line is EXT-168’s, not a second copy', async () => {
    // Case 2 is already reported once, by the window resolution itself. Saying it again from here
    // is the duplication the node ruled out, and it would arrive without the provider or the model
    // id that make the original line actionable.
    const { result, lines } = await withDebugLines(() => controller(undefined, UNKNOWN).status());
    expect(result.thresholdOrigin).toBe('none');
    expect(budgetSignalsIn(lines)).toEqual([]);
  });

  it('CONTROL: silent for an absolute budget over an unknown window', async () => {
    const { lines } = await withDebugLines(() => controller('300K', UNKNOWN).status());
    expect(budgetSignalsIn(lines)).toEqual([]);
  });
});
