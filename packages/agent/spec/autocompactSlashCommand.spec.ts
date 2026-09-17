/**
 * EXT-161 — `/autocompact` in the shared slash-command registry: registered beside `/compact`,
 * pure (it returns an effect and touches nothing), and reading the SAME parser the `autocompact`
 * config key validates with.
 *
 * The parser-sharing cell is the reason this command was specified in this node rather than in the
 * TUI cluster: the suffix grammar, the decimal K/M convention and the malformed-input rejection all
 * belong to one implementation, and two that merely agree on the day they are written drift
 * afterwards. It is therefore written to fail if either call site forks — see its docblock.
 */
import { describe, expect, it } from 'vitest';
import {
  autocompactLines,
  autocompactNotice,
  autocompactRejectedNotice,
  autocompactUnavailableNotice,
  createCommandRegistry,
  dispatchSlashCommand,
  parseSlashCommand,
  type SlashCommandContext,
} from '#src/modules/slashCommands.js';
import { parseTokenBudget, TokenBudgetError } from '@gaunt-sloth/core';
import {
  AutocompactController,
  resolveAutocompactConfig,
  type AutocompactStatus,
} from '@gaunt-sloth/core/core/compactionThreshold.js';

const ctx = (over: Partial<SlashCommandContext> = {}): SlashCommandContext => ({
  mode: 'chat',
  modelDisplayName: 'claude-sonnet-4-5',
  turnCount: 0,
  toolsExpanded: false,
  debugVisible: false,
  ...over,
});

const status = (over: Partial<AutocompactStatus> = {}): AutocompactStatus => ({
  enabled: true,
  thresholdTokens: 160_000,
  thresholdOrigin: 'config',
  window: 200_000,
  windowOrigin: 'models.dev',
  windowCheck: 'checked',
  budget: { kind: 'tokens', tokens: 160_000 },
  ...over,
});

const run = (line: string, context = ctx()) => {
  const parsed = parseSlashCommand(line);
  expect(parsed).not.toBeNull();
  return dispatchSlashCommand(parsed!, createCommandRegistry(), context, { duringRun: false });
};

describe('EXT-161 — /autocompact is registered and pure', () => {
  it('is in the shared registry, so both surfaces get it from one place', () => {
    const names = createCommandRegistry().map((c) => c.name);
    expect(names).toContain('autocompact');
    // Registered BESIDE /compact through the same surface, per the node — not in a second registry.
    expect(names.indexOf('autocompact')).toBe(names.indexOf('compact') + 1);
  });

  it('reports rather than erroring when given no argument', () => {
    const result = run('/autocompact');
    expect(result.autocompact).toEqual({ show: true });
    expect(result.notice).toBeUndefined();
  });

  it.each([
    ['/autocompact 300000', 300000],
    ['/autocompact 300K', 300000],
    ['/autocompact 0.9M', 900000],
    ['/autocompact 1.5k', 1500],
    ['/autocompact   300k  ', 300000],
    ['/autocompact 300 K', 300000],
  ])('%s asks for a %s-token threshold', (line, tokens) => {
    expect(run(line).autocompact).toEqual({ budget: { kind: 'tokens', tokens } });
  });

  it('accepts the percentage form, unresolved until the surface knows the window', () => {
    expect(run('/autocompact 80%').autocompact).toEqual({
      budget: { kind: 'fraction', fraction: 0.8 },
    });
  });

  it('is available mid-turn: it moves a number read before the NEXT call, not this one', () => {
    const parsed = parseSlashCommand('/autocompact 300K');
    const result = dispatchSlashCommand(parsed!, createCommandRegistry(), ctx(), {
      duringRun: true,
    });
    expect(result.autocompact).toEqual({ budget: { kind: 'tokens', tokens: 300000 } });
  });
});

describe('EXT-161 — a malformed argument leaves the threshold in force', () => {
  it.each(['/autocompact nonsense', '/autocompact 300G', '/autocompact -5', '/autocompact 0.8'])(
    '%s changes nothing and explains itself',
    (line) => {
      const result = run(line);
      // **No effect at all.** A typo must not switch a protection off: the user asked to change a
      // number, and a silent disable would only be discovered by an overflow much later.
      expect(result.autocompact).toBeUndefined();
      expect(result.notice?.title).toBe('Not a token budget');
      expect(result.notice?.tone).toBe('warn');
      expect(result.notice?.lines.join(' ')).toContain('unchanged');
    }
  );

  it('names the offending text back to the user', () => {
    expect(run('/autocompact 300G').notice?.lines.join(' ')).toContain('300G');
  });
});

/**
 * **The shared-parser cell.**
 *
 * Not "two parsers asserted to agree" — the command and the config key are driven over ONE input
 * table and their outcomes compared, acceptance for acceptance, rejection for rejection, and
 * resolved number for resolved number. A fork would have to reproduce the whole table, including
 * the exact rejection messages, to keep this green.
 */
describe('EXT-161 — the command and the config key share one parser', () => {
  const inputs = [
    '300000',
    '300K',
    '300k',
    '0.9M',
    '1.5k',
    '  300K  ',
    '80%',
    '12.5%',
    'nonsense',
    '300G',
    '0.8',
    '-5K',
    '0',
    '150%',
    '1e5',
  ];
  // The empty string is deliberately NOT in this table. It is a malformed value in a config file
  // and it is "no argument" on a command line, so the two call sites correctly differ there — the
  // one asymmetry the shared parser does not, and should not, remove. It is covered as its own
  // case below.

  it.each(inputs)('reads %j identically on both call sites', (input) => {
    // The config side, exactly as `resolveAutocompactConfig` reads the key.
    let configBudget: unknown;
    let configError: string | undefined;
    try {
      configBudget = resolveAutocompactConfig(input).budget;
    } catch (error) {
      configError = (error as TokenBudgetError).message;
    }

    // The command side, exactly as a user types it.
    const result = run(`/autocompact ${input}`.trimEnd());
    const commandBudget =
      result.autocompact && 'budget' in result.autocompact ? result.autocompact.budget : undefined;
    const commandError = result.notice?.lines[0];

    if (configError === undefined) {
      // Accepted on both sides, and to the same value.
      expect(commandBudget).toEqual(configBudget);
      expect(commandError).toBeUndefined();
    } else {
      // Rejected on both sides, with the SAME message — which is what a forked parser would have
      // to reproduce verbatim, rather than merely also failing.
      expect(commandBudget).toBeUndefined();
      expect(commandError).toBe(configError);
    }
  });

  it('a bare `/autocompact` reports, where an empty CONFIG value is malformed', () => {
    // The command's read half has no config counterpart, and an argument-less command line is not
    // an empty value — so this asymmetry is deliberate rather than a gap in the sharing.
    expect(run('/autocompact').autocompact).toEqual({ show: true });
    expect(run('/autocompact   ').autocompact).toEqual({ show: true });
    expect(resolveAutocompactConfig(undefined)).toEqual({ enabled: true, budget: null });
    expect(() => resolveAutocompactConfig('')).toThrow(TokenBudgetError);
  });

  it('rejects on the command side everything the parser itself rejects', () => {
    for (const bad of ['nonsense', '300G', '0.8', '-5K', '150%']) {
      expect(() => parseTokenBudget(bad)).toThrow(TokenBudgetError);
      expect(run(`/autocompact ${bad}`).autocompact).toBeUndefined();
    }
  });
});

describe('EXT-161 — what the notices say', () => {
  it('names the threshold, its provenance and the window it came from', () => {
    const lines = autocompactLines(status()).join(' ');
    expect(lines).toContain('160,000');
    expect(lines).toContain('200,000');
    expect(lines).toContain('models.dev');
  });

  it('says a session override came from the session, not from the config it replaced', () => {
    // A `/status` still calling a hand-typed number models.dev-derived would send the next
    // diagnosis to the wrong place entirely.
    const lines = autocompactLines(
      status({ thresholdOrigin: 'session', thresholdTokens: 300_000 })
    ).join(' ');
    expect(lines).toContain('/autocompact');
    expect(lines).toContain('overridden');
    expect(lines).not.toMatch(/from the `autocompact` key/);
  });

  it('says nothing will fire when the window is unknown, and offers the fix', () => {
    const lines = autocompactLines(
      status({
        thresholdTokens: null,
        thresholdOrigin: 'none',
        window: null,
        windowOrigin: 'unknown',
        budget: null,
      })
    ).join(' ');
    expect(lines).toContain('nothing will trigger it');
    expect(lines).toContain('/autocompact 300K');
    // Never the guess.
    expect(lines).not.toContain('4097');
  });

  it('says compaction is off when the off switch is set', () => {
    const lines = autocompactLines(
      status({ enabled: false, thresholdTokens: null, thresholdOrigin: 'none' })
    ).join(' ');
    expect(lines).toContain('OFF');
    expect(lines).toContain('autocompact: false');
  });

  it('reports a REFUSAL, never "threshold set", when a change is asked for with compaction off', () => {
    const off = status({
      enabled: false,
      thresholdTokens: null,
      thresholdOrigin: 'none',
      budget: null,
    });
    const notice = autocompactNotice(off, true);
    expect(notice.title).toBe('Automatic compaction is off in your config');
    expect(notice.tone).toBe('warn');
    const lines = notice.lines.join(' ');
    expect(lines).toContain('`autocompact` key in your config');
    expect(lines).toContain('Nothing was changed');
    expect(lines).not.toContain('rest of this session only');
    // No threshold in the config, so the remedy is the key itself.
    expect(lines).toContain('remove the key from your config or give it a threshold');
    expect(lines).not.toContain('already names a threshold');
    // The bare report under the same status is still a report of the OFF state, not a refusal.
    const shown = autocompactNotice(off, false);
    expect(shown.title).toBe('Automatic compaction');
    expect(shown.lines.join(' ')).toContain('OFF');
  });

  it('a changed threshold says it is session-only and where to make it permanent', () => {
    const notice = autocompactNotice(status({ thresholdOrigin: 'session' }), true);
    expect(notice.title).toBe('Automatic compaction threshold set');
    expect(notice.lines.join(' ')).toContain('rest of this session only');
    // A bare report must NOT claim anything was changed.
    expect(autocompactNotice(status(), false).lines.join(' ')).not.toContain(
      'rest of this session only'
    );
  });

  it('reports unavailability rather than inventing a number', () => {
    const notice = autocompactUnavailableNotice();
    expect(notice.tone).toBe('warn');
    expect(notice.lines.join(' ')).toContain('Nothing was changed');
  });

  it('the rejection notice shows the usage line', () => {
    expect(autocompactRejectedNotice('bad').lines.join(' ')).toContain('/autocompact [<tokens>]');
  });
});

/**
 * RULED: `/autocompact <N>` while the config has compaction off changes nothing and says so. The
 * real command, the real controller and the real notice, wired the way both surfaces wire them
 * (set, then read the status that landed), so the pin covers the seam and not a stubbed half of it.
 */
describe('EXT-161 — `/autocompact <N>` under `autocompact: false` is refused', () => {
  const offController = () =>
    new AutocompactController({
      config: resolveAutocompactConfig(false),
      window: {
        read: async () => ({
          tokens: 200_000,
          origin: 'models.dev' as const,
          check: 'checked' as const,
        }),
      },
      defaultThreshold: (window) => window - 2048,
    });

  it('changes nothing, and the notice says the config turned it off', async () => {
    const controller = offController();
    const before = await controller.status();

    const result = run('/autocompact 300K');
    expect(result.autocompact).toBeDefined();
    if (!result.autocompact || !('budget' in result.autocompact)) throw new Error('no budget');
    controller.setSessionBudget(result.autocompact.budget);
    const after = await controller.status();
    const notice = autocompactNotice(after, true);

    expect(notice.title).toBe('Automatic compaction is off in your config');
    expect(notice.lines.join(' ')).toContain('Nothing was changed');
    expect(notice.lines.join(' ')).not.toContain('rest of this session only');
    expect(after).toEqual(before);
    expect(controller.sessionOverride).toBeNull();
  });

  it('the bare /autocompact still reports the OFF state under the same config', async () => {
    const notice = autocompactNotice(await offController().status(), false);
    expect(notice.title).toBe('Automatic compaction');
    expect(notice.lines.join(' ')).toContain('OFF');
  });

  /**
   * The off switch has a second spelling, `{ enabled: false, threshold: … }`, and the refusal has
   * to be true of it: that user HAS set a threshold in the config, so advice to go and set one
   * names work already done and leaves the actual remedy — removing `enabled: false` — unsaid.
   * Both refusals are the same code path; what separates them is the budget the status carries.
   */
  it('names the off switch, not a missing number, when the config also carries a threshold', async () => {
    const controller = new AutocompactController({
      config: resolveAutocompactConfig({ enabled: false, threshold: '300K' }),
      window: {
        read: async () => ({
          tokens: 200_000,
          origin: 'models.dev' as const,
          check: 'checked' as const,
        }),
      },
      defaultThreshold: (window) => window - 2048,
    });
    const before = await controller.status();
    expect(before.enabled).toBe(false);
    expect(before.budget).not.toBeNull();

    const result = run('/autocompact 400K');
    if (!result.autocompact || !('budget' in result.autocompact)) throw new Error('no budget');
    controller.setSessionBudget(result.autocompact.budget);
    const after = await controller.status();
    const notice = autocompactNotice(after, true);

    expect(notice.title).toBe('Automatic compaction is off in your config');
    const lines = notice.lines.join(' ');
    expect(lines).toContain('already names a threshold');
    expect(lines).toContain('`enabled: false`');
    // Never the advice for the other spelling: this user has already set a threshold.
    expect(lines).not.toContain('give it a threshold instead');
    expect(after).toEqual(before);
    expect(controller.sessionOverride).toBeNull();
  });
});

describe('EXT-161 — /status carries the threshold and its provenance', () => {
  it('includes the compaction lines when a threshold is resolved', () => {
    const result = run('/status', ctx({ autocompact: status() }));
    const lines = result.notice!.lines.join(' ');
    expect(result.notice!.title).toBe('Session status');
    expect(lines).toContain('160,000');
    expect(lines).toContain('models.dev');
  });

  it('reflects a SESSION override rather than the value it replaced', () => {
    const result = run(
      '/status',
      ctx({ autocompact: status({ thresholdOrigin: 'session', thresholdTokens: 300_000 }) })
    );
    const lines = result.notice!.lines.join(' ');
    expect(lines).toContain('300,000');
    expect(lines).toContain('/autocompact');
  });

  it('says nothing about compaction on a surface with no resolved model', () => {
    // The fixture agent: no window, so no claim. The rest of the status block is unaffected.
    const result = run('/status', ctx({ autocompact: undefined }));
    const lines = result.notice!.lines.join(' ');
    expect(lines).not.toContain('Automatic compaction');
    expect(lines).toContain('Mode: chat');
  });
});

/**
 * [[EXT-187]] — **`/status` and `/autocompact` say when nothing checked the window.**
 *
 * The number itself is unchanged and the threshold is unchanged; what changes is that the user can
 * tell a measured window from a profile table that decided unchallenged. Both surfaces go through
 * `autocompactLines`, so both are read here off the same status.
 *
 * **Every cell has its control**, and the control is the reason this is not vacuous: the unchecked
 * status differs from the checked one in `windowCheck` alone, so an assertion that fired on both —
 * or on neither — would be pinning the fixture rather than the field.
 */
describe('EXT-187 — an unverified window says so', () => {
  /** The measured case the node was filed on, as a status. */
  const unchecked = (over: Partial<AutocompactStatus> = {}) =>
    status({
      window: 262_000,
      windowOrigin: 'profile',
      windowCheck: 'unchecked',
      ...over,
    });

  const UNVERIFIED = /unverified/;
  const REMEDY = /gth models --refresh/;

  it('qualifies the window number, and names the one remedy', () => {
    const lines = autocompactLines(unchecked()).join(' ');
    expect(lines).toMatch(UNVERIFIED);
    expect(lines).toMatch(REMEDY);
    // CONTROL: the same status with the window checked says neither, so this is the field talking
    // and not a sentence printed on every window.
    const checked = autocompactLines(unchecked({ windowCheck: 'checked' })).join(' ');
    expect(checked).not.toMatch(UNVERIFIED);
    expect(checked).not.toMatch(REMEDY);
  });

  it('CONTROL: stays quiet when no catalog could ever check the window', () => {
    // An ollama model resolved through its profile: nothing checked the number and nothing can.
    // Telling that user to refresh a catalog that will never hold their model is the diagnostic
    // that lies, and the third check value exists precisely to stop this line firing here.
    const lines = autocompactLines(unchecked({ windowCheck: 'uncheckable' })).join(' ');
    expect(lines).not.toMatch(UNVERIFIED);
    expect(lines).not.toMatch(REMEDY);
    // Discriminating half: the harness DOES render the rest of the block, so the silence above is
    // about the check state rather than about an empty renderer.
    expect(lines).toContain('Automatic compaction is ON');
  });

  it('warns that the THRESHOLD inherits the doubt when it is a share of that window', () => {
    // The sharp half of the node: a percentage is a setting the user chose, reinterpreted against
    // a number nothing checked.
    const percentage = autocompactLines(
      unchecked({ budget: { kind: 'fraction', fraction: 0.8 }, thresholdTokens: 209_600 })
    ).join(' ');
    expect(percentage).toMatch(/share of that unverified window/);

    // CONTROL: an absolute count means the same tokens whatever the window turns out to be, so the
    // threshold sentence must NOT appear — while the window qualification still does, because the
    // number above it is just as unverified.
    const absolute = autocompactLines(unchecked()).join(' ');
    expect(absolute).not.toMatch(/share of that unverified window/);
    expect(absolute).toMatch(UNVERIFIED);
  });

  it('warns for the DERIVED default too, which is also a share of the window', () => {
    const derived = autocompactLines(
      unchecked({ thresholdOrigin: 'default', budget: null, thresholdTokens: 259_952 })
    ).join(' ');
    expect(derived).toMatch(/share of that unverified window/);
  });

  it('does not promise a threshold when compaction is off, but still qualifies the window', () => {
    const off = autocompactLines(
      unchecked({ enabled: false, thresholdTokens: null, thresholdOrigin: 'none' })
    ).join(' ');
    expect(off).toContain('OFF');
    expect(off).toMatch(UNVERIFIED);
    // Nothing fires, so there is no threshold to inherit anything.
    expect(off).not.toMatch(/share of that unverified window/);
  });

  it('reaches /status, which is where a user asks the question', () => {
    const result = run('/status', ctx({ autocompact: unchecked() }));
    expect(result.notice!.lines.join(' ')).toMatch(UNVERIFIED);
    // CONTROL: the ordinary status block carries no such line.
    expect(run('/status', ctx({ autocompact: status() })).notice!.lines.join(' ')).not.toMatch(
      UNVERIFIED
    );
  });

  it('renders nothing extra for a status that predates the field entirely', () => {
    // Specs are not type-checked in this repo (`packages/*/tsconfig.json` build `src/` only), so a
    // stale fixture reaches the renderer with `windowCheck` undefined. It must read exactly as it
    // did before this node rather than printing a warning — or the word "undefined" — at a user.
    const stale = { ...status() } as Partial<AutocompactStatus>;
    delete stale.windowCheck;
    const lines = autocompactLines(stale as AutocompactStatus).join(' ');
    expect(lines).not.toMatch(UNVERIFIED);
    expect(lines).not.toContain('undefined');
    expect(lines).toContain('Automatic compaction is ON');
  });

  /**
   * The note is written ABOUT a number — "that number is unverified", decided by a "built-in table".
   * Both halves are false on the empty resolution, where there is no number and the table had no
   * entry either. This is not a hypothetical pairing: `contextWindowSources.spec.ts` pins that
   * `resolveContextWindow` returns `{ tokens: null, origin: 'unknown', check: 'unchecked' }` when a
   * cold catalog cache is followed by a profile table that does not know the model — the stale
   * `@langchain/groq` shape — and `status()` forwards it verbatim.
   */
  const noWindow = (over: Partial<AutocompactStatus> = {}) =>
    unchecked({
      window: null,
      windowOrigin: 'unknown',
      thresholdTokens: null,
      thresholdOrigin: 'none',
      budget: null,
      ...over,
    });

  it('says nothing unverified when there is no window to be unverified about', () => {
    const lines = autocompactLines(noWindow()).join(' ');
    expect(lines).not.toMatch(UNVERIFIED);
    expect(lines).not.toMatch(REMEDY);
    // Discriminating halves: the branch DID render, and it rendered the sentence this one would
    // otherwise have contradicted — so the silence is the window gate and not an empty return.
    expect(lines).toContain("This model's context window is not known to any source we have.");
    expect(lines).toContain('Automatic compaction is on, but nothing will trigger it.');
  });

  it('CONTROL: the same check state with a window present still says it', () => {
    // The only difference from the cell above is that a number exists. If this went quiet too, the
    // gate would be suppressing the note for every unchecked status rather than for the one where
    // the sentence is untrue, and the node's whole surface would be dead.
    const lines = autocompactLines(noWindow({ window: 262_000, windowOrigin: 'profile' })).join(
      ' '
    );
    expect(lines).toMatch(UNVERIFIED);
    expect(lines).toMatch(REMEDY);
  });

  it('holds on the compaction-off branch, which prints the window line too', () => {
    const lines = autocompactLines(noWindow({ enabled: false })).join(' ');
    expect(lines).toContain('OFF');
    expect(lines).not.toMatch(UNVERIFIED);
    expect(lines).not.toMatch(REMEDY);
  });
});
