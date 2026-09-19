import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';

/**
 * GS2-88 — `/history` `/insights` `/search` `/reasoning` on the PLAIN READLINE (`--no-tui`)
 * surface.
 *
 * **The central cell is a discriminating pair, and it has to be.** Before this node the readline
 * session passed none of the context fields these commands read, so every one of them took its
 * "unavailable" branch unconditionally — and that branch named the user's config as the cause. The
 * two sides of the pair below therefore produced *identical* output on the unfixed code: an
 * assertion that only checked the history-off side passed then, and would go on passing through a
 * regression that unwired the whole thing again. So the pair is asserted as a pair, with the
 * SAME seeded store on both sides and only `history.enabled` differing between them — which is
 * also what stops the difference coming from whether a database file happened to exist.
 *
 * The store is REAL here (a temp DB, seeded by this spec); the recorder and the checkpointer are
 * stubbed so the session under test writes nothing into it and the rows asserted on are exactly
 * the rows this spec put there.
 */

// Scripted readline: each `rl.question` call pops the next input; 'exit' as a safety default.
let inputs: string[] = [];
const rlQuestionMock = vi.fn(async () => inputs.shift() ?? 'exit');
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: vi.fn() })),
  error: vi.fn(),
  exit: vi.fn(),
  getCurrentWorkDir: vi.fn(() => '/proj'),
  getProjectDir: vi.fn(() => '/proj'),
  peekProjectDir: vi.fn(() => '/proj'),
  getUseColour: vi.fn(() => false),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  stdout: { isTTY: true },
}));

const consoleUtilsMock = {
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayLaunchBanner: vi.fn(),
  // [[EXT-165]] — every command notice arrives here as one call carrying title AND body.
  displayNotice: vi.fn(),
  displayWarning: vi.fn(),
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const initConfigMock = vi.fn();
// Partial mock (spread the real module): the shared registry reads the real approvals vocabulary
// while building the `/approvals` entry, so a bare stub makes the session fail to start.
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));

vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null),
}));

// The session's own recorder writes nothing: the only rows in the store are the ones this spec
// seeds, so `/history` showing them proves the READ path and nothing else.
vi.mock('@gaunt-sloth/core/history/recordSession.js', () => ({
  openConversationSafe: () => null,
  recordSessionSafe: () => null,
  lookupConversationThreadSafe: () => null,
}));
vi.mock('@gaunt-sloth/core/history/sessionCheckpointer.js', () => ({
  openSessionCheckpointerSafe: () => ({
    saver: {},
    durable: false,
    threadId: 'test-thread-id',
    close: () => {},
  }),
}));

const runnerInstanceMock = {
  init: vi.fn(),
  processMessages: vi.fn(),
  setApprovalOutcomeCallback: vi.fn(),
  setToolApprovalCallback: vi.fn(),
  setAttackHaltCallback: vi.fn(),
  setNegotiationDisplay: vi.fn(),
  setSessionGrantsListener: vi.fn(),
  getSessionApprovals: vi.fn(),
  getAllowlistCounts: vi.fn(),
  getSessionScopedGrants: vi.fn(() => []),
  getRunStats: vi.fn(() => ({ tools: [] })),
  getTerminationReason: vi.fn(() => null),
  getFinishReasonObservations: vi.fn(() => []),
  getOutstandingWork: vi.fn(() => null),
  requestRunRecap: vi.fn(async () => null),
  cleanup: vi.fn(),
};
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('@langchain/langgraph', () => ({ MemorySaver: vi.fn() }));
vi.mock('#src/resolvers.js', () => ({ createResolvers: vi.fn(() => ({})) }));
vi.mock('#src/core/resolveAgentFactory.js', () => ({ resolveAgentFactory: vi.fn(() => vi.fn()) }));

const sessionConfig = {
  mode: 'chat',
  readModePrompt: () => null,
  description: 'chat',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

/** The prompt text seeded into the store — a string nothing else in this spec can produce. */
const SEEDED_PROMPT = 'how do I refactor the widget factory';

describe('interactiveSessionModule — readline /history /insights /search /reasoning (GS2-88)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    inputs = [];
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-readline-histslash-'));
    dbPath = resolve(dir, 'history.db');
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue('the answer');
    runnerInstanceMock.getRunStats.mockReturnValue({ tools: [] });
    runnerInstanceMock.getTerminationReason.mockReturnValue(null);
    runnerInstanceMock.getFinishReasonObservations.mockReturnValue([]);
    runnerInstanceMock.getOutstandingWork.mockReturnValue(null);
    runnerInstanceMock.requestRunRecap.mockResolvedValue(null);
    runnerInstanceMock.getSessionScopedGrants.mockReturnValue([]);
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Put one real recorded turn in the store this session will read. */
  const seedOneTurn = async (): Promise<void> => {
    const { openHistoryStore } = await import('@gaunt-sloth/core/history/historyStore.js');
    const store = openHistoryStore(dbPath, { create: true })!;
    expect(store).not.toBeNull();
    store.record({
      command: 'chat',
      model: 'seeded-model',
      prompt: SEEDED_PROMPT,
      response: 'extract a builder',
    });
    store.close();
  };

  /** Run a readline session that types `userInputs` and then exits, and return its notices. */
  const runSession = async (
    history: Record<string, unknown>,
    ...userInputs: string[]
  ): Promise<Array<{ title: string; lines: readonly string[] }>> => {
    consoleUtilsMock.displayNotice.mockClear();
    consoleUtilsMock.displayInfo.mockClear();
    inputs = [...userInputs, 'exit'];
    initConfigMock.mockResolvedValue({
      streamSessionInferenceLog: false,
      modelDisplayName: 'test-model',
      history,
    });
    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});
    return consoleUtilsMock.displayNotice.mock.calls.map((c) => ({
      title: String(c[0]),
      lines: c[1] as readonly string[],
    }));
  };

  /** The body of the one notice a single-command session produced. */
  const bodyOf = async (history: Record<string, unknown>, command: string): Promise<string> => {
    const notices = await runSession(history, command);
    expect(notices).toHaveLength(1);
    return notices[0].lines.join('\n');
  };

  const HISTORY_COMMANDS = ['/history', '/insights', '/search widget'] as const;

  /**
   * **The discriminating pair.** Same store, same rows, same everything — only `history.enabled`
   * differs. On the unfixed code both sides rendered the identical "history unavailable, check
   * your config" body, so this cell could not have passed; a one-sided cell could, which is the
   * whole reason it is written this way.
   */
  it.each([
    // command, and something only the STORE can have put in the history-on side's output.
    ['/history', SEEDED_PROMPT],
    ['/insights', 'Sessions: 1'],
    ['/search widget', 'widget'],
  ])(
    '%s differs between history ON and history OFF, against one and the same store',
    async (command, fromTheStore) => {
      await seedOneTurn();
      const on = await bodyOf({ dbPath }, command);
      const off = await bodyOf({ enabled: false, dbPath }, command);

      expect(on).not.toEqual(off);
      // ...and each side is pinned, because two different WRONG bodies would also differ.
      expect(on).toContain(fromTheStore);
      expect(off).not.toContain(fromTheStore);
      expect(off).toContain('history.enabled');
      expect(on).not.toContain('history.enabled');
    }
  );

  it.each(HISTORY_COMMANDS)(
    '%s on a session with history ON and nothing recorded yet blames neither the config nor the user',
    async (command) => {
      // No store file at all: the commonest first-run state, and the one the old builder read as
      // a config problem because "no store opened" was the only fact it had.
      const empty = await bodyOf({ dbPath }, command);
      expect(empty).toContain('is on');
      expect(empty).not.toContain('history.enabled');

      // And it is its own message: not the config one, and not the one with rows behind it.
      await seedOneTurn();
      const available = await bodyOf({ dbPath }, command);
      const disabled = await bodyOf({ enabled: false, dbPath }, command);
      expect(new Set([empty, available, disabled]).size).toBe(3);
    }
  );

  it('/history lists the conversation the store actually holds, with its model and prompt', async () => {
    await seedOneTurn();
    const notices = await runSession({ dbPath }, '/history');
    expect(notices[0].title).toBe('Recent sessions');
    const lines = notices[0].lines.join('\n');
    expect(lines).toContain('seeded-model');
    expect(lines).toContain(SEEDED_PROMPT);
  });

  it('/insights reports the store analytics, not an unavailability notice', async () => {
    await seedOneTurn();
    const lines = (await runSession({ dbPath }, '/insights'))[0].lines.join('\n');
    expect(lines).toContain('Sessions: 1');
  });

  it('/search runs a real full-text query against the store, and answers an empty one honestly', async () => {
    await seedOneTurn();
    const hit = (await runSession({ dbPath }, '/search widget'))[0].lines.join('\n');
    expect(hit).toContain('widget');
    const miss = (await runSession({ dbPath }, '/search zzzznotathing'))[0].lines.join('\n');
    expect(miss).toContain('No matching sessions found.');
    // A miss is NOT an unavailability: the store answered, and said no.
    expect(miss).not.toContain('history.enabled');
  });

  /**
   * GS2-88 §2 — `/reasoning` is the deliberate, STATED divergence.
   *
   * This surface streams through the string path, where `answerTextOf` keeps the answer and drops
   * the reasoning channel, so there is no per-turn thinking in this process at any point. The
   * command must say that. What it must NOT do is report a session state it has not got: the
   * sentence being removed claimed there were no committed turns, and this cell commits one and
   * proves it committed before asking.
   */
  describe('/reasoning after a committed turn', () => {
    it('does not claim the session has no committed turns — it names the surface', async () => {
      const notices = await runSession({ dbPath }, 'hello there', '/status', '/reasoning');
      const status = notices.find((n) => n.title.includes('Session status'));
      // The control: a turn really was committed before `/reasoning` ran. Without this the cell
      // could pass on a session that legitimately had none.
      expect(status?.lines.join('\n')).toContain('Turns so far: 1');

      const reasoning = notices[notices.length - 1];
      const lines = reasoning.lines.join('\n');
      expect(`${reasoning.title}\n${lines}`).not.toContain('no committed turns');
      expect(lines).toContain('keeps no per-turn thinking record');
      // It names the surface that DOES keep one, and no route onto this one: there are five ways
      // to land here (the flag, GTH_NO_TUI, `tui: false`, a non-TTY, CI), so copy naming two of
      // them is false for the other three — and the config route is the one this project's own
      // PTY fixture uses. A remedy has to be true of the session the user is actually in.
      expect(lines).toContain('The full-screen TUI does keep one');
      expect(lines).not.toContain('--no-tui');
    });

    it('says the same for `/reasoning <n>`, which is where the false sentence lived', async () => {
      const notices = await runSession({ dbPath }, 'hello there', '/reasoning 1');
      const lines = notices[notices.length - 1].lines.join('\n');
      expect(lines).not.toContain('no committed turns');
      expect(lines).toContain('keeps no per-turn thinking record');
    });
  });
});
