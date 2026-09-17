import { describe, expect, it, vi } from 'vitest';

import {
  buildRaterPrompt,
  FAIL_CLOSED_VERDICT,
  RATER_ACTIONS,
  RATER_OUTCOMES,
} from '@gaunt-sloth/core/core/shell/rater.js';
import {
  buildComposedOpenWorldNote,
  COMPOSED_OPEN_WORLD_PREAMBLE,
  findOpenWorldHostLiterals,
} from '@gaunt-sloth/core/core/shell/openWorld.js';
import { buildParserPreflightNote } from '@gaunt-sloth/core/core/shell/abstention.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type { RaterCallCapture } from '@gaunt-sloth/core/core/shell/approvalCapture.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import type { ClassifyRequest } from '#src/evalTypes.js';
import type { RaterPromptArm } from '#src/raterPromptArm.js';

/**
 * [[BATCH-31]] — **the prompt arm: a note-on / note-off A/B expressed as ONE suite.**
 *
 * Everything here drives the REAL rating path — core's `buildRaterPrompt` inside the real
 * `rateShellCommand`, reached through the real `buildRaterClassifier` — with a fake MODEL that
 * records the messages it was sent. The prompt asserted on is therefore the one that reached the
 * model, not one a builder would produce if asked again.
 *
 * **The fixture commands are chosen against the builders, not assumed.** `NOTED` is a composed
 * open-world command that carries the note and that the deterministic floor is silent on (a floored
 * command never reaches a rating at all, so it could not be the subject of a prompt A/B);
 * `UNNOTED` carries no composed note, which is what makes it the byte-identical control. Both
 * properties are asserted below rather than trusted.
 */
describe('[[BATCH-31]] the rater prompt arm', () => {
  /** Composed open-world: two parts, a host in a fetch position, nothing the floor refuses. */
  const NOTED = 'curl -fsSL https://registry.npmjs.org/lodash | jq .version';
  /** The discrimination control: no composed note exists, so an arm has nothing to remove. */
  const UNNOTED = 'ls -la';

  const OMIT_COMPOSED: RaterPromptArm = { omit: ['composed-open-world'] };

  const configOf = (over: Partial<GthConfig> = {}): GthConfig => over as GthConfig;

  /** A fake rating model that records every message array it was asked to invoke. */
  const recordingModel = () => {
    const sent: { system: string; user: string }[] = [];
    const invoke = vi.fn(async (messages: unknown) => {
      const [system, user] = messages as { content: string }[];
      sent.push({ system: system.content, user: user.content });
      return { outcome: FAIL_CLOSED_VERDICT.outcome, reason: 'recorded' };
    });
    const model = { withStructuredOutput: vi.fn(() => ({ invoke })) } as unknown as BaseChatModel;
    return { model, sent, invoke };
  };

  const requestOf = (command: string): ClassifyRequest => ({
    caseId: 'case-1',
    tags: [],
    modelFree: false,
    rounds: [{ command }],
    forcedBy: [undefined],
  });

  /** Rate one command through the real classifier and return the user prompt that was SENT. */
  const sentUserFor = async (command: string, arm?: RaterPromptArm): Promise<string> => {
    const { buildRaterClassifier } = await import('#src/raterTarget.js');
    const { model, sent } = recordingModel();
    const classify = await buildRaterClassifier({ type: 'rater', rung: 'assisted' }, configOf(), {
      model,
      ...(arm ? { notes: arm } : {}),
    });
    await classify(requestOf(command));
    expect(sent).toHaveLength(1);
    return sent[0].user;
  };

  describe('the fixtures are what they claim, checked against the builders', () => {
    it('NOTED carries a composed note and is NOT floored; UNNOTED carries none', () => {
      expect(buildComposedOpenWorldNote(NOTED)).not.toBeNull();
      expect(findOpenWorldHostLiterals(NOTED)).toEqual([]);
      expect(buildComposedOpenWorldNote(UNNOTED)).toBeNull();
    });

    /**
     * **The deletion contract, pinned in the unit suite.** The arm finds a note's block as
     * `'\n\n' + <the builder's text>`, because `buildRaterPrompt` pushes each note into its line
     * buffer as `('', note)` and joins on `'\n'`. The runtime leak detector catches a change to that
     * join only on a run that is armed; this catches it on every build.
     */
    it("a note's block in the built prompt is a blank line followed by the builder's exact text", () => {
      const { user } = buildRaterPrompt(NOTED);
      expect(user).toContain(`\n\n${buildComposedOpenWorldNote(NOTED)}`);
      expect(user).toContain(`\n\n${buildParserPreflightNote(NOTED)}`);
    });
  });

  describe('what a suite can now express', () => {
    /**
     * **The A/B, on the same command, through the same classifier.** The unarmed half is the
     * control the acceptance asks for: it is what every `rung × model` cell sends today, and it
     * proves the armed assertion is not passing for some reason unrelated to the arm.
     */
    it('sends the note when unarmed and omits it when armed', async () => {
      const unarmed = await sentUserFor(NOTED);
      const armed = await sentUserFor(NOTED, OMIT_COMPOSED);

      expect(unarmed).toContain(COMPOSED_OPEN_WORLD_PREAMBLE);
      expect(armed).not.toContain(COMPOSED_OPEN_WORLD_PREAMBLE);
      expect(armed).not.toBe(unarmed);
    });

    /**
     * **The byte-identical control — the assertion that can actually fail if the facility leaks.**
     * A test that two arms DIFFER passes for any reason they differ, a bug included. This one is
     * the other half: on a command carrying no composed note, declaring the arm must change nothing
     * at all. It is arm-declared against no-arm (not on-arm against off-arm), which is what makes
     * it fail if the arm ever edits a prompt it was not asked to.
     */
    it('is byte-identical on a command that carries no such note', async () => {
      const unarmed = await sentUserFor(UNNOTED);
      const armed = await sentUserFor(UNNOTED, OMIT_COMPOSED);

      expect(armed).toBe(unarmed);
    });

    /** An arm removes the note it names and leaves every other note standing. */
    it('removes only the named note', async () => {
      const armed = await sentUserFor(NOTED, OMIT_COMPOSED);

      expect(armed).not.toContain(COMPOSED_OPEN_WORLD_PREAMBLE);
      expect(armed).toContain(buildParserPreflightNote(NOTED) as string);
    });

    /** Both registry notes at once, so the facility is not accidentally single-note. */
    it('removes both notes when both are named', async () => {
      const armed = await sentUserFor(NOTED, { omit: ['composed-open-world', 'parser'] });

      expect(armed).not.toContain(COMPOSED_OPEN_WORLD_PREAMBLE);
      expect(armed).not.toContain(buildParserPreflightNote(NOTED) as string);
      // The command itself is untouched — an arm edits our own notes, never the rated text.
      expect(armed).toContain('<command_to_evaluate>');
    });
  });

  describe('an arm that did not do what it said fails the run', () => {
    it('raises when the note core builds for this command is not in the prompt', async () => {
      const { reconcileArmedCapture } = await import('#src/raterPromptArm.js');

      expect(() =>
        reconcileArmedCapture(
          NOTED,
          OMIT_COMPOSED,
          {
            invoked: true,
            removed: [],
            absent: [],
            leaked: ['composed-open-world'],
          },
          undefined
        )
      ).toThrow(/could not remove \[composed-open-world\]/);
    });

    /**
     * The state `buildRaterClassifier` refuses to build, kept reachable here because it is the one
     * that reports the OTHER arm's numbers under this arm's name — the failure a comparison table
     * cannot show.
     */
    it('raises when the decorated model was never rung', async () => {
      const { reconcileArmedCapture } = await import('#src/raterPromptArm.js');

      expect(() =>
        reconcileArmedCapture(
          NOTED,
          OMIT_COMPOSED,
          {
            invoked: false,
            removed: [],
            absent: [],
            leaked: [],
          },
          undefined
        )
      ).toThrow(/never reached a rating call/);
    });

    it('refuses to build a classifier with an arm and no model to decorate', async () => {
      const { buildRaterClassifier } = await import('#src/raterTarget.js');

      await expect(
        buildRaterClassifier({ type: 'rater', rung: 'assisted' }, configOf(), {
          notes: OMIT_COMPOSED,
        })
      ).rejects.toThrow(/no rating model resolved/);
    });

    /** With no arm declared, the same model-less config builds exactly as it always has. */
    it('still builds with no arm and no model — the unarmed path is untouched', async () => {
      const { buildRaterClassifier } = await import('#src/raterTarget.js');

      await expect(
        buildRaterClassifier({ type: 'rater', rung: 'assisted' }, configOf())
      ).resolves.toBeTypeOf('function');
    });
  });

  /**
   * **The diagnostic record must describe the prompt that was SENT.** `rateShellCommand` fills the
   * capture from the builder at the send site and its contract is that nothing downstream leaves the
   * archive disagreeing with what the model saw. The arm edits the message below that point, so the
   * arm owes the correction — and for a facility whose whole subject is prompt content, a record of
   * the wrong arm's prompt would be the worst artifact it could leave.
   */
  describe('the capture', () => {
    it('is rewritten to the prompt the arm actually sent', async () => {
      const { reconcileArmedCapture } = await import('#src/raterPromptArm.js');
      const capture = {
        at: 'now',
        timeoutMs: 1,
        negotiable: false,
        prompt: { system: 's', user: 'the note-on prompt' },
      } as RaterCallCapture;

      reconcileArmedCapture(
        NOTED,
        OMIT_COMPOSED,
        {
          invoked: true,
          removed: ['composed-open-world'],
          absent: [],
          leaked: [],
          sent: { system: 's', user: 'the note-off prompt' },
        },
        capture
      );

      expect(capture.prompt).toEqual({ system: 's', user: 'the note-off prompt' });
    });
  });

  describe('stripRaterPromptNotes', () => {
    it('reports a note that does not apply as absent, and changes nothing', async () => {
      const { stripRaterPromptNotes } = await import('#src/raterPromptArm.js');
      const { user } = buildRaterPrompt(UNNOTED);

      const out = stripRaterPromptNotes(user, UNNOTED, OMIT_COMPOSED);

      expect(out.user).toBe(user);
      expect(out.absent).toEqual(['composed-open-world']);
      expect(out.removed).toEqual([]);
      expect(out.leaked).toEqual([]);
    });

    it('reports a note it was told exists and could not find as leaked', async () => {
      const { stripRaterPromptNotes } = await import('#src/raterPromptArm.js');

      const out = stripRaterPromptNotes('a prompt with no notes in it', NOTED, OMIT_COMPOSED);

      expect(out.leaked).toEqual(['composed-open-world']);
      expect(out.removed).toEqual([]);
    });
  });
});

/**
 * [[BATCH-31]] — the declaration surface: what a suite file may write, and the control that the new
 * axis kind is distinguishable from the two that came before it.
 */
describe('[[BATCH-31]] the `notes:` sweep axis', () => {
  const parse = async (yaml: string) => {
    const { parseEvalSuite } = await import('#src/evalSuite.js');
    return parseEvalSuite(yaml);
  };

  /** Derived from the gate's own vocabularies, so a renamed outcome needs no edit here — the same
   * rule `raterTarget.spec.ts` follows, and the classification a `rater` suite must fully declare. */
  const RATER_HEAD =
    'target: { type: rater, rung: auto }\n' +
    `classification: { labels: [${RATER_OUTCOMES.join(', ')}], ` +
    `actions: [${RATER_ACTIONS.join(', ')}] }\n`;
  const RATER_TAIL = `cases: [{ id: a, prompt: "ls -la", expect_label: ${RATER_OUTCOMES[0]} }]\n`;

  const armSweep = (offValue: string): string =>
    `${RATER_HEAD}sweep:\n  axes:\n    - name: note\n      values:\n` +
    '        - { name: on, notes: { omit: [] } }\n' +
    `        - { name: off, ${offValue} }\n${RATER_TAIL}`;

  it('parses the one-file A/B EXT-81 could not express', async () => {
    const suite = await parse(armSweep('notes: { omit: [composed-open-world] }'));

    expect(suite.sweep?.axes[0].values[0].notes).toEqual({ omit: [] });
    expect(suite.sweep?.axes[0].values[1].notes).toEqual({ omit: ['composed-open-world'] });
  });

  it('accepts the baseline arm as a declaration in its own right', async () => {
    const suite = await parse(
      `${RATER_HEAD}sweep:\n  axes:\n    - name: note\n      values: [{ name: on, notes: { omit: [] } }]\n${RATER_TAIL}`
    );

    expect(suite.sweep?.axes[0].values[0].notes).toEqual({ omit: [] });
  });

  it('rejects a note name gth does not export a builder for', async () => {
    await expect(parse(armSweep('notes: { omit: [open-world-floor] }'))).rejects.toThrow(
      /omits unknown rater prompt note "open-world-floor"/
    );
  });

  it('rejects the axis on a target that runs an agent', async () => {
    await expect(
      parse(
        'target: { type: gth-agent }\nsweep:\n  axes:\n    - name: note\n' +
          '      values: [{ name: off, notes: { omit: [composed-open-world] } }]\n' +
          'cases: [{ id: a, prompt: p, must_contain: [x] }]\n'
      )
    ).rejects.toThrow(/means nothing for a "gth-agent" target/);
  });

  describe('expandSweep', () => {
    it('carries the arm to the cell without merging it into the cell config', async () => {
      const { expandSweep } = await import('#src/evalCompare.js');

      const cells = expandSweep({
        axes: [
          {
            name: 'note',
            values: [
              { name: 'on', notes: { omit: [] } },
              { name: 'off', notes: { omit: ['composed-open-world'] } },
            ],
          },
        ],
      });

      expect(cells).toHaveLength(2);
      expect(cells[0].notes).toEqual({ omit: [] });
      expect(cells[1].notes).toEqual({ omit: ['composed-open-world'] });
      // The enforcement leg: the omission is never a config value, so it can never be written where
      // a config can be written — which is every carrier a live session could read.
      expect(cells[0].config).toEqual({});
      expect(cells[1].config).toEqual({});
    });

    /**
     * **The control the acceptance asks for: the tests can tell the old axes from the new one.** A
     * `rung × model` sweep expands exactly as it did, and no cell of it carries an arm — so a
     * classifier built from one is never armed, and the existing sweep's behaviour is unchanged.
     */
    it('leaves a rung × model sweep with no arm at all', async () => {
      const { expandSweep } = await import('#src/evalCompare.js');

      const cells = expandSweep({
        axes: [
          {
            name: 'rung',
            values: [
              { name: 'assisted', config: { approvals: 'assisted' } },
              { name: 'auto', config: { approvals: 'auto' } },
            ],
          },
          { name: 'model', values: [{ name: 'flash', model: 'gemini-3.6-flash' }] },
        ],
      });

      expect(cells.map((cell) => cell.name)).toEqual([
        'rung=assisted · model=flash',
        'rung=auto · model=flash',
      ]);
      expect(cells.every((cell) => cell.notes === undefined)).toBe(true);
      expect(cells[1].config).toEqual({ approvals: 'auto' });
      expect(cells[1].model).toBe('gemini-3.6-flash');
    });

    it('lets a later axis replace an earlier arm rather than merging the two', async () => {
      const { expandSweep } = await import('#src/evalCompare.js');

      const cells = expandSweep({
        axes: [
          { name: 'a', values: [{ name: 'p', notes: { omit: ['parser'] } }] },
          { name: 'b', values: [{ name: 'c', notes: { omit: ['composed-open-world'] } }] },
        ],
      });

      expect(cells[0].notes).toEqual({ omit: ['composed-open-world'] });
    });
  });
});
