// QA-13 — read the PTY e2e run's structured result and make a *flaky* outcome escape the log.
//
// A case that fails and then passes on a retry leaves the run green, which is the right exit code:
// the node's acceptance asks for a flake to be REPORTED as flaky, not turned into a failure
// (promoting one is the promote-after-soak rule, which belongs to OPS-14). What a green run loses is
// reach — a flake buried in a log nobody opens decays into invisible noise. These helpers turn it
// into a GitHub annotation and a job-summary entry, which survive a green run, and they carry the
// error each failed attempt recorded, because a flake is matched on its message in
// docs/known-flakes.md (takahe).
//
// The input is the JSON `tui-e2e-results-reporter.mjs` writes from vitest's reporter API — the
// case's final state, its retry count and its attempts' errors, as data. Nothing here parses
// terminal output. What this module still has to be is LOUD: a result it cannot read, a schema it
// does not know, or a run that ran no cases at all is reported as a problem, because a checker that
// has gone blind must never report "no flakes".
//
// `decideVerdict` holds every decision `run-tui-e2e.js` makes after the run, as a pure function, so
// each verdict branch is unit-tested; the runner only reads files and writes what it is told to.

/** The result schema this module reads. Must equal `RESULTS_SCHEMA` in tui-e2e-results-reporter.mjs. */
export const KNOWN_RESULTS_SCHEMA = 2;

/**
 * Turn the structured result into the run's verdict.
 *
 * @param {string} raw the contents of the results file
 * @returns {{
 *   summary: null | { failed: number, flaky: number, didNotRun: number, skipped: number, passed: number, total: number },
 *   failed: { file: string, row: number | null, column: number | null, title: string, errors: string[] }[],
 *   flaky: { file: string, row: number | null, column: number | null, title: string, errors: string[] }[],
 *   problem: string | null,
 * }}
 */
export function analyseRun(raw) {
  const blind = (problem, summary = null) => ({ summary, failed: [], flaky: [], problem });

  let record;
  try {
    record = JSON.parse(raw);
  } catch (err) {
    return blind(
      `the results file is not JSON (${err instanceof Error ? err.message : String(err)}), so ` +
        'the flake check cannot tell what ran.'
    );
  }
  if (record === null || typeof record !== 'object' || record.schema !== KNOWN_RESULTS_SCHEMA) {
    return blind(
      `the results file has schema ${JSON.stringify(record?.schema)}, and this checker reads ` +
        `schema ${KNOWN_RESULTS_SCHEMA}. The reporter and the checker have drifted apart.`
    );
  }
  if (!Array.isArray(record.cases) || !Array.isArray(record.modules)) {
    return blind('the results file has no case list, so the flake check cannot tell what ran.');
  }

  const entry = (c) => ({
    file: c.file,
    row: c.line,
    column: c.column,
    title: c.title,
    errors: Array.isArray(c.errors) ? c.errors.map(String) : [],
  });
  const cases = record.cases;
  const summary = {
    failed: 0,
    flaky: 0,
    didNotRun: cases.filter((c) => c.state === 'pending').length,
    skipped: cases.filter((c) => c.state === 'skipped').length,
    passed: cases.filter((c) => c.state === 'passed').length,
    total: cases.length,
  };
  const flaky = cases
    .filter((c) => c.state === 'passed' && (c.flaky === true || c.retryCount > 0))
    .map(entry);
  summary.flaky = flaky.length;

  // A file that failed to load contributes no cases at all, so it is counted here or nowhere.
  const brokenModules = record.modules
    .filter((m) => m.state === 'failed' && Array.isArray(m.errors) && m.errors.length > 0)
    .map((m) => ({
      file: m.file,
      row: null,
      column: null,
      title: `(file failed: ${String(m.errors[0]).split('\n')[0]})`,
      errors: m.errors.map(String),
    }));
  const failed = [...cases.filter((c) => c.state === 'failed').map(entry), ...brokenModules];
  summary.failed = failed.length;

  if (summary.passed + summary.failed === 0) {
    return blind(
      `the run discovered ${summary.total} case(s) and ran none of them (` +
        `${summary.skipped} skipped, ${summary.didNotRun} did not run). A suite that ran nothing ` +
        'is a gate that measured nothing, so this run is not green.',
      summary
    );
  }
  if (record.reason === 'interrupted') {
    return blind(
      'the run was interrupted before it finished, so its result is incomplete.',
      summary
    );
  }

  return { summary, failed, flaky, problem: null };
}

/**
 * The directories the report says would not delete, so the caller can try them again once the whole
 * run has exited. Separated from {@link describeLeakReport} so the retry lives in the parent
 * process — where no worker, and therefore no session, can still be running.
 *
 * @param {string} raw contents of the report file
 * @returns {string[]}
 */
export function leakedDirs(raw) {
  const dirs = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record.kind === 'unremovable' && typeof record.dir === 'string') dirs.push(record.dir);
    } catch {
      // Handled, and reported, by describeLeakReport.
    }
  }
  return dirs;
}

/**
 * GS2-20 — read the report `fixtures/tmpHome.mjs` writes, and turn it into a failure message.
 * `null` means the run was clean.
 *
 * A file rather than a stream because the hooks that write it run in a test worker process, and
 * the parent is the one place that sees the whole run; the parent owns the worker's environment, so
 * handing down a path is the one channel that always arrives.
 *
 * Why this is a hard failure and not a warning: a `gth` session holds `<HOME>/.gsloth/history.db`
 * open for its whole life, and this suite is the only place that would notice a handle never being
 * released — the removal succeeds on POSIX regardless, so win32 is the sole detector.
 *
 * **The report carries two independent findings, and the message must not merge them**, because
 * they have different causes and different fixes:
 *
 * - `still-running` — a session did not exit within the wait after being killed. The removal that
 *   follows was racing a live process, and no amount of retrying the removal is the fix.
 * - `unremovable` — a directory would not delete, and the terminal engine had already reported an
 *   exit for every session in that file. **That is an observation, not a conclusion, and the
 *   message says so.** Whether the engine's exit report precedes the kernel releasing the
 *   process's handles on win32 is not established, so the recorded exit wait times are printed
 *   alongside: a run where every session "exited" in about a millisecond points at the signal
 *   itself, and a run of hundreds of milliseconds points at a handle that outlived its process.
 *
 * @param {string} raw contents of the report file (empty when nothing failed)
 * @param {Record<string, string>} [outcomes] per-directory result of re-attempting the removal
 *   once the whole run has exited, keyed by directory. A directory that deletes cleanly then was
 *   locked only transiently; one that still will not delete is holding.
 * @returns {string | null}
 */
export function describeLeakReport(raw, outcomes = {}) {
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // A row we cannot parse is still evidence that a hook reported something, so it must not be
      // silently dropped — that would turn a garbled report into a green run.
      records.push({ kind: 'unparseable', raw: trimmed });
    }
  }
  if (records.length === 0) return null;

  const stillRunning = records.filter((r) => r.kind === 'still-running');
  const unremovable = records.filter((r) => r.kind === 'unremovable');
  const unparseable = records.filter((r) => r.kind === 'unparseable');
  const parts = [];

  if (stillRunning.length > 0) {
    const waits = stillRunning.map((r) => `${r.waitedMs}ms`).join(', ');
    parts.push(
      `${stillRunning.length} session(s) were STILL RUNNING after the harness killed them and the ` +
        `suite waited for them to exit (waited: ${waits}).\n` +
        `  The kill is a bare process.kill(pid, 9) that does not wait, so anything the session had ` +
        `open was still open. Whatever else this run reports, that is the first thing to fix: a ` +
        `removal cannot be made reliable while it races a live process.`
    );
  }

  if (unremovable.length > 0) {
    const detail = unremovable
      .map((r) => {
        const outcome = outcomes[r.dir];
        return `    ${r.dir} — ${r.reason}${outcome ? ` [${outcome}]` : ''}`;
      })
      .join('\n');
    const waits = unremovable.find((r) => r.exitWaits)?.exitWaits;
    const timing = waits
      ? ` Those exits were reported in ${waits.minMs}-${waits.maxMs}ms across ${waits.n} session(s):` +
        ` single-digit values would make the signal itself the suspect, hundreds of milliseconds` +
        ` would mean the wait did real work and something outlived the process anyway.`
      : '';
    const context =
      stillRunning.length > 0
        ? `  At least one session outlived its kill in this run, so these may simply be that race.`
        : `  The pty reported an exit for every session in this run before its directory was ` +
          `removed. If that signal is faithful, a live session of ours is not what is holding ` +
          `these, which leaves a handle that outlived the process that opened it or a scanner on ` +
          `the host. On win32 how that signal relates to the process actually dying is not ` +
          `established, so it is evidence and not proof.${timing}`;
    parts.push(
      `${unremovable.length} throwaway HOME director${unremovable.length === 1 ? 'y' : 'ies'} ` +
        `could not be removed:\n${detail}\n${context}`
    );
  }

  if (unparseable.length > 0) {
    parts.push(
      `${unparseable.length} report row(s) could not be read, which means a hook reported ` +
        `something this cannot describe:\n` +
        unparseable.map((r) => `    ${r.raw}`).join('\n')
    );
  }

  return parts.join('\n');
}

/** Repo-relative path for an entry. Entry files are relative to the tui-e2e folder, with `/`. */
export function repoPath(entry, testDir = 'packages/app/tui-e2e') {
  return `${testDir}/${entry.file}`;
}

/** How long a signature may grow past its first line before the rest is cut. */
export const SIGNATURE_CHARS = 600;

/** At most this many distinct attempt errors are shown for one case. */
const MAX_ERRORS_SHOWN = 3;

/**
 * One recorded error as a single line: its non-empty lines, trimmed, joined with ` ⏎ `.
 *
 * The FIRST line is always kept whole, however long — it is the message a flake is matched on.
 * Only what follows it is cut, once the whole line passes {@link SIGNATURE_CHARS}; the reporter has
 * already dropped the stack and the harness's screen dump, so this guards against a message that is
 * long in its own right.
 *
 * @param {string} message
 * @returns {string}
 */
export function errorSignature(message) {
  const [first = '', ...rest] = String(message)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let signature = first;
  for (const line of rest) {
    const next = `${signature} ⏎ ${line}`;
    if (next.length > SIGNATURE_CHARS) return `${signature} ⏎ …`;
    signature = next;
  }
  return signature;
}

/**
 * The distinct errors an entry's failed attempts recorded, as signatures, with a repeat count: a
 * flake that failed twice the same way reads `… (2 attempts)`. Capped at a few, with the rest
 * counted, so one case cannot flood an annotation.
 *
 * @param {{ errors?: string[] }} entry
 * @returns {string[]}
 */
export function attemptErrors(entry) {
  const counts = new Map();
  for (const error of entry.errors ?? []) {
    const signature = errorSignature(error);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  if (counts.size === 0) return ['(no error was recorded for the failed attempt)'];
  const lines = [...counts].map(([signature, n]) =>
    n > 1 ? `${signature} (${n} attempts)` : signature
  );
  return lines.length > MAX_ERRORS_SHOWN
    ? [...lines.slice(0, MAX_ERRORS_SHOWN), `… and ${lines.length - MAX_ERRORS_SHOWN} more`]
    : lines;
}

/** Escape the message part of a GitHub workflow command. */
const escapeData = (text) =>
  String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/**
 * GitHub Actions workflow commands. A `::warning` attaches to the file and line in the run's
 * Files view and appears on the run summary, so it is visible without opening the job log —
 * which is the whole point, given the job itself is green. It carries the failed attempts' errors,
 * one per line, so the flake can be matched without the log either.
 */
export function githubAnnotations(flaky) {
  return flaky.map(
    (entry) =>
      `::warning file=${repoPath(entry)},line=${entry.row},col=${entry.column},title=Flaky TUI e2e::` +
      escapeData(
        `${entry.title} — passed only on a retry. Record it in docs/known-flakes.md (takahe) ` +
          `before this scrolls away.\nFailed attempt(s):\n` +
          attemptErrors(entry)
            .map((line) => `  ${line}`)
            .join('\n')
      )
  );
}

/** A table cell: no pipe may end the cell early, and no newline may end the row. */
const cell = (text) =>
  String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/\n/g, ' ');

/** Markdown for $GITHUB_STEP_SUMMARY — rendered on the run page itself. */
export function stepSummaryMarkdown(flaky, { os = process.platform } = {}) {
  const rows = flaky
    .map(
      (entry) =>
        `| \`${repoPath(entry)}:${entry.row}\` | ${cell(entry.title)} | ` +
        `${attemptErrors(entry).map(cell).join('<br>')} |`
    )
    .join('\n');
  return [
    `### ⚠️ ${flaky.length} flaky TUI e2e test${flaky.length === 1 ? '' : 's'} on ${os}`,
    '',
    'These passed only after a retry. The job is green, but an intermittent failure is a real',
    'defect that will cost somebody an unrelated investigation later.',
    '',
    '| Test | Title | Error on the failed attempt(s) |',
    '| --- | --- | --- |',
    rows,
    '',
    'Record it in `docs/known-flakes.md` in the takahe repo, matched on the error, so the next',
    'person mid-merge can recognise it in seconds.',
    '',
  ].join('\n');
}

/**
 * Every decision the runner makes once vitest has exited, in order:
 *
 * 1. **GS2-20 leak** — anything in the leak report fails the run, checked BEFORE the flake analysis,
 *    because a leak is a cause and a broken report is at most a symptom of one.
 * 2. **Blind analysis** — no results file, or one `analyseRun` reports a problem with (including a
 *    run that ran no cases), fails the run even if vitest exited 0.
 * 3. **Flakes** — printed with their errors, annotated and summarised; the run stays green.
 * 4. **A failure the result records while vitest exited 0** — fails the run.
 * 5. Otherwise vitest's own exit code is the verdict.
 *
 * Pure: it returns what to print and the exit code, and the runner does the I/O.
 *
 * @param {{ childCode: number, leak: string | null, results: string | null, githubActions?: boolean, os?: string }} input
 * @returns {{ exitCode: number, stdout: string, stderr: string, stepSummary: string | null }}
 */
export function decideVerdict({
  childCode,
  leak,
  results,
  githubActions = false,
  os = process.platform,
}) {
  // Never mask the child's own verdict: a red run that is also blind or leaky stays red for its own
  // reason, and a green one is turned red.
  const red = childCode === 0 ? 1 : childCode;

  if (leak) {
    return { exitCode: red, stdout: '', stderr: `\n✗ tui-e2e ${leak}\n`, stepSummary: null };
  }

  const analysis =
    results === null
      ? { problem: 'the run wrote no results file, so nothing is known about what ran.' }
      : analyseRun(results);
  if (analysis.problem) {
    return {
      exitCode: red,
      stdout: '',
      stderr: `\n✗ tui-e2e flake check could not read the run report: ${analysis.problem}\n`,
      stepSummary: null,
    };
  }

  const { summary, flaky } = analysis;
  let stdout =
    `\ntui-e2e: ${summary.passed} passed (${summary.flaky} flaky), ${summary.failed} failed, ` +
    `${summary.skipped} skipped, ${summary.didNotRun} did not run, ${summary.total} total\n`;
  let stepSummary = null;

  if (flaky.length > 0) {
    const lines = flaky.map(
      (entry) =>
        `    ${repoPath(entry)}:${entry.row} › ${entry.title}\n` +
        attemptErrors(entry)
          .map((line) => `        failed attempt: ${line}`)
          .join('\n')
    );
    stdout +=
      `\n⚠ ${flaky.length} FLAKY test(s) — passed only on a retry, so this run is green ` +
      `but the defect is real:\n${lines.join('\n')}\n` +
      `  Record it in docs/known-flakes.md (takahe), matched on the error, so the next person ` +
      `mid-merge does not have to re-derive it.\n`;
    if (githubActions) stdout += githubAnnotations(flaky).join('\n') + '\n';
    stepSummary = stepSummaryMarkdown(flaky, { os });
  }

  // A case that failed every attempt is already a non-zero vitest exit; the structured result is
  // checked too, so a red case can never be waved through by an exit code that disagrees with it.
  if (summary.failed > 0 && childCode === 0) {
    return {
      exitCode: 1,
      stdout,
      stderr: `\n✗ tui-e2e: vitest exited 0 but the result records ${summary.failed} failed case(s).\n`,
      stepSummary,
    };
  }

  // A flake stays green: vitest's own exit code is the authority on pass/fail, and the node's
  // acceptance asks for a flake to be *reported as flaky rather than as a pass*, not to be turned
  // into a failure. Promoting a flake to a hard failure is the promote-after-soak rule (OPS-14).
  return { exitCode: childCode, stdout, stderr: '', stepSummary };
}
