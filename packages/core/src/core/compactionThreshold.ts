/**
 * @packageDocumentation
 * EXT-161 — **the preventive compaction threshold: one number, one place it is decided.**
 *
 * `contextWindow.ts` answers "how big is the window". This module answers the question that
 * actually gates a compaction: **at what prompt size do we fold the conversation, and who said
 * so.** Three things can say so, in this order:
 *
 * 1. **the running session** — `/autocompact 300K`, which wins for the rest of the session;
 * 2. **the user's config** — the `autocompact` key;
 * 3. **the default** — derived from the resolved window by the guard, which is the only place that
 *    knows how many tokens are being held back for the answer.
 *
 * **Compaction is ON BY DEFAULT.** That is a ruling, and it is a deliberate exception to the rule
 * that a default-on middleware must not touch `state.messages` — compaction changes what the model
 * sees by construction, which is the whole feature. The exception is paid for the way the rule
 * demands: the shape of the history a compaction leaves behind is pinned per provider by
 * `compaction.ts`'s invariants (a)–(d), a compaction announces itself in the transcript, the
 * resolved number and its provenance are readable with `/status`, and the off switch is one key —
 * `autocompact: false`.
 *
 * **Why the provenance is carried rather than recomputed.** A threshold that is wrong is diagnosed
 * by knowing where the number came from; a `/status` that reports a models.dev-derived number after
 * a human typed `/autocompact 50000` would send the next diagnosis to the wrong place entirely. So
 * a session override re-labels the provenance, and {@link AutocompactController} is the single
 * object both the guard and `/status` read, over one memoised window resolution.
 */
import {
  formatTokenBudget,
  parseTokenBudget,
  resolveTokenBudget,
  type TokenBudget,
} from '#src/config/tokenBudget.js';
import { debugLog } from '#src/utils/debugUtils.js';
import type {
  ContextWindowCheck,
  ContextWindowOrigin,
  ContextWindowReading,
  ResolvedContextWindow,
} from '#src/core/contextWindow.js';

/**
 * The share of a model's context window that `gth init` seeds as an explicit threshold.
 *
 * Init writes an **absolute number** derived from this rather than the percentage itself, because
 * the point of seeding is that the user opens their config and sees the number that will actually
 * be enforced. A percentage would leave them one lookup away from it.
 *
 * 0.8 leaves a fifth of the window for the answer and the tool round that follows it — comfortably
 * more than the flat answer reserve on any real cloud window, which is what makes the seeded number
 * the binding one rather than a decoration.
 */
export const DEFAULT_AUTOCOMPACT_SEED_FRACTION = 0.8;

/**
 * The `autocompact` config value, in every form the key accepts.
 *
 * `false` disables it; `true` (and an absent key) is on with the derived default; a bare count or
 * suffixed string is on with that threshold; the object form spells both out. The shorthand union
 * mirrors `toolLoopGuard`, which is the shape a reader of this config already knows.
 */
export type AutocompactConfig =
  boolean | number | string | { enabled?: boolean; threshold?: number | string };

/** The `autocompact` key as the read site sees it, after defaulting and parsing. */
export interface ResolvedAutocompactConfig {
  /** Whether preventive compaction may fire at all. On by default — ruled. */
  enabled: boolean;
  /** The configured budget, or `null` when the user named none and the default applies. */
  budget: TokenBudget | null;
}

/**
 * Read the `autocompact` config key.
 *
 * Defaulting happens **here, at the read site**, not in `DEFAULT_CONFIG`, so an absent key stays
 * absent in the effective-config snapshot and the snapshot does not churn — the same placement
 * `injectModelContext` and `toolLoopGuard` use.
 *
 * A malformed threshold raises the `TokenBudgetError` from the shared parser, which config
 * validation turns into a field-scoped issue naming the offending text. It must never resolve to a
 * number: `NaN`, `0` and 4097 are all thresholds the user cannot see and did not choose.
 */
export function resolveAutocompactConfig(raw: unknown): ResolvedAutocompactConfig {
  if (raw === undefined || raw === null) return { enabled: true, budget: null };
  if (typeof raw === 'boolean') return { enabled: raw, budget: null };
  if (typeof raw === 'number' || typeof raw === 'string') {
    return { enabled: true, budget: parseTokenBudget(raw) };
  }
  if (typeof raw === 'object') {
    const value = raw as { enabled?: unknown; threshold?: unknown };
    const enabled = value.enabled !== false;
    const budget =
      value.threshold === undefined || value.threshold === null
        ? null
        : parseTokenBudget(value.threshold);
    return { enabled, budget };
  }
  return { enabled: true, budget: null };
}

/**
 * Where the threshold number in force came from — what `/status` names.
 *
 * [[OPS-125]] — **three states used to share `'none'`, and one of them was a user being ignored.**
 * Compaction switched off, a window nothing knew with nothing configured, and an explicit
 * percentage budget that could not resolve all answered the same value. The first is somebody
 * getting exactly what they asked for; the last is somebody's setting accepted and silently inert,
 * and no caller — not `/status`, not a test, not the next maintainer reading this type — could tell
 * them apart.
 *
 * **Only one member was added, because `enabled` already separates the first.** A status carrying
 * `enabled: false` is the off switch and nothing else, so the pair that genuinely could not be
 * distinguished was the other two. A second member spelling out "switched off" would encode a fact
 * the status already states beside it, and two fields disagreeing about the off switch is a worse
 * failure than the one being fixed.
 *
 * **Widened here rather than answered by a reason field beside the origin.** The deciding surface is
 * `autocompactLines`' provenance map, typed `Record<AutocompactThresholdOrigin, string>`: a new
 * member of this union does not compile until every place that renders an origin has said what the
 * new state reads as, while a new field beside it is droppable by every consumer without a word.
 * For a defect whose whole substance is a state nobody was told about, the change that cannot be
 * ignored is the right one.
 */
export type AutocompactThresholdOrigin =
  /** A `/autocompact` typed in this session; outranks the config for the rest of it. */
  | 'session'
  /** The `autocompact` key in the user's config. */
  | 'config'
  /** Derived from the resolved window, holding back room for the answer. */
  | 'default'
  /**
   * A threshold WAS named, as a share of the context window, and no source knew the window — so
   * there is no number to take a share of and nothing will fire.
   *
   * Distinct from `'none'` because the user made a choice here and it is not being honoured. An
   * absolute count never reaches this state: it needs no window, which is the asymmetry that makes
   * this the one configuration that is fine on every model whose window resolves and inert on the
   * rest.
   */
  | 'unresolved-budget'
  /**
   * Nothing will fire and nobody asked for anything: compaction is switched off, or the window is
   * unknown and no threshold was named to fall back on.
   *
   * Read it with `enabled`, which is what separates those two — off is a deliberate silence, and
   * the unknown window already says so once through the window resolution's own signal.
   */
  | 'none';

/** The whole picture, as `/status` prints it and the guard enforces it. */
export interface AutocompactStatus {
  /** Whether preventive compaction may fire at all (the config off switch). */
  enabled: boolean;
  /**
   * The prompt size, in tokens, at which the conversation is folded — or `null` when nothing will
   * fire preventively, which is what an unknown window with no absolute threshold must produce.
   */
  thresholdTokens: number | null;
  /** Where that number came from. */
  thresholdOrigin: AutocompactThresholdOrigin;
  /** The resolved context window, or `null` when no source knew it. */
  window: number | null;
  /** Which source the window came from. */
  windowOrigin: ContextWindowOrigin;
  /**
   * [[EXT-187]] — whether anything was in a position to contradict that window.
   *
   * Carried beside `windowOrigin` rather than folded into it, for the reason
   * {@link ContextWindowCheck} gives: they answer different questions, and a surface that needs one
   * of them almost always needs the other in the same sentence.
   */
  windowCheck: ContextWindowCheck;
  /** The budget exactly as written, when one was written — so `/status` can echo `80%` as `80%`. */
  budget: TokenBudget | null;
}

/** What {@link AutocompactController} needs to build a status. */
export interface AutocompactControllerOptions {
  /** The `autocompact` key, already read through {@link resolveAutocompactConfig}. */
  config: ResolvedAutocompactConfig;
  /** The one memoised window resolution this session uses — shared with the guard. */
  window: Pick<ResolvedContextWindow, 'read'>;
  /**
   * The threshold to use when the user named none, given a known window: the guard's
   * `window − reserve`. Supplied as a callback because only the guard knows the reserve, and
   * duplicating that arithmetic here is how the two would come to disagree about what "full" means.
   */
  defaultThreshold: (_window: number) => number;
}

/**
 * **The single object the guard and `/status` both read.**
 *
 * Holds the session override — the write half of `/autocompact` — and resolves it against the
 * config and the window on demand. It is mutable by design and the guard reads it through a
 * closure rather than capturing a value, because `createContextGuardMiddleware` runs its factory
 * once per session and its hook holds no state: a captured threshold could never be changed by a
 * command typed later, which is precisely what `/autocompact` has to do.
 */
export class AutocompactController {
  private readonly options: AutocompactControllerOptions;
  private sessionBudget: TokenBudget | null = null;
  /**
   * [[OPS-125]] — whether the inert-budget line has already been written for this session.
   *
   * **The gate is not tidiness.** `status()` is what `threshold()` reads, and the guard reads
   * `threshold()` before every model call — so an ungated line would be written once per turn into
   * a 1000-entry ring buffer and would evict every other diagnostic in the session, including the
   * window-resolution line that names the model this one is about. EXT-168's equivalent needs no
   * flag only because it sits inside the memoised window resolution, which runs once.
   */
  private budgetSignalWritten = false;

  constructor(options: AutocompactControllerOptions) {
    this.options = options;
  }

  /**
   * Set the threshold for the rest of this session, overriding the config.
   *
   * Deliberately takes an already-parsed {@link TokenBudget} rather than raw text: parsing is the
   * shared parser's job, and a second entry point that took a string would be a second place the
   * grammar could drift.
   *
   * **Refused while the config has compaction off.** `autocompact: false` means nothing fires,
   * whatever number is named, so recording the budget would only make the next {@link status}
   * describe a threshold that can never trigger. Nothing is recorded and the status is unchanged;
   * the surface reads `enabled: false` off the status that comes back and says so. Turning it back
   * on is a config edit — removing the key, or setting a threshold there — not a session command.
   */
  setSessionBudget(budget: TokenBudget): void {
    if (!this.options.config.enabled) return;
    this.sessionBudget = budget;
  }

  /** The session override in force, or `null`. Read by `/autocompact` with no argument. */
  get sessionOverride(): TokenBudget | null {
    return this.sessionBudget;
  }

  /** Whether the config off switch leaves anything to do at all. */
  get enabled(): boolean {
    return this.options.config.enabled;
  }

  /** The full picture — the one call `/status` makes. */
  async status(): Promise<AutocompactStatus> {
    const reading: ContextWindowReading = await this.options.window.read();
    const budget = this.sessionBudget ?? this.options.config.budget;
    const budgetOrigin: AutocompactThresholdOrigin = this.sessionBudget
      ? 'session'
      : this.options.config.budget
        ? 'config'
        : 'default';

    if (!this.options.config.enabled) {
      return {
        enabled: false,
        thresholdTokens: null,
        thresholdOrigin: 'none',
        window: reading.tokens,
        windowOrigin: reading.origin,
        windowCheck: reading.check,
        budget,
      };
    }

    // A named budget resolves against the window — which an absolute count does not need, so an
    // explicit `300K` still fires on a model nothing knows the window of. A PERCENTAGE without a
    // window cannot resolve, and falls through to the same "nothing fires" answer as no threshold
    // at all rather than to a guess.
    //
    // [[EXT-187]] — **this line is where `/autocompact <n>%` meets a window nothing checked, and it
    // is RULED to resolve it exactly as it resolves a checked one.** The arithmetic below is
    // deliberately blind to `reading.check`; what changes is that the status now carries the fact,
    // so the surface can say the window is unverified instead of presenting it as measured. Three
    // alternatives were considered here and rejected:
    //
    // **Refuse the percentage** — return no threshold when the window is `'unchecked'`. Rejected:
    // it pays a certain broad loss to avoid an uncertain narrow one. The profile table is RIGHT for
    // the great majority of ids ([[EXT-185]] measured three overstating entries in one pinned
    // package, not a majority), and a cold cache is the ORDINARY first-session state rather than an
    // edge case, because the runtime reads the catalog `cacheOnly`. So refusing would strip
    // preventive compaction from most models on most first sessions. It also inverts this feature's
    // own failure mode into a worse one: the user asks for 80%, is told no, and now has nothing —
    // a protection silently absent is exactly what a threshold they cannot see was meant to avoid.
    //
    // **Derate it** — treat an unchecked window as some fraction smaller before applying the
    // percentage. Rejected as the 4097 failure `contextWindow.ts` opens by naming, wearing a
    // different hat: it invents a number the user did not choose and cannot predict, and it would
    // leave `/status` echoing a threshold that matches neither the window printed above it nor the
    // percentage the user wrote.
    //
    // **Ask.** Rejected: the same path serves the `autocompact` CONFIG key, which is read with
    // nobody at the keyboard, and a prompt at session start for the many models one cold-cache read
    // away from unknown is the default-on noise [[EXT-168]] already declined a notice over.
    //
    // What is left — resolve it and SAY SO — is the only option that keeps the guard that is
    // usually right while ending the silence that made the setting misleading. The cost is one
    // sentence on a surface the user is already reading; see `autocompactLines`.
    const named = budget ? resolveTokenBudget(budget, reading.tokens) : null;
    if (named !== null) {
      return {
        enabled: true,
        thresholdTokens: named,
        thresholdOrigin: budgetOrigin === 'default' ? 'config' : budgetOrigin,
        window: reading.tokens,
        windowOrigin: reading.origin,
        windowCheck: reading.check,
        budget,
      };
    }

    if (reading.tokens === null) {
      // [[OPS-125]] — **the two ways to arrive here are not the same event, and only one of them
      // has already been reported.** With no budget named, this is the plain unknown-window case:
      // nobody asked for anything, and the window resolution has already written a line naming the
      // provider, the model and the consequence. With a budget named, `resolveTokenBudget` returned
      // null, which for a budget it accepted can only mean a fraction — an absolute count needs no
      // window and returns as written. That user asked for a specific share and is getting nothing.
      //
      // The label is the whole change on this branch: **the arithmetic is untouched.** Both states
      // still yield no threshold, which is the ruling `contextWindow.ts` holds and this node was
      // explicitly told not to widen. What moves is that a caller can now tell them apart.
      const budgetWentUnresolved = budget !== null;
      if (budgetWentUnresolved && !this.budgetSignalWritten) {
        this.budgetSignalWritten = true;
        // Deliberately NOT a session-start notice: [[EXT-168]] declined one for this same
        // population and recorded why, and `debugUtils.ts` fills its ring buffer unconditionally
        // so `/debug-dump` hands this over to anyone who asks.
        //
        // It says the one thing the window-resolution line cannot: that line knows no window was
        // found and says so; it does not know a threshold was configured against it. Writing only
        // the overlap would be the duplication this node was filed to avoid — the fact worth
        // adding is that an explicit setting is being ignored, and which setting it is.
        debugLog(
          `The configured automatic-compaction threshold ${formatTokenBudget(budget)} is a share ` +
            "of this model's context window, and no source knew that window, so there is no " +
            'number to take a share of and no preventive compaction will happen this session. An ' +
            'absolute threshold needs no window — set one (for example 300K) to make it bite here.'
        );
      }
      return {
        enabled: true,
        thresholdTokens: null,
        thresholdOrigin: budgetWentUnresolved ? 'unresolved-budget' : 'none',
        window: null,
        windowOrigin: reading.origin,
        windowCheck: reading.check,
        budget,
      };
    }

    return {
      enabled: true,
      thresholdTokens: this.options.defaultThreshold(reading.tokens),
      thresholdOrigin: 'default',
      window: reading.tokens,
      windowOrigin: reading.origin,
      windowCheck: reading.check,
      budget,
    };
  }

  /** The number the guard compares against, or `null` for "never fire". */
  async threshold(): Promise<number | null> {
    return (await this.status()).thresholdTokens;
  }
}

/**
 * The absolute threshold `gth init` writes for a model whose window it resolved — a plain number,
 * because the point of seeding is that the user can read the enforced value straight out of their
 * config.
 *
 * Returns `null` when the window is unknown, and the caller then writes **no key at all**: seeding
 * a guess would put a number in the user's config that looks chosen and was not, which is worse
 * than the absent key that leaves the runtime default in charge.
 */
export function seedAutocompactThreshold(window: number | null): number | null {
  if (window === null || !Number.isFinite(window) || window <= 0) return null;
  return Math.max(1, Math.floor(window * DEFAULT_AUTOCOMPACT_SEED_FRACTION));
}
