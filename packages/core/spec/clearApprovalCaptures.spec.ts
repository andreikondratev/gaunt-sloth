import { afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AIMessage, type BaseMessage, HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import type { StatusUpdateCallback } from '#src/core/types.js';
import type { ApprovalDecisionCapture } from '#src/core/shell/approvalCapture.js';
import { ALIGNMENT_TOOL_SUGGEST, ALIGNMENT_TOOL_VIEW } from '#src/core/shell/alignment.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { SHELL_ALLOWLIST_FILE } from '#src/constants.js';

/**
 * [[EXT-109]] — **`/clear` means the approvals capture log is gone too, and the per-turn reset
 * means it is not.**
 *
 * The subject is the ARCHIVE, not the log's internal state: a case that asserted
 * `ApprovalCaptureLog.clear()` was called would pass against a `clear()` that does nothing, and the
 * user's exposure is a file they attach to a bug report. So every case here writes a real
 * `/debug-dump` and reads what landed on disk.
 *
 * **The fixture leaks for the reason the product does.** The user's own words reach a captured
 * record through the ALIGNMENT CHECK's `user` role ([[EXT-127]] moved them there; the classifier
 * now rates the command alone), so the harness scripts BOTH gate models — the classifier through
 * `withStructuredOutput` and the checker through `bindTools` — which is what makes the check
 * reachable at all. Without the checker seam the capture carries no user message, and a case
 * asserting one is absent after the clear would pass whatever the clear did.
 *
 * The cases are one claim each, and no two of them can be collapsed:
 *
 * 1. a dump with no clear CARRIES the decision and the mandate (so a clear that empties the log
 *    unconditionally, or a dump that never had anything in it, is not what turns case 2 green);
 * 2. a dump after the user's `/clear` carries none of it;
 * 3. the PER-TURN `resetThread()` — what `runtime/conversation.ts` calls before every turn on the
 *    ACP and AG-UI surfaces — keeps the log, which is the regression the obvious one-line fix
 *    introduces and which case 2 cannot see;
 * 4. the clear still rotates the model's thread, which is what it did before this node and which
 *    every case above would pass without;
 * 5. capture goes on working afterwards, so the clear drops the records rather than the facility.
 *
 * **What these cases do NOT claim, and the distinction is not a technicality.** They are scoped to
 * the approvals channel — `approvals.json`, and the captured alignment prompt inside it — because
 * that is what this session owns and clears. The archive's `debug-log.txt` comes from the
 * always-on, PROCESS-GLOBAL ring buffer in `utils/debugUtils.ts`, which the runner writes every
 * turn's input messages into and which nothing here empties, so an archive written after a `/clear`
 * still carries the user's earlier turns through that file. Asserting over the whole archive
 * directory would therefore fail for a second reason with a different owner, and a case written to
 * pass anyway would be asserting that the archive is clean when it is not.
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

// `writeDebugDump` writes under `~/.gsloth`; only `homedir()` is mocked, so the real path building
// and the real fs writes are exercised without touching the developer's home.
const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn() }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: homedirMock };
});

/** EXT-71 — clamp the persisted-grant anchor, or this suite reads the real project's allow-list. */
const projectDir = mkdtempSync(join(tmpdir(), 'gth-clear-captures-spec-'));

/** The user's own words. Distinctive enough that no other value in the archive could match it. */
const MANDATE = 'please wipe the stale dist folder for me before the release, EXT-109 fixture';
/** A second session's words, for the case that keeps working after the clear. */
const LATER_MANDATE = 'now tidy up the coverage folder as well, EXT-109 fixture';
/** Rated `destructive` on its own merits, floored by neither preflight arm. */
const DESTRUCTIVE = 'rm -rf ./dist';
const LATER_DESTRUCTIVE = 'rm -rf ./coverage';

function streamOf(...chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

/** What a `/debug-dump` left on disk. */
interface DumpView {
  /** Whether `approvals.json` was written at all — it is omitted for an empty log. */
  hasApprovalsFile: boolean;
  /** The parsed records, or `[]` when the file was omitted. */
  records: ApprovalDecisionCapture[];
  /**
   * `approvals.json` exactly as written, or `''` when it was omitted — the bytes a reader of the
   * archive gets, after the redaction pass, rather than the runner's in-memory objects.
   */
  approvalsText: string;
  /** The archive's own directory listing, so a case can say which artifacts were written. */
  files: string[];
}

describe('[[EXT-109]] — the user’s /clear empties the approvals capture log; the per-turn reset does not', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let statusUpdate: Mock<StatusUpdateCallback>;
  let priorProjectDir: string | undefined;
  let homeDir: string;
  let notGitDir: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    rmSync(join(projectDir, SHELL_ALLOWLIST_FILE), { force: true });
    homeDir = mkdtempSync(join(tmpdir(), 'gth-clear-captures-home-'));
    notGitDir = mkdtempSync(join(tmpdir(), 'gth-clear-captures-notgit-'));
    homedirMock.mockReturnValue(homeDir);
    mockAgent.init.mockResolvedValue(undefined);
    mockAgent.cleanup.mockResolvedValue(undefined);
    statusUpdate = vi.fn();
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => {
    if (priorProjectDir !== undefined) setProjectDir(priorProjectDir);
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(notGitDir, { recursive: true, force: true });
  });

  /**
   * A live session on the `auto` rung whose gate has both models scripted: the classifier always
   * answers `destructive`, and the checker always views and then suggests a change. A `destructive`
   * rating at a negotiating rung is what makes the alignment check reachable, and the check is what
   * puts the user's own words in the record.
   */
  async function startSession() {
    const classifierInvoke = vi.fn().mockResolvedValue({
      outcome: 'destructive',
      reason: 'destructive because the script says so',
    });
    // One `bindTools` call per check (`runAlignmentCheck` binds once, then loops), so each check
    // gets its own turn counter: view first, then the decision the tool contract requires.
    const bindTools = vi.fn(() => {
      const script = [
        [{ name: ALIGNMENT_TOOL_VIEW, args: {} }],
        [{ name: ALIGNMENT_TOOL_SUGGEST, args: { reason: 'name the folder you mean' } }],
      ];
      let turn = 0;
      return {
        invoke: vi.fn(async (_conversation: BaseMessage[]) => {
          const calls = script[turn] ?? [];
          turn += 1;
          return new AIMessage({
            content: '',
            tool_calls: calls.map((call, i) => ({ ...call, id: `check-${turn}-${i}` })),
          });
        }),
      };
    });

    const config = {
      llm: {
        withStructuredOutput: vi.fn().mockReturnValue({ invoke: classifierInvoke }),
        bindTools,
      },
      streamOutput: true as const,
      approvals: { mode: 'auto' },
      commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
    } as unknown as GthConfig;

    const runner = new GthAgentRunner(statusUpdate);
    await runner.init('code', config);

    /** One turn in which the agent asks to run `command`, and the gate decides it. */
    async function gatedTurn(userMessage: string, command: string): Promise<void> {
      mockAgent.getPendingToolInterrupts
        .mockReset()
        .mockResolvedValueOnce([{ name: 'run_shell_command', args: { command } }])
        .mockResolvedValue([]);
      mockAgent.streamResume.mockReset().mockResolvedValue(streamOf(''));
      mockAgent.stream.mockReset().mockResolvedValue(streamOf('x'));
      await runner.processMessages([new HumanMessage(userMessage)]).catch(() => undefined);
    }

    /** Write a real `/debug-dump` from this runner and read back what landed. */
    async function dump(): Promise<DumpView> {
      const { writeDebugDump } = await import('#src/utils/debugDump.js');
      const { archiveDir } = writeDebugDump({
        transcript: [],
        config,
        cwd: notGitDir,
        approvals: runner.getApprovalCaptures(),
      });
      const approvalsPath = resolve(archiveDir, 'approvals.json');
      const hasApprovalsFile = existsSync(approvalsPath);
      const approvalsText = hasApprovalsFile ? readFileSync(approvalsPath, 'utf8') : '';
      return {
        hasApprovalsFile,
        records: hasApprovalsFile ? (JSON.parse(approvalsText) as ApprovalDecisionCapture[]) : [],
        approvalsText,
        files: readdirSync(archiveDir).filter((name) =>
          statSync(resolve(archiveDir, name)).isFile()
        ),
      };
    }

    return { runner, gatedTurn, dump };
  }

  /** The `human` role of the alignment check recorded on a captured decision. */
  function checkerUserMessage(record: ApprovalDecisionCapture | undefined): string {
    expect(record?.alignment, 'the gated call recorded no alignment check').toBeDefined();
    expect(
      record?.alignment?.failClosed,
      'the check failed closed, so it proves nothing about what was sent'
    ).toBeUndefined();
    return record?.alignment?.messages.find((message) => message.role === 'human')?.content ?? '';
  }

  /**
   * **The control, and it is not decorative.** It establishes that this fixture leaks: the archive
   * carries the gated decision AND the user's own words, through the channel the product carries
   * them through. Without it, a `clear()` that ran on every dump — or a fixture that never captured
   * anything — would make the case below green for the wrong reason.
   */
  it('a dump taken with NO /clear carries the gated decision and the user’s own words', async () => {
    const session = await startSession();
    await session.gatedTurn(MANDATE, DESTRUCTIVE);

    const dumped = await session.dump();
    expect(dumped.hasApprovalsFile).toBe(true);
    expect(dumped.records).toHaveLength(1);
    expect(dumped.records[0].command).toBe(DESTRUCTIVE);
    // The leak channel, named: the user's mandate is inside the captured alignment prompt, and it
    // is in the written bytes rather than only in the runner's memory.
    expect(checkerUserMessage(dumped.records[0])).toContain(MANDATE);
    expect(dumped.approvalsText).toContain(MANDATE);
  });

  /**
   * **The acceptance.** `/clear` is the gesture that means *drop that*, and the dump is the file
   * the user then attaches to an issue, so nothing captured before it may survive into one.
   *
   * An empty log makes the writer omit `approvals.json` altogether, so the absence of the file and
   * the absence of the text are asserted together: the first says the artifact is gone, the second
   * says nothing of it survived into the bytes, and the file-listing assertion says the dump was
   * still written (an archive that failed to write would satisfy the other two for free).
   */
  it('a dump taken after the user’s /clear carries no record from before it', async () => {
    const session = await startSession();
    await session.gatedTurn(MANDATE, DESTRUCTIVE);

    session.runner.clearConversation();

    const dumped = await session.dump();
    expect(dumped.files).toContain('transcript.json');
    expect(dumped.hasApprovalsFile).toBe(false);
    expect(dumped.records).toEqual([]);
    expect(dumped.approvalsText).not.toContain(MANDATE);
    expect(dumped.approvalsText).not.toContain(DESTRUCTIVE);
  });

  /**
   * **The regression the obvious fix introduces.** `runtime/conversation.ts` calls `resetThread()`
   * before EVERY turn, so wiring the clear into the rotation would empty the log once per turn on
   * the ACP and AG-UI surfaces — silently, because an empty section reads as *no ratings happened*,
   * and on exactly the surfaces a bug report is most likely to be filed from.
   */
  it('the PER-TURN thread reset keeps the log (the ACP and AG-UI surfaces)', async () => {
    const session = await startSession();
    await session.gatedTurn(MANDATE, DESTRUCTIVE);

    session.runner.resetThread();

    const dumped = await session.dump();
    expect(dumped.hasApprovalsFile).toBe(true);
    expect(dumped.records).toHaveLength(1);
    expect(dumped.records[0].command).toBe(DESTRUCTIVE);
    expect(dumped.approvalsText).toContain(MANDATE);
  });

  /**
   * **The clear still does everything the reset did** (TUI-C8): the model's thread rotates, so the
   * next turn cannot retrieve the conversation the user just dropped. Splitting the gesture off the
   * primitive must not take the rotation with it, and nothing else in this file would notice if it
   * had — every case above would pass on a clear that emptied the log and left the thread alone.
   */
  it('rotates the model thread as well, so the next turn starts from an empty context', async () => {
    const session = await startSession();
    await session.gatedTurn(MANDATE, DESTRUCTIVE);
    const before = mockAgent.stream.mock.calls.at(-1)?.[1]?.configurable?.thread_id;

    session.runner.clearConversation();
    await session.gatedTurn(LATER_MANDATE, LATER_DESTRUCTIVE);
    const after = mockAgent.stream.mock.calls.at(-1)?.[1]?.configurable?.thread_id;

    expect(before).toEqual(expect.any(String));
    expect(after).toEqual(expect.any(String));
    expect(after).not.toBe(before);
  });

  /**
   * The clear drops what was captured; it does not turn capture off. A fix that left the log
   * unusable afterwards would take the facility away from the session that just cleared, and the
   * dump would be silent about every decision the rest of that session made.
   */
  it('keeps capturing after the clear, and the new record stands alone', async () => {
    const session = await startSession();
    await session.gatedTurn(MANDATE, DESTRUCTIVE);
    session.runner.clearConversation();
    await session.gatedTurn(LATER_MANDATE, LATER_DESTRUCTIVE);

    const dumped = await session.dump();
    expect(dumped.records).toHaveLength(1);
    expect(dumped.records[0].command).toBe(LATER_DESTRUCTIVE);
    expect(checkerUserMessage(dumped.records[0])).toContain(LATER_MANDATE);
    expect(dumped.approvalsText).not.toContain(MANDATE);
    expect(dumped.approvalsText).not.toContain(DESTRUCTIVE);
  });
});
