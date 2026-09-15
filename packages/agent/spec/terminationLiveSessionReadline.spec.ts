/**
 * [[EXT-159]] — **the reason reaches the live session on the plain / readline surface.**
 *
 * This is where a user lands whenever the Ink TUI cannot run — no TTY, `--no-tui`, a CI log, an
 * incomplete install — and it showed exactly what the TUI did about a stop: the wrapped error
 * sentence, or on a turn that ended without throwing, nothing at all. The prompt simply came back.
 *
 * The line is read from the RUNNER at the turn boundary rather than inferred from the answer text,
 * because the endings this exists for are the ones that return normally with nothing to infer from:
 * a cancelled turn, an exhausted approval drain, a turn that produced no content.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';
import { terminationReason } from '@gaunt-sloth/core/core/terminationReason.js';
import { TERMINATION_NOTICE_TITLE_PREFIX } from '@gaunt-sloth/core/core/terminationNotice.js';
import { OUTSTANDING_WORK_NOTICE_TITLE_PREFIX } from '@gaunt-sloth/core/core/outstandingWork.js';
import { RUN_RECAP_TITLE_PREFIX } from '@gaunt-sloth/core/core/runRecap.js';

let turnsAsked = 0;
let scriptedTurns: string[] = ['hello there'];
const rlQuestionMock = vi.fn(async (prompt: string) => {
  if (typeof prompt === 'string' && prompt.includes('>')) {
    const turn = scriptedTurns[turnsAsked] ?? 'exit';
    turnsAsked += 1;
    return turn;
  }
  return '';
});
// GS2-20 — the history recorder is stubbed: this spec does not test history, and with
// recording on by default a config naming no `dbPath` would resolve the user's real
// `~/.gsloth/history.db` and write to it. Plain functions, not vi.fn, so a
// `vi.resetAllMocks()` in beforeEach cannot strip their return values.
vi.mock('@gaunt-sloth/core/history/recordSession.js', () => ({
  openConversationSafe: () => null,
  recordSessionSafe: () => null,
  lookupConversationThreadSafe: () => null,
}));
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: vi.fn() })),
  error: vi.fn(),
  exit: vi.fn(),
  getProjectDir: vi.fn(() => '/proj'),
  getUseColour: vi.fn(() => false),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  stdout: { isTTY: true, columns: 120 },
}));

const consoleUtilsMock = vi.hoisted(() => ({
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayDialogLine: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayLaunchBanner: vi.fn(),
  // [[EXT-165]] — the ONE writer both notice renderers on this surface go through (the termination
  // notice and `printNotice`). Omitted, `displayTermination` throws into its own fail-soft catch
  // and every cell below passes with nothing in front of the user.
  displayNotice: vi.fn(),
  displayWarning: vi.fn(),
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const initConfigMock = vi.hoisted(() => vi.fn());
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));

vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null),
}));

const runnerInstanceMock = vi.hoisted(() => ({
  init: vi.fn(),
  processMessages: vi.fn(),
  getRunStats: vi.fn(() => ({ tools: [] })),
  getTerminationReason: vi.fn(),
  // [[EXT-158]]/[[EXT-178]] — the other two end-of-turn reads this surface makes. Present on the
  // double so the reads reach real code: omitted, each one throws into the fail-soft catch and
  // every cell here goes green with the whole end-of-turn report unwired.
  getOutstandingWork: vi.fn(() => null),
  requestRunRecap: vi.fn(async () => null),
  setApprovalOutcomeCallback: vi.fn(),
  setToolApprovalCallback: vi.fn(),
  setAttackHaltCallback: vi.fn(),
  setNegotiationDisplay: vi.fn(),
  getAgent: vi.fn(() => null),
  cleanup: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('@langchain/langgraph', () => ({ MemorySaver: vi.fn() }));
// GS2-20 — the session's checkpointer comes from this seam. Stubbed here so the spec does not
// load the real SQLite saver (which needs more of @langchain/langgraph than the stub above
// provides, and would open a database this spec has no interest in). A plain function, not a
// vi.fn, so a `vi.resetAllMocks()` in beforeEach cannot strip its return value.
vi.mock('@gaunt-sloth/core/history/sessionCheckpointer.js', () => ({
  openSessionCheckpointerSafe: () => ({
    saver: {},
    durable: false,
    threadId: 'test-thread-id',
    close: () => {},
  }),
}));
vi.mock('#src/resolvers.js', () => ({ createResolvers: vi.fn(() => ({})) }));
vi.mock('#src/core/resolveAgentFactory.js', () => ({ resolveAgentFactory: vi.fn(() => vi.fn()) }));

const sessionConfig = {
  mode: 'code',
  readModePrompt: () => null,
  description: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

/**
 * The NOTICES the session put in front of a person — each flattened title-then-body, from the one
 * call that carried both.
 *
 * [[EXT-165]] — read only from `displayNotice`, never from the per-line helpers, and that is the
 * property rather than a detail. A notice rendered the old way makes no call here at all, so a
 * regression that put the title and the body back on two streams reds these cells; a reader that
 * also scanned `display`/`displayWarning`/`displayInfo` would go green on exactly that regression.
 */
const noticesShown = (): string[] =>
  consoleUtilsMock.displayNotice.mock.calls.map((call) =>
    [String(call[0]), ...(call[1] as readonly string[])].join('\n')
  );

/** Everything the session put in front of a person through the ordinary PER-LINE helpers. */
const saidToUser = (): string =>
  [
    ...consoleUtilsMock.displayWarning.mock.calls,
    ...consoleUtilsMock.display.mock.calls,
    ...consoleUtilsMock.displayInfo.mock.calls,
  ]
    .map((call) => String(call[0]))
    .join('\n');

async function runOneTurn(): Promise<void> {
  const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
  await createInteractiveSession(sessionConfig, {});
}

describe('[[EXT-159]] SURFACE — the readline session says why the turn ended', () => {
  beforeEach(() => {
    turnsAsked = 0;
    scriptedTurns = ['hello there'];
    vi.clearAllMocks();
    initConfigMock.mockResolvedValue({ streamSessionInferenceLog: false });
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue('the answer');
    runnerInstanceMock.getRunStats.mockReturnValue({ tools: [] });
    runnerInstanceMock.getTerminationReason.mockReturnValue(null);
    runnerInstanceMock.getOutstandingWork.mockReturnValue(null);
    runnerInstanceMock.requestRunRecap.mockResolvedValue(null);
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
  });

  /**
   * The exact shape [[TUI-C62]] describes: the turn returns cleanly, the answer is empty, and until
   * now the prompt just came back. Nothing threw, so no error rendering could have covered it.
   */
  it('states a cancellation that ended the turn with no error anywhere', async () => {
    runnerInstanceMock.processMessages.mockResolvedValue('');
    runnerInstanceMock.getTerminationReason.mockReturnValue(
      terminationReason('runner.events-cancelled', 'control', {
        category: 'cancelled',
        detail: 'signal',
      })
    );

    await runOneTurn();

    // One notice, title and body together, so a redirect cannot keep the heading and lose the code.
    expect(noticesShown()).toHaveLength(1);
    expect(noticesShown()[0]).toContain(TERMINATION_NOTICE_TITLE_PREFIX);
    // The quotable code, which is the fact a bug report needs and the sentence is derived from.
    expect(noticesShown()[0]).toContain('cancelled@runner.events-cancelled');
    expect(saidToUser()).not.toContain(TERMINATION_NOTICE_TITLE_PREFIX);
  });

  it('states a provider fault with the classification the wrapped sentence never carried', async () => {
    runnerInstanceMock.processMessages.mockResolvedValue('');
    runnerInstanceMock.getTerminationReason.mockReturnValue(
      terminationReason('runner.stream-error', 'exception', {
        category: 'rate_limited',
        detail: '429',
      })
    );

    await runOneTurn();

    expect(noticesShown()).toHaveLength(1);
    expect(noticesShown()[0]).toContain('rate_limited@runner.stream-error');
    // And what to do about it, read off the posture the taxonomy already decided. In the SAME
    // notice as the code above: the remedy is useless to a reader who did not receive the code.
    expect(noticesShown()[0]).toContain('Wait a moment');
    expect(saidToUser()).not.toContain('rate_limited@runner.stream-error');
  });

  it('adds nothing to a turn that simply finished', async () => {
    runnerInstanceMock.getTerminationReason.mockReturnValue(
      terminationReason('runner.completed', 'control', 'completed')
    );

    await runOneTurn();

    expect(noticesShown()).toEqual([]);
    expect(saidToUser()).not.toContain(TERMINATION_NOTICE_TITLE_PREFIX);
  });

  it('keeps the session alive when the runner cannot answer why the turn ended', async () => {
    runnerInstanceMock.getTerminationReason.mockImplementation(() => {
      throw new Error('no such method');
    });

    await expect(runOneTurn()).resolves.not.toThrow();
  });
});

/**
 * [[EXT-178]] SURFACE — **the plain / readline session draws the end-of-run recap.**
 *
 * This surface is where a user lands whenever the Ink TUI cannot run, and the cells above show it
 * had nothing at all for a turn that simply finished. These prove the other half of that: when the
 * user has switched the recap on, the clean turn stops being silent — and that exactly one of the
 * two surfaces speaks about it.
 *
 * Unlike the TUI, this one **awaits** the recap before the prompt comes back. There is nothing on
 * screen here but a cursor, so a paragraph arriving after the prompt would be typed over.
 */
describe('[[EXT-178]] SURFACE — the readline session recaps a clean turn', () => {
  const outstanding = {
    outstanding: 2,
    completed: 3,
    total: 5,
    inProgress: 1,
    signature: 'sig-a',
    repeat: false,
  };

  const recap = {
    goal: 'Thread the recap rung through',
    happened: 'Edited the schema and rebuilt.',
    outstanding: 'The docs page is still to write.',
    complete: false,
    work: outstanding,
  };

  beforeEach(() => {
    turnsAsked = 0;
    scriptedTurns = ['hello there'];
    vi.clearAllMocks();
    initConfigMock.mockResolvedValue({ streamSessionInferenceLog: false });
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue('the answer');
    runnerInstanceMock.getRunStats.mockReturnValue({ tools: [] });
    runnerInstanceMock.getTerminationReason.mockReturnValue(
      terminationReason('runner.completed', 'control', 'completed')
    );
    runnerInstanceMock.getOutstandingWork.mockReturnValue(null);
    runnerInstanceMock.requestRunRecap.mockResolvedValue(null);
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
  });

  it('breaks the silence on the one stop that had none', async () => {
    runnerInstanceMock.requestRunRecap.mockResolvedValue(recap);

    await runOneTurn();

    expect(noticesShown()).toHaveLength(1);
    expect(noticesShown()[0]).toContain(RUN_RECAP_TITLE_PREFIX);
    expect(noticesShown()[0]).toContain('Thread the recap rung through');
    expect(noticesShown()[0]).toContain('docs page is still to write');
  });

  it('draws the recap instead of the unfinished-checklist notice, and keeps its counts', async () => {
    runnerInstanceMock.getOutstandingWork.mockReturnValue(outstanding);
    runnerInstanceMock.requestRunRecap.mockResolvedValue(recap);

    await runOneTurn();

    expect(noticesShown()).toHaveLength(1);
    expect(noticesShown()[0]).not.toContain(OUTSTANDING_WORK_NOTICE_TITLE_PREFIX);
    expect(noticesShown()[0]).toContain('2 of 5 items not marked completed');
  });

  it('leaves the notice standing when the recap call fails', async () => {
    runnerInstanceMock.getOutstandingWork.mockReturnValue(outstanding);
    runnerInstanceMock.requestRunRecap.mockRejectedValue(new Error('provider down'));

    await runOneTurn();

    // The floor. A shared catch around both halves would leave this at zero.
    expect(noticesShown()).toHaveLength(1);
    expect(noticesShown()[0]).toContain(OUTSTANDING_WORK_NOTICE_TITLE_PREFIX);
  });

  it('keeps a clean turn silent when no recap was produced and nothing was outstanding', async () => {
    await runOneTurn();

    expect(noticesShown()).toEqual([]);
  });
});
