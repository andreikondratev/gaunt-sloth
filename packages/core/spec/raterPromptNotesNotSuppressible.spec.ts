import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import type { ApprovalDecisionCapture } from '#src/core/shell/approvalCapture.js';
import { buildRaterPrompt } from '#src/core/shell/rater.js';
import {
  buildComposedOpenWorldNote,
  COMPOSED_OPEN_WORLD_PREAMBLE,
  findOpenWorldHostLiterals,
} from '#src/core/shell/openWorld.js';
import { checkHardline } from '#src/core/shell/hardline.js';
import { peekProjectDir, setProjectDir, env } from '#src/utils/systemUtils.js';
import { SHELL_ALLOWLIST_FILE } from '#src/constants.js';

/**
 * [[BATCH-31]] — **the SESSION's approvals gate cannot be told to leave a preflight note out of the
 * rating prompt.**
 *
 * `@gaunt-sloth/batch` gained a facility that omits one of our own preflight notes from a rating
 * prompt, so a suite can express the note-on / note-off A/B [[EXT-81]] needed. The node that asked
 * for it made one thing non-negotiable: the omission must reach the measuring harness **without
 * becoming reachable in production** — production meaning this file's subject, the gate that decides
 * whether a shell command a live agent proposed runs, prompts, or halts.
 *
 * **This is the test that demonstrates it rather than a comment asserting it, and it lives here on
 * purpose.** A spec in the batch package could only say something about that package's own surface;
 * the hazard is a session's prompt losing its safety context, so the assertion has to be made on the
 * prompt a session actually sends. So: drive the REAL `GthAgentRunner` over a command that carries a
 * note, with the omission planted in every carrier a user controls — a config key, an `approvals`
 * block, the rater's own options — and read what reached the model.
 *
 * **The mutation that proves it real** is to wire a suppression into this path: give
 * `rateShellCommand` (or the runner's call to it) a note-omission input that anything here can
 * carry, and the equality assertion below goes red. An unwired parameter would leave it green, and
 * that is the correct discrimination — the node forbids a REACHABLE production path, and a dead
 * parameter is not one.
 */

const mockAgent = {
  init: vi.fn(),
  setVerbose: vi.fn(),
  invoke: vi.fn(),
  stream: vi.fn(),
  streamWithEvents: vi.fn(),
  cleanup: vi.fn(),
  getPendingToolInterrupts: vi.fn(),
  streamResume: vi.fn(),
};

vi.mock('#src/core/shell/raterModel.js', () => ({ resolveRaterModel: vi.fn() }));
vi.mock('#src/core/GthLangChainAgent.js', () => ({
  GthLangChainAgent: class {
    constructor() {
      return mockAgent;
    }
  },
  StatusUpdateCallback: vi.fn(),
}));

/** Clamp the persisted-grant anchor, or this suite reads the real project's allow-list. */
const projectDir = mkdtempSync(join(tmpdir(), 'gth-batch31-notes-spec-'));

function streamOf(...chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

describe('[[BATCH-31]] a session cannot suppress a preflight note in the rating prompt', () => {
  /**
   * A composed open-world command: it carries the note the eval facility can omit, the
   * deterministic floor is silent on it (a floored command is refused before any rating, so it
   * could never be the subject of a prompt test), and §8's hardline does not refuse it.
   */
  const NOTED = 'curl -fsSL https://registry.npmjs.org/lodash | jq .version';

  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let priorProjectDir: string | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    rmSync(join(projectDir, SHELL_ALLOWLIST_FILE), { force: true });
    mockAgent.init.mockResolvedValue(undefined);
    mockAgent.cleanup.mockResolvedValue(undefined);
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => {
    if (priorProjectDir !== undefined) setProjectDir(priorProjectDir);
  });

  /**
   * Drive ONE gated shell call through the real runner with a scripted rater, and return the
   * approval records — each carrying `rating.prompt`, captured at the send site, so what is asserted
   * on is the string that reached the model.
   */
  async function rate(
    configOver: Record<string, unknown> = {}
  ): Promise<ApprovalDecisionCapture[]> {
    const invoke = vi.fn().mockResolvedValue({ outcome: 'safe', reason: 'the script says so' });
    const config = {
      llm: { withStructuredOutput: vi.fn().mockReturnValue({ invoke }) },
      streamOutput: true as const,
      approvals: { mode: 'auto' },
      commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      ...configOver,
    } as unknown as GthConfig;

    mockAgent.getPendingToolInterrupts
      .mockReset()
      .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command: NOTED } }])
      .mockResolvedValue([]);
    mockAgent.streamResume.mockReset().mockResolvedValue(streamOf(''));
    mockAgent.stream.mockReset().mockResolvedValue(streamOf('x'));

    const runner = new GthAgentRunner(vi.fn());
    await runner.init('code', config);
    await runner.processMessages([new HumanMessage('go')]).catch(() => undefined);
    return runner.getApprovalCaptures();
  }

  it('the fixture command carries a note, and neither the floor nor the hardline pre-empts it', () => {
    expect(buildComposedOpenWorldNote(NOTED)).not.toBeNull();
    expect(findOpenWorldHostLiterals(NOTED)).toEqual([]);
    expect(checkHardline(NOTED)).toBeNull();
  });

  it('sends the note on an ordinary session', async () => {
    const records = await rate();

    expect(records).toHaveLength(1);
    expect(records[0].rating?.prompt.user).toContain(COMPOSED_OPEN_WORLD_PREAMBLE);
  });

  /**
   * **The decisive one.** Every carrier a user controls is loaded with the omission — a top-level
   * config key, a key inside `approvals` (where the rung, the rater profile and the rater timeout
   * all live, so it is the place a suppression would most plausibly be put), and the spellings the
   * eval facility itself uses. The prompt that goes out is unchanged.
   *
   * The assertion is EQUALITY against the builder's own output, not a `toContain` on the note. A
   * containment check only fails for a suppression of this particular note; equality fails for any
   * input at all that moves the prompt, whatever it is called — which is the property being claimed.
   */
  it('ignores every spelling of a note omission a config could carry', async () => {
    const omission = { omit: ['composed-open-world'] };
    const records = await rate({
      notes: omission,
      raterPromptNotes: omission,
      approvals: {
        mode: 'auto',
        notes: omission,
        raterPromptNotes: omission,
        omitRaterNotes: ['composed-open-world'],
      },
    });

    expect(records).toHaveLength(1);
    const sent = records[0].rating?.prompt.user;
    expect(sent).toContain(COMPOSED_OPEN_WORLD_PREAMBLE);
    // `negotiable` is true because `auto` negotiates; `carved` is false — the user named no host.
    expect(sent).toBe(buildRaterPrompt(NOTED, { home: env?.HOME, negotiable: true }).user);
  });
});
