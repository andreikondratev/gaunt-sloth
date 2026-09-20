import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';

/**
 * GS2-115 — `/config` on the PLAIN READLINE (`--no-tui`) surface shows the load-time
 * config-validation warnings, not the resolved summary alone.
 *
 * **The central cell is a discriminating pair, and it has to be.** Before this node the readline
 * session opened no warning-capture window around `initConfig`, so `configWarnings` was never
 * populated and `/config` rendered the summary on its own — for a flagged config exactly as for a
 * clean one. An assertion on the clean case alone passed then and would go on passing through a
 * regression that unwired the capture again, so the two sides are asserted as a pair, with the
 * same config and the same command on both sides and only the emitted warning differing.
 *
 * **The capture mechanism is REAL here, and that is the point of the partial mock below.** Every
 * other readline spec replaces `consoleUtils` with a bare object literal, which would make
 * `displayWarning` a spy that buffers nothing and `beginWarningCapture` a no-op — the cell would
 * then prove the stub and not the window. Only the emitting helpers this spec reads or silences
 * are overridden; `displayWarning`, `beginWarningCapture` and `endWarningCapture` are the shipped
 * ones. What IS stubbed is `initConfig`, i.e. the emitter: that config validation really does warn
 * on an unknown top-level key is pinned in `packages/core/spec/configValidate.spec.ts`, and
 * re-proving it here would say nothing about the window.
 *
 * **Nothing in this spec reaches the developer's own `~/.gsloth` state.** `initConfig` is stubbed,
 * so no config file is discovered or read; the recorder and the session checkpointer are stubbed,
 * so nothing is written; and the only history path this session could reach is a `dbPath` in a
 * temp directory this spec creates and removes, which the last assertion of the pair proves was
 * never even opened.
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
  log: vi.fn(),
  warn: vi.fn(),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  stdout: { isTTY: true },
  initLogStream: vi.fn(),
  closeLogStream: vi.fn(),
  writeToLogStream: vi.fn(),
  stream: vi.fn(),
}));

// [[EXT-165]] — every command notice arrives here as one call carrying title, body AND tone.
const displayNoticeMock = vi.fn();
// A PARTIAL mock: the capture window and `displayWarning` stay real (see the block comment above),
// and only the helpers that would otherwise print, or that this spec reads, are replaced.
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayDialogLine: vi.fn(),
  displayInfo: vi.fn(),
  displayLaunchBanner: vi.fn(),
  displayNotice: displayNoticeMock,
  flushSessionLog: vi.fn(),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));

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

// The session records nothing and checkpoints nothing: this spec is about one command's body.
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

/** A real config-validation advisory: the wording `initConfig` emits for an unknown top-level key. */
const CONFIG_WARNING =
  'Unknown top-level config key in .gsloth.config.json: pullrequest. It is kept as-is but ' +
  'ignored by Gaunt Sloth; check for typos.';

describe('interactiveSessionModule — readline /config and the load-time warnings (GS2-115)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    inputs = [];
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-readline-configwarn-'));
    dbPath = resolve(dir, 'history.db');
    // The real `displayWarning` consults the console level before it buffers anything, so a
    // quieted level would empty the capture and make this whole file pass for the wrong reason.
    const { resetConsoleLevel } = await import('@gaunt-sloth/core/utils/consoleLevel.js');
    resetConsoleLevel();
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

  /**
   * Run a readline session whose config load emits `warnings`, type `/config`, and return the
   * one notice it produced.
   *
   * The warnings are emitted from inside the stubbed `initConfig` through the SAME module the
   * session opens its capture window on, which is the only way a spec can stand where
   * config validation stands.
   */
  const runConfigCommand = async (
    warnings: string[]
  ): Promise<{ title: string; lines: string[]; tone: string | undefined }> => {
    displayNoticeMock.mockClear();
    inputs = ['/config', 'exit'];
    const consoleUtils = await import('@gaunt-sloth/core/utils/consoleUtils.js');
    initConfigMock.mockImplementation(async () => {
      for (const warning of warnings) consoleUtils.displayWarning(warning);
      return {
        streamSessionInferenceLog: false,
        modelDisplayName: 'test-model',
        // History off, and pointed at a temp file even so: there is no path from this spec to a
        // real store, and the assertion at the end of the pair proves the temp one stayed unopened.
        history: { enabled: false, dbPath },
      };
    });
    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});
    // Exactly one notice, so the body below cannot be some other command's.
    expect(displayNoticeMock).toHaveBeenCalledTimes(1);
    const [title, lines, options] = displayNoticeMock.mock.calls[0];
    return {
      title: String(title),
      lines: lines as string[],
      tone: (options as { tone?: string } | undefined)?.tone,
    };
  };

  /**
   * **The discriminating pair.** Same session, same config, same command — only whether the config
   * load warned differs. On the unfixed code both sides rendered the identical summary-only body,
   * so this cell could not have passed; a cell that asserted only the clean side could, which is
   * why it is written as a pair.
   */
  it('renders the warning, and reads differently from the same command on a clean config', async () => {
    const warned = await runConfigCommand([CONFIG_WARNING]);
    const clean = await runConfigCommand([]);

    expect(warned.lines.join('\n')).not.toEqual(clean.lines.join('\n'));

    // Each side is pinned, because two different WRONG bodies would also differ.
    expect(warned.lines.join('\n')).toContain('pullrequest');
    expect(warned.lines.join('\n')).toContain('check for typos');
    expect(warned.lines.join('\n')).toContain('Config warning');
    expect(warned.tone).toBe('warn');
    expect(clean.lines.join('\n')).not.toContain('pullrequest');
    expect(clean.lines.join('\n')).not.toContain('Config warning');
    expect(clean.tone).toBe('info');

    // The control that both sides really ran `/config` against a resolved config: a clean side
    // that had silently rendered nothing at all would satisfy every `not.toContain` above.
    expect(warned.title).toBe('Resolved configuration');
    expect(clean.title).toBe('Resolved configuration');
    expect(warned.lines.join('\n')).toContain('test-model');
    expect(clean.lines.join('\n')).toContain('test-model');

    // …and neither side went near a history store: the only path this session had was the temp
    // one, and it was never created.
    expect(existsSync(dbPath)).toBe(false);
  });

  it('carries every warning the config load emitted, not just the first', async () => {
    const second = 'Deprecated config key: llm. Rename it to `llmProvider`.';
    const warned = await runConfigCommand([CONFIG_WARNING, second]);
    const body = warned.lines.join('\n');
    expect(body).toContain('pullrequest');
    expect(body).toContain('Deprecated config key: llm');
    expect(body).toContain('Config warnings (2)');
  });

  /**
   * The capture window is module-level state in `consoleUtils`, so it is closed in a `finally`.
   * A window left open by a config that threw would go on collecting every warning the process
   * emits afterwards into a buffer nobody drains — invisible until it is someone's memory
   * problem. This cell fails if the `finally` is dropped.
   */
  it('closes the capture window even when the config load throws', async () => {
    inputs = ['exit'];
    initConfigMock.mockRejectedValue(new Error('config is broken'));
    const consoleUtils = await import('@gaunt-sloth/core/utils/consoleUtils.js');
    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');

    await expect(createInteractiveSession(sessionConfig, {})).rejects.toThrow('config is broken');

    // Nothing may be collecting any more: a warning emitted now belongs to the terminal, and
    // `endWarningCapture` on a closed window answers with nothing.
    consoleUtils.displayWarning('emitted after the failed start');
    expect(consoleUtils.endWarningCapture()).toEqual([]);
  });
});
