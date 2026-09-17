/**
 * @packageDocumentation
 * [[BATCH-31]] — **prompt-content A/B for the approvals rater: the same corpus rated twice, once
 * with one of our own preflight notes in the prompt and once without.**
 *
 * [[EXT-81]] needed exactly that comparison and could not express it as a suite. A sweep can move
 * the rung and the model; nothing could say *omit this note*. It was measured instead by a
 * standalone harness
 * (`docs/test-sessions/ext-81-composed-note-sweep-2026-08-04/harness/composed-open-world-note.mjs`)
 * that built the shipping prompt and **deleted the note block out of it** — and that harness, not a
 * new prompt builder, is what this module generalises.
 *
 * ## What "production" means here, because the whole argument below hangs on it
 *
 * **Production is the SESSION's approvals gate**: `GthAgentRunner`'s rating call, the one that
 * decides whether a shell command a live agent proposed runs, prompts, or halts. That is the gate
 * whose safety context must never be suppressible. `gth eval` is a measuring instrument — it rates
 * a corpus and prints a table, and gates nothing — so making an omission expressible *there* is the
 * point of this node, not a hazard.
 *
 * The forbidden design is therefore precise: **a switch inside the gate** — a parameter on
 * `rateShellCommand` or `buildRaterPrompt` that suppresses a note. [[EXT-81]]'s implementer
 * identified that shape and declined to build it. Nothing here adds one; **core is untouched by
 * this node.**
 *
 * ## The shape taken: a third sweep-override kind with its own route
 *
 * A sweep value already carries two override kinds, and they reach the run by two different routes:
 * `model:` through `initConfig({ model })`, and `config:` by a deep merge onto the resolved
 * `GthConfig`. This adds a third, `notes:`, whose route is:
 *
 * ```text
 *   suite  sweep value  notes: { omit: [<note>] }
 *     -> EvalSweepValue.notes  (parsed and validated against the registry below)
 *     -> SweepCell.notes       (expandSweep; never merged into the cell's `config`)
 *     -> RaterClassifierOptions.notes
 *     -> armRaterModel(...)    <- a decorator around the RATING MODEL, in this package
 *     -> the note block is deleted from the outgoing user message
 * ```
 *
 * The one-file A/B EXT-81 wanted is then a one-axis sweep: `{ name: on, notes: { omit: [] } }`
 * against `{ name: off, notes: { omit: [composed-open-world] } }`.
 *
 * ## How production-unreachability is ENFORCED, not merely intended
 *
 * Four independent legs, each of which a test can fail:
 *
 * 1. **The omission never becomes config.** `notes:` is a sibling of `config:`, not a key inside it,
 *    and `initConfigForCell` deep-merges only `cell.config`. So the value has no representation in
 *    `GthConfig`, and therefore none in `.gsloth.config.json`, in an env var, or in a CLI flag —
 *    the three carriers the node names. Pinned by a spec that plants the omission in a config, in
 *    an `approvals` block, and on the rating call's own options object, drives the SESSION gate over
 *    a noted command, and asserts the note is still in the prompt that was sent.
 * 2. **The omission is not data at all — it is a function.** What actually removes the note is a
 *    `BaseChatModel` decorator constructed here at classifier-build time. A config file, an
 *    environment variable and a command-line flag can carry a string; none of them can carry a model
 *    decorator. There is no serialisable spelling of this facility for a session to deserialise.
 * 3. **The session's gate cannot import this module.** `@gaunt-sloth/batch` depends on
 *    `@gaunt-sloth/core`, where `GthAgentRunner` and `rateShellCommand` live. The reverse edge is a
 *    dependency cycle, so core cannot reach `armRaterModel` even deliberately. This is enforced by
 *    the package graph rather than by a convention someone has to remember.
 * 4. **The declaration is rejected on every target that runs an agent.** `notes:` parses only on a
 *    `rater` suite, which runs no agent and executes no tool — so the surface does not exist on the
 *    suite kinds that drive real sessions.
 *
 * **What none of that proves, stated because the honest limit matters:** leg 3 shows core cannot
 * construct this arm; it does not show core will never grow a suppression switch of its own. Only a
 * *wired* switch is a production path, so the discriminating test is the one in leg 1 — drive the
 * runner's gate and watch the note survive — and the mutation that proves it real is to make the
 * runner pass a suppression flag and see that spec go red. A test that merely asserted something
 * about this package's barrel exports would pass while proving nothing about the hazard.
 *
 * ## Shapes rejected
 *
 * - **A `notes:` option on `rateShellCommand` / `buildRaterPrompt`.** This is the naive fix and it
 *   is the one the node forbids: a switch in the gate that suppresses safety context for one
 *   measurement's benefit. Defaults and documentation do not redeem it — it puts the code path in
 *   the session's own rating call, where the next caller to grow an option bag can reach it.
 * - **A sweep axis that overrides `target:` fields.** The node names this as a candidate, and it was
 *   rejected because it would falsify a constraint the existing sweep depends on. `resolveRung`'s
 *   docblock states that a cell can override `config:` and `model:` but cannot reach a `target`
 *   field, and that this is *deliberate* and is what makes `config: { approvals: auto }` the way an
 *   axis moves the rung. An axis able to rewrite `target` would give the rung two spellings with a
 *   silent precedence between them. Adding a third route leaves that constraint exactly as true as
 *   it was.
 * - **A `target.notes:` field with no sweep reach.** Expressible, but a `target` is suite-level, so
 *   the A/B would again be two hand-written suite files — the thing this node exists to remove.
 * - **Reproducing a note's text in this package.** See {@link RATER_PROMPT_NOTES}: a second copy of
 *   the prose would drift, and a drifted copy deletes nothing, so both arms would send the same
 *   prompt and the measurement would report "the note has no effect". That is the failure mode that
 *   passes its own test, so only notes core exports a byte-exact builder for are expressible.
 *
 * ## Why the decorator never throws, and the caller adjudicates instead
 *
 * The strip happens inside `structured.invoke`, which `rateShellCommand` runs inside the `try` whose
 * whole job is to turn a throw into the fail-closed `destructive` verdict. A decorator that threw on
 * a leak would therefore be recorded as a rating, and the arm's own failure would read as the
 * rater's judgement. So the decorator only ever RECORDS what it did, and
 * {@link reconcileArmedCapture} — called by the target after the rating call has returned, outside
 * that `try` — is what raises.
 */
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RaterCallCapture } from '@gaunt-sloth/core/core/shell/approvalCapture.js';
import { buildComposedOpenWorldNote } from '@gaunt-sloth/core/core/shell/openWorld.js';
import { buildParserPreflightNote } from '@gaunt-sloth/core/core/shell/abstention.js';

/**
 * The notes an arm can omit: a stable suite-facing token → **core's own builder for that note's
 * exact text**.
 *
 * **Every entry is core's function, never a copy of its prose, and that is the entry requirement.**
 * The off arm is produced by deleting a block from the built prompt, so the text used to find the
 * block has to be the same bytes the builder put there. A second copy in this package would pass
 * review, drift on the first wording change in core, then find nothing to delete — and an arm that
 * deletes nothing sends the on-arm prompt under the off arm's name, so the comparison reports the
 * note having no effect. {@link reconcileArmedCapture} raises on exactly that, but a registry built
 * from copies would be relying on a runtime check to catch a defect the design need not have.
 *
 * **Two of `buildRaterPrompt`'s four preflight notes are therefore absent**: the script-env-leak
 * note and the open-world floor note are composed inline in that function and core exports no
 * builder for either. They become expressible the day core extracts one — which is a change to core
 * with its own justification, not something to smuggle in here as a copied string.
 */
export const RATER_PROMPT_NOTES = {
  /** [[EXT-81]]'s note: the data flow across the parts of a command our parser could not resolve
   * as a whole. The note the A/B that motivated this node is about. */
  'composed-open-world': buildComposedOpenWorldNote,
  /** The parser's own abstention note: what about the command's shape could not be resolved. */
  parser: buildParserPreflightNote,
} as const satisfies Record<string, (command: string) => string | null>;

/** A note name a suite may omit — the keys of {@link RATER_PROMPT_NOTES}. */
export type RaterPromptNoteName = keyof typeof RATER_PROMPT_NOTES;

/** Every note name a suite may write, in declaration order, for error messages and validation. */
export const RATER_PROMPT_NOTE_NAMES = Object.keys(RATER_PROMPT_NOTES) as RaterPromptNoteName[];

/**
 * One sweep cell's prompt arm: which of our own preflight notes this cell's ratings go out without.
 *
 * `omit: []` is the meaningful, and required, spelling of the baseline arm. A sweep value that
 * declared nothing at all would be indistinguishable from an authoring slip, and the whole point of
 * an A/B is that both arms say what they are.
 */
export interface RaterPromptArm {
  readonly omit: readonly RaterPromptNoteName[];
}

/** The prompt as it actually left for the model. */
export interface ArmedPrompt {
  system: string;
  user: string;
}

/**
 * What one armed rating call did — recorded by the decorator, adjudicated afterwards by
 * {@link reconcileArmedCapture}.
 */
export interface RaterPromptArmOutcome {
  /** Whether the decorated model was invoked at all. `false` means `rateShellCommand` returned
   * before the send site — it found no usable model — so nothing was measured. */
  invoked: boolean;
  /** Notes whose block was found and removed. */
  removed: RaterPromptNoteName[];
  /** Notes that do not apply to this command, so there was no block to remove. This is the
   * byte-identical case and it is silent by design: a command carrying no composed note must
   * produce the same prompt under both arms. */
  absent: RaterPromptNoteName[];
  /** Notes whose block core says exists on this command and the arm could not find in the prompt —
   * a leak. Raised on, never tolerated. */
  leaked: RaterPromptNoteName[];
  /** The prompt as sent, once the arm had finished with it. */
  sent?: ArmedPrompt;
}

/** A fresh, empty outcome for one rating call. */
function emptyOutcome(): RaterPromptArmOutcome {
  return { invoked: false, removed: [], absent: [], leaked: [] };
}

/**
 * Delete the arm's notes from a built rater user message.
 *
 * Pure, and keyed on the command: each note's block is `'\n\n' + <core's text for this command>`,
 * because `buildRaterPrompt` pushes every note into its line buffer as `('', note)` and joins on
 * `'\n'`. A note that does not apply to the command yields `null` and is recorded as `absent`.
 */
export function stripRaterPromptNotes(
  user: string,
  command: string,
  arm: RaterPromptArm
): {
  user: string;
  removed: RaterPromptNoteName[];
  absent: RaterPromptNoteName[];
  leaked: RaterPromptNoteName[];
} {
  let out = user;
  const removed: RaterPromptNoteName[] = [];
  const absent: RaterPromptNoteName[] = [];
  const leaked: RaterPromptNoteName[] = [];
  for (const name of arm.omit) {
    const note = RATER_PROMPT_NOTES[name](command);
    if (note === null) {
      absent.push(name);
      continue;
    }
    const block = `\n\n${note}`;
    const at = out.indexOf(block);
    if (at === -1) {
      leaked.push(name);
      continue;
    }
    out = out.slice(0, at) + out.slice(at + block.length);
    removed.push(name);
  }
  return { user: out, removed, absent, leaked };
}

/**
 * Wrap a rating model so this call's prompt goes out without the arm's notes.
 *
 * **Why the MODEL and not the prompt builder.** The prompt is built inside `rateShellCommand`, and
 * every seam that could change it there would be a switch in the session's gate. The model is the
 * one thing the gate takes from its caller, so decorating it is the only place a measurement can
 * change the outgoing prompt without core growing a parameter for it. The `eval` rater target is
 * also the only caller that constructs such a model.
 *
 * **A Proxy rather than a hand-written delegate**, because `rateShellCommand` reads more off a model
 * than `withStructuredOutput` — `raterModelLabel` calls `_llmType()` and reads `model`/`modelName`/
 * `modelId` — and a delegate that enumerated today's reads would silently answer `undefined` for
 * tomorrow's. Every trap forwards with the TARGET as the receiver and binds methods to the target,
 * so a provider class keeping state behind private `#fields` is not handed a `this` it cannot use.
 *
 * **A shape it does not recognise is a leak, not a pass-through.** If the messages are not the
 * `[SystemMessage, HumanMessage]` pair with string content that `rateShellCommand` sends, the call
 * is forwarded unchanged and every requested note is recorded as leaked, so the run fails loudly
 * instead of quietly measuring the on-arm prompt under the off arm's name.
 *
 * @param model The resolved rating model.
 * @param command The command this call rates — the notes are a function of it.
 * @param arm The notes to omit.
 * @param outcome The record this call writes into; one per rating call, so concurrent cases cannot
 *   share it.
 */
export function armRaterModel(
  model: BaseChatModel,
  command: string,
  arm: RaterPromptArm,
  outcome: RaterPromptArmOutcome
): BaseChatModel {
  const forward = (target: object, prop: string | symbol): unknown => {
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function'
      ? (value as (...a: unknown[]) => unknown).bind(target)
      : value;
  };

  const armInvoke = (messages: unknown): unknown => {
    outcome.invoked = true;
    if (!Array.isArray(messages) || messages.length !== 2) {
      outcome.leaked.push(...arm.omit);
      return messages;
    }
    const [system, user] = messages as { content?: unknown }[];
    if (typeof system?.content !== 'string' || typeof user?.content !== 'string') {
      outcome.leaked.push(...arm.omit);
      return messages;
    }
    const stripped = stripRaterPromptNotes(user.content, command, arm);
    outcome.removed.push(...stripped.removed);
    outcome.absent.push(...stripped.absent);
    outcome.leaked.push(...stripped.leaked);
    outcome.sent = { system: system.content, user: stripped.user };
    return [new SystemMessage(system.content), new HumanMessage(stripped.user)];
  };

  return new Proxy(model, {
    get(target, prop): unknown {
      if (prop !== 'withStructuredOutput') return forward(target, prop);
      const original = Reflect.get(target, prop, target);
      if (typeof original !== 'function') return original;
      return (...args: unknown[]): unknown => {
        const runnable = (original as (...a: unknown[]) => unknown).apply(target, args);
        if (runnable === null || typeof runnable !== 'object') return runnable;
        return new Proxy(runnable as object, {
          get(runnableTarget, runnableProp): unknown {
            if (runnableProp !== 'invoke') return forward(runnableTarget, runnableProp);
            const invoke = Reflect.get(runnableTarget, runnableProp, runnableTarget);
            if (typeof invoke !== 'function') return invoke;
            return (messages: unknown, ...rest: unknown[]): unknown =>
              (invoke as (...a: unknown[]) => unknown).apply(runnableTarget, [
                armInvoke(messages),
                ...rest,
              ]);
          },
        });
      };
    },
  }) as BaseChatModel;
}

/**
 * A fresh outcome plus the model that writes into it — **one per rating call**, because the
 * classifier is reused across cases the suite runner may run concurrently and a shared record would
 * let one case's arm be adjudicated on another's call.
 *
 * `model` is `undefined` only in the state `buildRaterClassifier` refuses to build: an arm declared
 * with no model to decorate. It is admitted here rather than guarded a second time, so that state
 * lands on {@link reconcileArmedCapture}'s "never reached a rating call" arm — one rule, one place —
 * instead of on a copy of the rule that could drift from it.
 */
export function armFor(
  model: BaseChatModel | undefined,
  command: string,
  arm: RaterPromptArm
): { model: BaseChatModel | undefined; outcome: RaterPromptArmOutcome } {
  const outcome = emptyOutcome();
  return {
    model: model === undefined ? undefined : armRaterModel(model, command, arm, outcome),
    outcome,
  };
}

/**
 * Adjudicate one armed rating call, **after it has returned and outside `rateShellCommand`'s
 * fail-closed `try`**, and repair the call's diagnostic record.
 *
 * Two jobs, and both are about not lying:
 *
 * - **Raise on an arm that did not do what it said.** A leaked note, or a rating call the decorated
 *   model never saw, means this cell's numbers are the other arm's numbers under this arm's name.
 *   Silently reporting them is strictly worse than failing the run, because the comparison table
 *   would then say the note changed nothing.
 * - **Make `capture.prompt` the prompt that was SENT.** `rateShellCommand` fills the capture from
 *   `buildRaterPrompt`'s output at the send site and its contract is that nothing downstream may
 *   leave the archive disagreeing with what the model saw. The arm edits the message below that
 *   point, so the arm is what owes the correction — and for a facility whose whole subject is prompt
 *   content, a diagnostic record of the wrong arm's prompt would be the worst possible artifact.
 *
 * @param capture The record `rateShellCommand` handed back through `onCapture`, when it made one.
 */
export function reconcileArmedCapture(
  command: string,
  arm: RaterPromptArm,
  outcome: RaterPromptArmOutcome,
  capture: RaterCallCapture | undefined
): void {
  if (!outcome.invoked) {
    throw new Error(
      `eval: the prompt arm omitting [${arm.omit.join(', ')}] never reached a rating call for ` +
        `"${command}" — the gate found no usable rating model, so this cell would report the ` +
        "other arm's prompt under this arm's name."
    );
  }
  if (outcome.leaked.length > 0) {
    throw new Error(
      `eval: the prompt arm could not remove [${outcome.leaked.join(', ')}] from the rating ` +
        `prompt for "${command}" — core builds that note for this command but it was not found in ` +
        'the prompt. The arm and the prompt builder have diverged; this cell would have rated the ' +
        'un-omitted prompt.'
    );
  }
  if (capture && outcome.sent) capture.prompt = outcome.sent;
}
