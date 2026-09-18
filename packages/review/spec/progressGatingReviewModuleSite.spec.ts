import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { StatusLevel } from '@gaunt-sloth/core/core/types.js';
import { resetConsoleLevel, setConsoleLevel } from '@gaunt-sloth/core/utils/consoleLevel.js';

/**
 * [[TUI-C110]] — the sixth review construction site: `Reviewing.`, the line `reviewModule.review()`
 * draws around the whole non-streaming review turn.
 *
 * It gets its own file rather than joining the five source sites because it needs a different
 * world (an agent runner, the rating middleware, the artifact store), and it is the site issue #445
 * is actually about: a non-interactive `gth review` at `consoleLevel: "display"` sat under this
 * line and its dots for the entire length of the model call.
 *
 * Its mock set is deliberately the one the EXT-53 sibling (`reviewModuleProgress.spec.ts`) uses —
 * the REAL `ProgressIndicator`, with `stdout` kept so it is not mocked away — so the two specs are
 * asserting on the same seam.
 */
const gthAgentRunnerInstanceMock = vi.hoisted(() => ({
  init: vi.fn(),
  processMessages: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return gthAgentRunnerInstanceMock;
  }),
}));

const createReviewRateMiddlewareMock = vi.hoisted(() => vi.fn());
vi.mock('#src/middleware/reviewRateMiddleware.js', () => ({
  createReviewRateMiddleware: createReviewRateMiddlewareMock,
  REVIEW_RATE_ARTIFACT_KEY: 'review-rate',
}));

vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayDebug: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displaySuccess: vi.fn(),
  displayWarning: vi.fn(),
  flushSessionLog: vi.fn(),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));

vi.mock('#src/utils/fileUtils.js', () => ({
  getCommandOutputFilePath: vi.fn(() => null),
}));

vi.mock('@gaunt-sloth/core/state/artifactStore.js', () => ({
  deleteArtifact: vi.fn(),
  getArtifact: vi.fn(() => undefined),
}));

// The real ProgressIndicator writes through this wrapper; keep `stdout` so it is not mocked away.
const stdoutWriteMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  setExitCode: vi.fn(),
  stdout: { write: stdoutWriteMock },
}));

/** Everything written to the terminal by the review turn, in order, as one string. */
const written = (): string => stdoutWriteMock.mock.calls.map((call) => call[0]).join('');

// streamOutput:false is what makes the indicator exist at all.
const baseConfig = {
  streamOutput: false,
  writeOutputToFile: false,
} as Partial<GthConfig> as GthConfig;

describe('progress-line gating, per construction site: reviewModule (Reviewing.)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('a review');
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);
    createReviewRateMiddlewareMock.mockResolvedValue({ name: 'review-rate' });
  });

  afterEach(() => {
    resetConsoleLevel();
  });

  it('draws the line, and nothing more, at the default info level', async () => {
    const { review } = await import('#src/modules/reviewModule.js');
    await review('src', 'preamble', 'diff', baseConfig);

    expect(written()).toBe('Reviewing.\n');
  });

  /** The reported configuration: issue #445 runs a non-interactive review at exactly this rung. */
  it('draws nothing at all at consoleLevel display — no label, no dots, no blank line', async () => {
    setConsoleLevel(StatusLevel.DISPLAY);

    const { review } = await import('#src/modules/reviewModule.js');
    await review('src', 'preamble', 'diff', baseConfig);

    expect(written()).toBe('');
  });

  /**
   * The quiet line has to stay quiet on the error path too: `review()` stops the indicator from a
   * `finally`, which is the one call that could still emit a newline for a line nobody started.
   */
  it('draws nothing when the review turn throws while quietened', async () => {
    setConsoleLevel(StatusLevel.ERROR);
    gthAgentRunnerInstanceMock.cleanup.mockRejectedValue(new Error('MCP teardown exploded'));

    const { review } = await import('#src/modules/reviewModule.js');
    await expect(review('src', 'preamble', 'diff', baseConfig)).rejects.toThrow(
      'MCP teardown exploded'
    );

    expect(written()).toBe('');
  });
});
