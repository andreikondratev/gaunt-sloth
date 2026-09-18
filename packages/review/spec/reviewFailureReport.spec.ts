import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * REL-20 — the unit-level half of "a failed review still explains itself in its report". The two
 * entry points are proved end to end in `app/spec/reviewFailureReport.e2e.spec.ts`; what is left
 * here is the in-agent failure, and the report text's own handling.
 *
 * The first is a run whose content was fetched fine and which then died inside the agent, a context
 * overflow being the case that prompted the question.
 *
 * It needs no code of its own, and that is exactly why it is pinned here. `review()` opens the
 * report before the agent runs, its runner catch reports through `displayError`, and the report is
 * a capture of that console channel — so the explanation lands in the file by construction. Nothing
 * in the module says so, and the ordering that makes it true (open the file, run the agent, catch,
 * close the file) is three separate statements any refactor could reorder without a single other
 * test noticing.
 *
 * So this asserts the FILE, not the console call. `expect(displayError).toHaveBeenCalled()` would
 * stay green through a reordering that moved the catch after `stopSessionLogging()`, which is
 * precisely the regression that would put us back where issue #447 started.
 *
 * Only the agent runner is mocked; the console, the session log and the file are all real, because
 * they are the mechanism under test.
 */
const runnerInstance = {
  init: vi.fn(),
  processMessages: vi.fn(),
  cleanup: vi.fn(),
  getTerminationReason: vi.fn(),
  getOutstandingWork: vi.fn(),
};
const GthAgentRunnerMock = vi.fn(function GthAgentRunnerMock() {
  return runnerInstance;
});
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: GthAgentRunnerMock,
}));

/**
 * A provider's own words for a prompt that did not fit, wrapped as the runner surfaces it. The
 * exact sentence is illustrative — what is pinned is that whatever the run failed with reaches the
 * report intact, since a message naming the limit is the only thing that tells a reader whether to
 * split the PR or raise a budget.
 */
const OVERFLOW_REASON =
  'Agent processing failed: 400 prompt is too long: 274216 tokens > 200000 maximum';

describe('a review that dies inside the agent still says so in its report', () => {
  let dir: string;
  let reportPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-rel20-overflow-'));
    reportPath = resolve(dir, 'review.md');

    GthAgentRunnerMock.mockImplementation(function GthAgentRunnerMock() {
      return runnerInstance;
    });
    runnerInstance.init.mockResolvedValue(undefined);
    runnerInstance.cleanup.mockResolvedValue(undefined);
    runnerInstance.getTerminationReason.mockReturnValue(undefined);
    runnerInstance.getOutstandingWork.mockReturnValue(undefined);
    runnerInstance.processMessages.mockRejectedValue(new Error(OVERFLOW_REASON));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the heading and the reason the agent failed into the report file', async () => {
    const config = {
      contentSource: 'file',
      requirementSource: 'file',
      streamOutput: true,
      commands: { pr: { contentSource: 'file' } },
      filesystem: 'none',
      useColour: false,
      writeOutputToFile: reportPath,
      streamSessionInferenceLog: true,
      canInterruptInferenceWithEsc: true,
      includeCurrentDateAfterGuidelines: false,
      llm: {} as BaseChatModel,
    } as unknown as GthConfig;

    const { review } = await import('#src/modules/reviewModule.js');
    await review('PR-427', 'test-preamble', 'a diff that did not fit', config, 'pr');

    // The log stream is closed asynchronously, so wait for the bytes rather than racing them.
    await vi.waitFor(() => {
      expect(existsSync(reportPath)).toBe(true);
      expect(readFileSync(reportPath, 'utf8')).toContain(OVERFLOW_REASON);
    });

    const report = readFileSync(reportPath, 'utf8');
    expect(report.split('\n')[0]).toBe('Gaunt Sloth · pr');
    expect(report).toContain('Failed to run review with agent.');

    // This run DID reach the agent, so it must not carry the pre-inference notice. The two failure
    // shapes are written by different code down different paths, and a report claiming the review
    // never ran when it ran and failed is a worse answer than either.
    const { REVIEW_DID_NOT_RUN } = await import('#src/modules/reviewFailureReport.js');
    expect(report).not.toContain(REVIEW_DID_NOT_RUN);
  });
});

describe('the pre-inference report carries no terminal escapes', () => {
  let dir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-rel20-ansi-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The report is read as a document, and a successful one never contains an escape sequence,
   * because every line reaches it through the session log's strip. The failure report writes the
   * file directly, so it has to do the same — and the text is not ours to trust: a content-source
   * error carries the child process's stderr, and a `gh` that thinks it has a terminal colours it.
   */
  it('strips colour codes out of the error the source produced', async () => {
    const reportPath = resolve(dir, 'review.md');
    const config = {
      writeOutputToFile: reportPath,
      streamSessionInferenceLog: true,
    } as unknown as GthConfig;

    const { writeReviewFailureReport } = await import('#src/modules/reviewFailureReport.js');
    const written = writeReviewFailureReport(
      config,
      'PR-427',
      'pr',
      new Error('[31mFailed to get GitHub PR diff #427[0m: HTTP 406')
    );

    expect(written).toBe(reportPath);
    const report = readFileSync(reportPath, 'utf8');
    expect(report).toContain('Failed to get GitHub PR diff #427: HTTP 406');
    expect(report).not.toMatch(/\[/);
  });
});
