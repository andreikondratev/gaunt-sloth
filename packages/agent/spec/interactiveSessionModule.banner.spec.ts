import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';

// TUI-C33 — the launch banner on the PLAIN (--no-tui readline) surface. What is pinned here is the
// wiring, not the geometry (that lives in packages/core/spec/launchBanner.spec.ts): the banner is
// emitted once at launch, ABOVE the untouched ready message, only when stdout is a TTY, only when
// the session has no initial message to run, through the non-session-logging emitter, and carrying
// the live model/provider from the resolved config.

/** Index of the first art row: row 0 is TUI-C36's blank padding row. */
const ART = 1;

// readline / stdin — the main '  > ' prompt returns 'exit' so the session sets up and ends.
const rlQuestionMock = vi.fn(async (prompt: string) => {
  if (typeof prompt === 'string' && prompt.includes('>')) return 'exit';
  return '';
});
// Mutable so a test can turn the terminal into a pipe. `columns` is deliberately generous: the
// geometry is asserted elsewhere, here it just has to leave room for the fields.
const stdoutMock: { isTTY: boolean; columns?: number } = { isTTY: true, columns: 120 };
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
  // TUI-C74 — the banner's location fields: where the session IS, and the config root discovered
  // ABOVE it. They are deliberately different here, because equal values make the banner's
  // rendering the same whichever one it reports.
  getCurrentWorkDir: vi.fn(() => '/home/mari/dev/takahe/packages/core'),
  getProjectDir: vi.fn(() => '/home/mari/dev/takahe'),
  peekProjectDir: vi.fn(() => '/home/mari/dev/takahe'),
  getUseColour: vi.fn(() => false),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  stdout: stdoutMock,
}));

// The two emitters that matter: the banner has its own (which does NOT write to the session log),
// and `display` is what prints the ready message it must sit above.
const displayMock = vi.fn();
const displayLaunchBannerMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  display: displayMock,
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayLaunchBanner: displayLaunchBannerMock,
  displayWarning: vi.fn(),
  beginWarningCapture: vi.fn(),
  endWarningCapture: vi.fn(() => []),
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));

const initConfigMock = vi.fn();
// Partial mock (spread the real module): the shared slash-command registry reads the real
// approvals vocabulary (APPROVAL_RUNGS) while building the `/approvals` entry, so a bare
// stub of this barrel leaves that constant undefined and the session fails to start.
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));

vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null),
}));

const runnerInstanceMock = {
  init: vi.fn().mockResolvedValue(undefined),
  processMessages: vi.fn().mockResolvedValue(undefined),
  setApprovalOutcomeCallback: vi.fn(),
  setToolApprovalCallback: vi.fn(),
  setAttackHaltCallback: vi.fn(),
  setNegotiationDisplay: vi.fn(),
  cleanup: vi.fn().mockResolvedValue(undefined),
};
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
vi.mock('#src/resolvers.js', () => ({ createResolvers: vi.fn() }));
vi.mock('#src/core/resolveAgentFactory.js', () => ({ resolveAgentFactory: vi.fn() }));

const sessionConfig = {
  mode: 'chat',
  readModePrompt: () => null,
  description: 'chat',
  readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
  exitMessage: "Type 'exit' or Ctrl+C to exit chat · /help for commands\n",
} as unknown as SessionConfig;

// GS2-88 — the READ side of the history file, which the recorder/checkpointer stubs do not cover.
// Every interactive session builds its `/history` `/insights` `/search` props at start from
// `openHistoryStore(resolveHistoryDbPath(config.history?.dbPath))`, and a config naming no
// `dbPath` — which is what the cells here pass — resolves the developer's real
// `~/.gsloth/history.db`. Opening it is not read-only: the store migrates on every open, so a real
// store predating a schema addition is rewritten by a spec that only meant to look at it. `null` is
// the module's own fail-soft path, and no cell in this file asserts on history content.
vi.mock('@gaunt-sloth/core/history/historyStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/history/historyStore.js')>()),
  resolveHistoryDbPath: () => '/gsloth-spec-never-a-real-store/history.db',
  openHistoryStore: () => null,
}));

describe('interactiveSessionModule launch banner (TUI-C33)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stdoutMock.isTTY = true;
    stdoutMock.columns = 120;
    rlQuestionMock.mockImplementation(async (prompt: string) => {
      if (typeof prompt === 'string' && prompt.includes('>')) return 'exit';
      return '';
    });
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue(undefined);
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
    initConfigMock.mockResolvedValue({
      streamSessionInferenceLog: false,
      modelDisplayName: 'gemini-3.1-pro',
      modelProviderType: 'google-genai',
    });
  });

  it('prints the banner with the live fields, above the untouched ready message', async () => {
    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});

    expect(displayLaunchBannerMock).toHaveBeenCalledTimes(1);
    const banner = displayLaunchBannerMock.mock.calls[0][0] as string;
    const lines = banner.split('\n');
    // Eight lines: TUI-C36's blank padding row, the five art rows, TUI-C74's config-root row, and
    // the closing padding row.
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe('');
    expect(lines[7]).toBe('');
    expect(lines[ART]).toContain('┏┓         ┏┓┓   ┓'); // the wordmark
    expect(lines[ART + 3]).toContain('gemini-3.1-pro (google-genai)'); // config-driven, not hardcoded
    // TUI-C74 — the working directory the tools resolve against, and the config root above it,
    // each under its own label. Reported as-is here because the real homedir() is not their
    // prefix; the home-to-`~` collapse itself is pinned in packages/core/spec/launchBanner.spec.ts.
    // The expectations go through `resolve` because the banner's fields do: a POSIX literal here
    // would pass on this machine and fail the Windows cell.
    expect(lines[ART + 4]).toContain(`cwd: ${resolve('/home/mari/dev/takahe/packages/core')}`);
    expect(lines[ART + 5]).toContain(`config: ${resolve('/home/mari/dev/takahe')}`);

    // The ready message is untouched, and the banner was emitted BEFORE it.
    expect(displayMock).toHaveBeenCalledWith('\nGaunt Sloth is ready to chat. Type your prompt.');
    expect(displayLaunchBannerMock.mock.invocationCallOrder[0]).toBeLessThan(
      displayMock.mock.invocationCallOrder[0]
    );
  });

  it('emits no escape sequences (colour off degrades to plain text)', async () => {
    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});

    expect(displayLaunchBannerMock.mock.calls[0][0]).not.toContain('\x1b');
  });

  it('prints no banner when stdout is not a TTY (piped / redirected runs stay clean)', async () => {
    stdoutMock.isTTY = false;

    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});

    expect(displayLaunchBannerMock).not.toHaveBeenCalled();
    // …and the ready message still prints, so the gate only removes the banner.
    expect(displayMock).toHaveBeenCalledWith('\nGaunt Sloth is ready to chat. Type your prompt.');
  });

  it('prints no banner when the session starts with a message to run', async () => {
    // The readline twin of the TUI hiding its intro when it mounts with an initialMessage.
    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {}, 'do the thing');

    expect(displayLaunchBannerMock).not.toHaveBeenCalled();
  });

  it('omits the model line when the config resolves neither model nor provider', async () => {
    initConfigMock.mockResolvedValue({ streamSessionInferenceLog: false });

    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});

    const lines = (displayLaunchBannerMock.mock.calls[0][0] as string).split('\n');
    // The fourth art row is the bare face — never an empty pair of parentheses.
    expect(lines[ART + 3].trimEnd()).toBe(' ▀▄▀▀ ██████ ▀▀▄▀');
    expect(lines[ART + 3]).not.toContain('(');
  });
});
