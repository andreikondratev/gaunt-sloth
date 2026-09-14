import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { StatusLevel } from '#src/core/types.js';

/**
 * [[TUI-C108]] — the plain surface's tool status row is levelled BY OUTCOME, so a quieted console
 * keeps the failures after the successes have dropped away.
 *
 * [[TUI-C109]] — and the rung a success drops at is `warning`, not `display`. At `display` the row
 * is the ONE line a tool call is worth, and the two INFO lines that announce the same call before
 * it happens — `Requested tools:` and `Thinking...` — are what fall silent instead. The cells in
 * the `consoleLevel display` block below assert both halves of that, the second of which no code
 * in this repo implements: it is a property of those two call sites staying at INFO.
 *
 * These cells drive the REAL production path — `createPlainToolIndication()` with its default
 * `emit`, which is the real `displayToolIndication` — rather than an injected sink, because the
 * thing under test is the level the row is written at and an injected sink never reaches the gate.
 * `systemUtils` is the only mock, so what is asserted is the exact bytes that would reach the
 * user's terminal.
 */
const systemUtilsMock = {
  getUseColour: vi.fn(),
  initLogStream: vi.fn(),
  writeToLogStream: vi.fn(),
  closeLogStream: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  stream: vi.fn(),
  // TUI-C109 — the announcement-line cells drive a real `GthAbstractAgent` stream, which reaches
  // for the escape watcher and stdout on its way through.
  waitForEscape: vi.fn(),
  stopWaitingForEscape: vi.fn(),
  getCurrentWorkDir: vi.fn(() => '/test/dir'),
  stdout: { isTTY: false, write: vi.fn() },
  env: {} as Record<string, string | undefined>,
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const debugUtilsMock = {
  debugLog: vi.fn(),
  debugLogError: vi.fn(),
  // TUI-C109 — reached by the real `GthAbstractAgent` stream the announcement-line cells drive.
  debugLogObject: vi.fn(),
  debugLogMultiline: vi.fn(),
  getDebugLogBuffer: vi.fn(() => []),
  initDebugLogging: vi.fn(),
};
vi.mock('#src/utils/debugUtils.js', () => debugUtilsMock);

/** A non-shell tool whose body is NOT suppressed by the live-output dedupe. */
const TOOL = 'read_file';
const ERROR_TEXT = [
  'ENOENT: no such file or directory',
  "  at readFile ('/repo/missing.ts')",
  '  code: ENOENT',
  '  errno: -2',
].join('\n');

/** One streamed round for `read_file`, closed by a ToolMessage with the given outcome. */
function round(result: string, status?: 'error'): Array<AIMessageChunk | ToolMessage> {
  return [
    new AIMessageChunk({
      content: '',
      tool_call_chunks: [
        {
          name: TOOL,
          args: '{"path":"README.md"}',
          id: 'call-1',
          index: 0,
          type: 'tool_call_chunk',
        },
      ],
    }),
    new ToolMessage({
      content: result,
      tool_call_id: 'call-1',
      ...(status ? { status } : {}),
    }),
  ];
}

/** Load the production modules fresh and drive one round through the real emit path. */
async function emitRound(
  opts: {
    result?: string;
    status?: 'error';
    raterClarification?: boolean;
    consoleLevel?: StatusLevel;
    displayConfig?: unknown;
  } = {}
): Promise<void> {
  const consoleUtils = await import('#src/utils/consoleUtils.js');
  const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
  const toolDisplay = await import('#src/core/toolDisplay.js');

  toolDisplay.resetToolDisplaySecretsCacheForTests();
  if (opts.displayConfig !== undefined) toolDisplay.setToolDisplayConfig(opts.displayConfig);
  consoleUtils.initSessionLogging('session.log', true);
  consoleUtils.setConsoleLevel(opts.consoleLevel ?? StatusLevel.INFO);

  const observer = createPlainToolIndication(undefined, () => opts.raterClarification === true);
  for (const chunk of round(opts.result ?? 'line-1\nline-2', opts.status)) observer.observe(chunk);
}

/**
 * Drive one tool round through a REAL `GthAbstractAgent` stream at the given console level, with
 * the REAL `defaultStatusCallback` as the agent's status sink and the graph injected directly.
 *
 * [[TUI-C109]] — going through the agent rather than calling the status callback with a literal is
 * the whole point: what is under test is the LEVEL `Thinking...` is emitted at, and a cell that
 * passed `StatusLevel.INFO` itself would go on passing the day somebody raises that call site to
 * DISPLAY — which is exactly the change these cells exist to catch.
 */
async function streamOneToolRound(consoleLevel: StatusLevel): Promise<void> {
  const consoleUtils = await import('#src/utils/consoleUtils.js');
  const { GthAbstractAgent } = await import('#src/core/GthAbstractAgent.js');

  consoleUtils.initSessionLogging('session.log', true);
  consoleUtils.setConsoleLevel(consoleLevel);

  class TestAgent extends GthAbstractAgent {
    async init(): Promise<void> {
      /* the graph is injected below */
    }
  }
  const agent = new TestAgent(consoleUtils.defaultStatusCallback);

  (agent as any).config = { writeBinaryOutputsToFile: false };
  (agent as any).agent = {
    async invoke() {
      throw new Error('not used');
    },
    async stream() {
      // streamMode:'messages' shape — [message, metadata] pairs.
      async function* messages() {
        for (const message of round('line-1\nline-2')) yield [message, {}];
        yield [new AIMessageChunk({ content: 'The file says…' }), {}];
      }
      return messages();
    },
  };

  const runConfig: RunnableConfig = { configurable: { thread_id: 't1' } };
  const stream = await agent.stream([new HumanMessage('read it')], runConfig);
  for await (const _chunk of stream) {
    /* drained: the status lines and the row are emitted as a side effect */
  }
}

/** Everything written to the console channel `displayToolIndication` uses. */
const blocks = (): string[] => systemUtilsMock.info.mock.calls.map((c) => c[0] as string);

/** Every string written to ANY console channel, whatever its level or stream. */
const everythingWritten = (): string[] =>
  [
    ...systemUtilsMock.info.mock.calls,
    ...systemUtilsMock.log.mock.calls,
    ...systemUtilsMock.warn.mock.calls,
    ...systemUtilsMock.error.mock.calls,
    ...systemUtilsMock.debug.mock.calls,
    ...systemUtilsMock.stream.mock.calls,
  ].map((call) => String(call[0]));

/** Did any console channel receive a string containing this? */
const printedSomethingContaining = (needle: string): boolean =>
  everythingWritten().some((text) => text.includes(needle));

/**
 * The exact blocks the base commit emits at the default level, captured from a run against the
 * unmodified tree rather than written from belief. Whole strings, because the acceptance is
 * byte-identity and a `toContain` would pass on a block that had gained or lost a line.
 */
const BASE_SUCCESS = '\n✓ 📁 read_file(path=README.md)\n    line-1\n    line-2';
const BASE_ERROR =
  '\n✗ 📁 read_file(path=README.md)\n' +
  '    ENOENT: no such file or directory\n' +
  "      at readFile ('/repo/missing.ts')\n" +
  '      code: ENOENT\n' +
  '      errno: -2';
const BASE_CLARIFICATION =
  '\n⚠ 📁 read_file(path=README.md)  [auto-rater: clarification requested]\n' +
  '    ENOENT: no such file or directory\n' +
  "      at readFile ('/repo/missing.ts')\n" +
  '      code: ENOENT\n' +
  '      errno: -2';

/**
 * [[TUI-C109]] — the same successful call at `consoleLevel: "display"` with the preview depth set
 * to 0: the status row and nothing under it. Captured from a run, like the constants above, and
 * pinned whole because "one line per tool call" is a claim about the WHOLE block, not about a
 * substring of it.
 */
const DISPLAY_SUCCESS = '\n✓ 📁 read_file(path=README.md)';

describe('TUI-C108 — the tool status row is levelled by outcome', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    systemUtilsMock.getUseColour.mockReturnValue(false);
    systemUtilsMock.env = {};
  });

  /**
   * The load-bearing regression pin: at the DEFAULT console level nothing about this change may
   * reach a user who did not ask for it. Asserted as whole-string equality on the exact bytes,
   * and on the CHANNEL, so a future move of the error row to stderr reds here rather than in
   * somebody's terminal.
   */
  describe('byte-identical at the default INFO level', () => {
    it('success renders exactly as before, on the info channel', async () => {
      await emitRound();
      expect(blocks()).toEqual([BASE_SUCCESS]);
      expect(systemUtilsMock.log).not.toHaveBeenCalled();
      expect(systemUtilsMock.warn).not.toHaveBeenCalled();
      expect(systemUtilsMock.error).not.toHaveBeenCalled();
    });

    it('an error renders exactly as before, on the info channel', async () => {
      await emitRound({ result: ERROR_TEXT, status: 'error' });
      expect(blocks()).toEqual([BASE_ERROR]);
      expect(systemUtilsMock.log).not.toHaveBeenCalled();
      expect(systemUtilsMock.warn).not.toHaveBeenCalled();
      expect(systemUtilsMock.error).not.toHaveBeenCalled();
    });

    it('a rater clarification renders exactly as before, on the info channel', async () => {
      await emitRound({ result: ERROR_TEXT, status: 'error', raterClarification: true });
      expect(blocks()).toEqual([BASE_CLARIFICATION]);
      expect(systemUtilsMock.log).not.toHaveBeenCalled();
      expect(systemUtilsMock.warn).not.toHaveBeenCalled();
    });

    it('writes the same block to the session log, ANSI-stripped', async () => {
      await emitRound();
      expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledWith(BASE_SUCCESS + '\n');
    });
  });

  describe('at consoleLevel display, with the preview depth set to 0', () => {
    const quiet = {
      consoleLevel: StatusLevel.DISPLAY,
      displayConfig: { toolOutputPreviewLines: 0 },
    };

    /**
     * [[TUI-C109]] — **this cell is the deliberate inverse of what [[TUI-C108]] shipped, and it is
     * a DECISION rather than a defect found in it.** TUI-C108 had a successful call print nothing
     * here, on the reporter's own instruction. He then named the assumption underneath that
     * instruction: he expected `Requested tools:` to be the line carrying the call's parameters,
     * which made silencing this row look free. [[TUI-C106]] had already moved the parameters onto
     * this row, so this is the line worth keeping and `Requested tools:` the redundant one. Same
     * requirement — one line per tool call in a quieted run — landing on the other line.
     */
    it('TUI-C109: a successful call prints its status row, arguments and all, and logs it', async () => {
      await emitRound(quiet);

      // The row WHOLE, not a `toContain` on the tool name: the arguments are what make this the
      // line worth keeping, so an assertion that tolerated the nameless `read_file()` row this
      // arc was opened to fix would be pinning the wrong thing.
      expect(blocks()).toEqual([DISPLAY_SUCCESS]);
      // ...and on the info channel, as at every other rung. TUI-C108 moved the LEVEL and left the
      // CHANNEL deliberately alone, so a row rerouted to stdout or stderr reds here.
      expect(systemUtilsMock.log).not.toHaveBeenCalled();
      expect(systemUtilsMock.warn).not.toHaveBeenCalled();
      expect(systemUtilsMock.error).not.toHaveBeenCalled();
      // `displayToolIndication` writes the session log AFTER the level gate, so the transcript
      // flips with the row rather than keeping a line the screen no longer shows.
      expect(systemUtilsMock.writeToLogStream).toHaveBeenCalledWith(DISPLAY_SUCCESS + '\n');
    });

    it('a failed call prints its status row AND enough of the error to explain itself', async () => {
      await emitRound({ ...quiet, result: ERROR_TEXT, status: 'error' });

      expect(systemUtilsMock.info).toHaveBeenCalledTimes(1);
      const block = blocks()[0];
      const [, head, ...body] = block.split('\n');

      expect(head).toContain('✗');
      expect(head).toContain('read_file(path=README.md)');
      // The floor, asserted on the ERROR TEXT rather than a line count alone: a count-only
      // assertion passes on the useless version of this, where three lines survive and none of
      // them says what went wrong.
      expect(block).toContain('ENOENT: no such file or directory');
      expect(body.length).toBeGreaterThanOrEqual(3);
    });

    it('a rater clarification still renders distinguishably', async () => {
      await emitRound({ ...quiet, result: ERROR_TEXT, status: 'error', raterClarification: true });

      expect(systemUtilsMock.info).toHaveBeenCalledTimes(1);
      const block = blocks()[0];
      // The glyph and the WORDS, not the colour: TUI-C69 §5.4 requires the distinction to survive
      // a terminal with no colour at all, and this cell runs with colour off.
      expect(block).toContain('⚠');
      expect(block).toContain('auto-rater: clarification requested');
      expect(block).not.toContain('✗');
    });

    /**
     * [[TUI-C109]] — **the half of the reporter's ask that no code in this repo implements.**
     * Keeping the row is one map entry; dropping the two lines that announce the same call before
     * it happens is a property of THOSE CALL SITES staying at INFO, so nothing would notice either
     * of them being raised to DISPLAY and quietly undoing half of what was asked for. These cells
     * are that notice.
     *
     * `Thinking...` is asserted here, end to end through a real agent stream and the real console
     * gate. `Requested tools:` lives on a middleware that only exists after
     * `GthLangChainAgent.init()`, so its level is pinned where that harness already is — see the
     * `GthMiddlewareToolCallStatusUpdate` cell in `GthLangChainAgent.spec.ts`. Between them: that
     * line is INFO, and INFO is silent at `display`.
     */
    describe('TUI-C109 — the announcement lines around the row stay hidden', () => {
      it('`Thinking...` does not render at display, while the tool row does', async () => {
        await streamOneToolRound(StatusLevel.DISPLAY);

        expect(printedSomethingContaining('Thinking...')).toBe(false);
        // The CONTROL, and the reason the assertion above is not vacuous: this run DID reach the
        // console at this level. A status sink that was never wired, or a stream that never ran,
        // would satisfy the negative for the wrong reason and reds here instead.
        expect(printedSomethingContaining('✓ 📁 read_file(path=README.md)')).toBe(true);
      });

      it('`Thinking...` does render at the default info level', async () => {
        await streamOneToolRound(StatusLevel.INFO);

        expect(printedSomethingContaining('Thinking...')).toBe(true);
      });
    });
  });

  /**
   * [[TUI-C109]] — **the success rung pinned from ABOVE, which is the half the cells up to here
   * leave open.** They establish that the row shows at `info` and at `display`; every one of them
   * goes on passing if the rung is raised further, because a louder row still survives a quieter
   * console. So a success at WARNING — printing a SUCCESSFUL call to somebody who set
   * `consoleLevel: "error"` and asked for failures only — satisfies the whole block above while
   * collapsing the success/failure distinction [[TUI-C108]] exists to draw. This is the ceiling.
   *
   * It is also what holds the claim in `docs/configuration/output.md` §Console Logging Level that
   * from `warning` onwards a tool call shows up only when something was wrong with it.
   */
  describe('at consoleLevel warning, the rung that keeps failures only', () => {
    const failuresOnly = {
      consoleLevel: StatusLevel.WARNING,
      displayConfig: { toolOutputPreviewLines: 0 },
    };

    it('a successful call prints nothing, while a failed one still prints its row', async () => {
      await emitRound(failuresOnly);

      expect(systemUtilsMock.info).not.toHaveBeenCalled();
      expect(systemUtilsMock.log).not.toHaveBeenCalled();
      expect(systemUtilsMock.warn).not.toHaveBeenCalled();
      expect(systemUtilsMock.error).not.toHaveBeenCalled();
      expect(systemUtilsMock.writeToLogStream).not.toHaveBeenCalled();

      // The CONTROL, and deliberately in the SAME cell rather than a sibling `it`: the silence
      // above is equally satisfied by a harness that was never wired to anything, and a control
      // that can be deleted on its own stops guarding the assertion it was written for. The
      // identical harness at the identical level DOES print a failure.
      vi.clearAllMocks();
      systemUtilsMock.getUseColour.mockReturnValue(false);
      await emitRound({ ...failuresOnly, result: ERROR_TEXT, status: 'error' });

      expect(systemUtilsMock.info).toHaveBeenCalledTimes(1);
      const block = blocks()[0];
      const [, head, ...body] = block.split('\n');
      expect(head).toContain('✗');
      expect(head).toContain('read_file(path=README.md)');
      // The error floor survives the depth-0 setting here as it does at `display`, so a failure
      // still explains itself at the rung that keeps nothing else.
      expect(block).toContain('ENOENT: no such file or directory');
      expect(body.length).toBeGreaterThanOrEqual(3);
    });
  });
});
