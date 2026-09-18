/**
 * REL-20 — the report a review still owes its caller when the run ends before the agent.
 *
 * `writeOutputToFile` is a promise about a path: a workflow reads the file back and posts it. That
 * promise was kept only by runs that reached inference, because the file is created inside
 * `review()` and every content-fetch failure returns before it. A PR over GitHub's 300-file diff
 * limit therefore ended as `ENOENT: no such file or directory, open 'review.md'` in the *next* CI
 * step — a crash about a missing file, several steps away from the HTTP 406 that caused it.
 *
 * So a failed run writes the report too: the same heading a successful review opens with, one line
 * saying the review did not run, and the error exactly as the source produced it. The exit code
 * does not change — the run still failed — but what the workflow posts now names the failure
 * instead of dying on its absence.
 *
 * ## Why a shared helper rather than opening the report before the fetch
 *
 * Both were open (the file name is known before the fetch), and opening early was measured and
 * rejected. The report file is a capture of console output, so opening it before the fetch puts
 * everything the fetch prints into every SUCCESSFUL review: `fileSource` alone emits
 * `Reading file …` through `display`, and the requirement sources, the discovery agent and the
 * scoped-prompt warnings all write through the same channel. That is a visible change to the
 * document every existing user already reads, paid on every run, to fix the runs that fail.
 *
 * A helper called from each failing exit costs one line per exit and cannot touch the success path
 * at all — the success path never calls it.
 *
 * ## Why it writes synchronously, and why it truncates
 *
 * The session log is a `WriteStream`, and `stopSessionLogging()` ends it asynchronously. One of the
 * two callers here — the `gaunt-sloth-review` bin — follows its failure with `process.exit(1)`,
 * which tears the process down without waiting for a pending flush, so a report written through the
 * stream could simply not exist. A single `writeFileSync` has completed by the time it returns.
 *
 * It truncates where the session log appends. Appending would leave CI posting the previous run's
 * verdict with a failure notice stapled underneath it, which reads as a review that happened.
 *
 * @module
 */
import { writeFileSync } from 'node:fs';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { displayDebug, displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { reviewHeadingBlock } from '#src/modules/reviewHeading.js';
import { getCommandOutputFilePath } from '#src/utils/fileUtils.js';

/**
 * The one line that tells a reader of the report why there is no verdict under the heading.
 *
 * Exported so the specs assert on the same string production writes, rather than on a copy of it
 * that can drift out of agreement without anything going red.
 */
export const REVIEW_DID_NOT_RUN =
  'This review did not run. The error that stopped it follows; there is no verdict below it.';

/**
 * Write the promised report for a run that ended before the agent was reached.
 *
 * Call it from every exit that fails a `review`/`pr` run before `review()` is invoked, passing the
 * SAME source label that call would have used (`PR-42`, `PR-discovery`, `REVIEW`, `pr-review`) so
 * the file lands where the successful run would have put it — the label picks the generated file
 * name when `writeOutputToFile` is `true`.
 *
 * A no-op when the config asks for no file, so the default stdout-only run is untouched. It never
 * throws: it runs inside a catch, and a report that cannot be written must not replace the error
 * the caller is already reporting.
 *
 * @param config - The resolved config, or `undefined` when the run failed before config loaded
 *   (nothing can be written then — the path is a config field).
 * @param source - The source label the successful run would have passed to `review()`.
 * @param command - `review` or `pr`; names the command in the heading.
 * @param error - The failure, as an `Error` or as text already rendered for the terminal.
 * @returns The path written, or `null` when no report was asked for or the write failed.
 */
export function writeReviewFailureReport(
  config: GthConfig | undefined,
  source: string,
  command: 'pr' | 'review',
  error: unknown
): string | null {
  if (!config) {
    return null;
  }

  const filePath = getCommandOutputFilePath(config, source);
  if (!filePath) {
    return null;
  }

  // The same gate the successful report is under: `review()` opens the file with
  // `initSessionLogging(filePath, config.streamSessionInferenceLog)`, which writes nothing at all
  // when that flag is off. A failure report appearing for a user whose successful runs write none
  // would be a second, contradictory answer to "does this config produce a file".
  if (!config.streamSessionInferenceLog) {
    return null;
  }

  const body = `${REVIEW_DID_NOT_RUN}\n\n${errorText(error)}\n`;

  // GS2-93 — `output.header: 'none'` silences the heading here exactly as it does in `review()`. A
  // caller who turned it off to get a byte-clean stream did not ask for a clean stream only on the
  // days the review succeeds.
  //
  // The trailing blank line matches what the success path produces: `display()` appends a newline
  // to a heading block that already ends in one, so a report opens with the heading, a blank line,
  // and then its content.
  const report =
    config.output?.header === 'none'
      ? body
      : `${reviewHeadingBlock(command, config.modelDisplayName, config.modelProviderType)}\n${body}`;

  try {
    writeFileSync(filePath, stripAnsi(report), { encoding: 'utf8' });
    return filePath;
  } catch (writeError) {
    displayDebug(writeError instanceof Error ? writeError : String(writeError));
    displayError(`Failed to write review to file: ${filePath}`);
    return null;
  }
}

/**
 * The failure as the report should carry it: an `Error`'s message, or text a caller has already
 * rendered. Nothing is reformatted — the 406 a large PR produces already names the 300-file limit
 * and both ways around it, and a summary of it would lose exactly that.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The colour codes out, as the session log does to every line it writes.
 *
 * The report is read as a document — attached to a ticket, posted as a pull request comment — so a
 * successful one has never contained an escape sequence, and this path must not be the one that
 * starts. The text here is not ours: an error from a content source carries the child process's
 * stderr, and a `gh` that decided it was talking to a terminal colours that. Same treatment on both
 * paths is the only way the two cannot diverge, since only one of them is ever looked at.
 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
