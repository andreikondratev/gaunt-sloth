import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusLevel } from '@gaunt-sloth/core/core/types.js';
import { resetConsoleLevel, setConsoleLevel } from '@gaunt-sloth/core/utils/consoleLevel.js';

/**
 * [[TUI-C110]] — the console-level gate on the progress line, asserted **per construction site**.
 *
 * Five of the ten sites live here: the four review content sources and the Jira client. They are
 * asserted one by one rather than once, because they are five different call paths and a cell
 * driving one of them proves nothing about the other four — the failure this guards against is a
 * site that builds its progress line some other way, and that failure is invisible to a cell that
 * never runs it.
 *
 * **Both directions, every site.** The quiet half alone is an assertion that cannot fail: a driver
 * that never reaches the construction site writes nothing either. So each site is also driven at
 * the default `info` rung and pinned to its EXACT byte stream, which is what distinguishes
 * "gated" from "never constructed" — and doubles as the byte-identity evidence for these sites.
 *
 * `ProgressIndicator` is the REAL one here (the sibling source specs mock it away). `consoleUtils`
 * is mocked, and that is exactly why the level lives in `utils/consoleLevel.js`: the gate under
 * test is the production one even in a spec that replaces the console surface wholesale.
 */
const execAsyncMock = vi.fn();
const execFileMock = vi.fn();
const stdoutWriteMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  execAsync: execAsyncMock,
  stdout: { write: stdoutWriteMock },
  env: {},
}));

vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  displayWarning: vi.fn(),
}));

vi.mock('@gaunt-sloth/core/utils/debugUtils.js', () => ({
  debugLog: vi.fn(),
}));

/** Everything written to the terminal by the site under test, in order, as one string. */
const written = (): string => stdoutWriteMock.mock.calls.map((call) => call[0]).join('');

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

/**
 * One site: how to run it, and the exact line it draws when nothing is quietened.
 *
 * `run` must exercise the real code path that constructs the indicator — not a stand-in for it —
 * because the `info` expectation below is what proves the path was reached.
 */
interface Site {
  readonly name: string;
  readonly line: string;
  readonly run: () => Promise<unknown>;
}

const sites: Site[] = [
  {
    name: 'gitDiffSource — Getting local git diff',
    line: 'Getting local git diff for "origin/main...HEAD"\n',
    run: async () => {
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: ExecFileCallback) => {
          cb(null, 'diff body', '');
        }
      );
      const { get } = await import('#src/sources/gitDiffSource.js');
      return get(null, 'origin/main...HEAD');
    },
  },
  {
    name: 'ghIssueSource — Fetching GitHub issue',
    line: 'Fetching GitHub issue #133\n',
    run: async () => {
      execAsyncMock.mockResolvedValue('issue body');
      const { get } = await import('#src/sources/ghIssueSource.js');
      return get(null, '133');
    },
  },
  {
    name: 'ghPrDiffSource — Fetching GitHub PR diff',
    line: 'Fetching GitHub PR #445 diff\n',
    run: async () => {
      execAsyncMock.mockResolvedValue('pr diff body');
      const { get } = await import('#src/sources/ghPrDiffSource.js');
      return get(null, '445');
    },
  },
  {
    name: 'ghPrViewSource — Fetching GitHub PR metadata',
    line: 'Fetching GitHub PR #445 metadata\n',
    run: async () => {
      execAsyncMock.mockResolvedValue(JSON.stringify({ number: 445, title: 'A PR' }));
      const { get } = await import('#src/sources/ghPrViewSource.js');
      return get(null, '445');
    },
  },
  {
    name: 'jiraClient — the Jira fetch label',
    line: 'GET api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/PROJ-1\n',
    run: async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: 'PROJ-1' }) })
      );
      const { jiraRequest } = await import('#src/helpers/jira/jiraClient.js');
      return jiraRequest(
        { cloudId: 'cloud-1', fullBase64Token: 'dG9rZW4=' },
        '/rest/api/3/issue/PROJ-1'
      );
    },
  },
];

describe('progress-line gating, per construction site (review)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Deliberately NOT vi.resetModules(): the level is module state, and a reset would hand the
    // site under test a fresh `consoleLevel` module while `setConsoleLevel` below still wrote to
    // the old one — every quiet cell would then pass for the wrong reason. Nothing here needs a
    // fresh module graph; these sources hold no state between cells.
  });

  afterEach(() => {
    resetConsoleLevel();
    vi.unstubAllGlobals();
  });

  for (const site of sites) {
    describe(site.name, () => {
      it('draws its line, and nothing more, at the default info level', async () => {
        await site.run();

        expect(written()).toBe(site.line);
      });

      it('draws nothing at all at consoleLevel display — no label, no dots, no blank line', async () => {
        setConsoleLevel(StatusLevel.DISPLAY);

        await site.run();

        expect(written()).toBe('');
      });

      it('draws nothing at consoleLevel error either', async () => {
        setConsoleLevel(StatusLevel.ERROR);

        await site.run();

        expect(written()).toBe('');
      });
    });
  }
});
