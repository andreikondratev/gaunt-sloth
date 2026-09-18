import { StatusLevel } from '#src/core/types.js';
import { shouldDisplayLevel } from '#src/utils/consoleLevel.js';
import { stdout } from '#src/utils/systemUtils.js';

/**
 * The rung a progress line speaks at: {@link StatusLevel.INFO}, the same one the tool-call
 * announcements use, because a progress line says the same kind of thing — *work is happening* —
 * and belongs to the same step of quietening.
 *
 * **INFO rather than DISPLAY, and the arithmetic is the whole argument.** The gate is
 * `level >= consoleLevel`, so a DISPLAY-tagged line is still printed at `consoleLevel: "display"` —
 * it is `display` output, that is what the rung means. The configuration this was reported from is
 * exactly `consoleLevel: "display"`, so a DISPLAY tag would have quietened nothing there. At INFO
 * the line is shown at `debug` and `info` (`info` is the default, so nothing changes for anyone who
 * has not asked) and gone from `display` upward.
 *
 * One rung for the label AND the dots. They are one line: the label says what is happening and the
 * dots say it still is, and a reader who does not want the second has no use for the first. Two
 * knobs for one line would also have to be documented as two, which is the cost the node weighed
 * them against.
 */
export const PROGRESS_STATUS_LEVEL = StatusLevel.INFO;

/**
 * A dot-per-second terminal progress indicator.
 *
 * **TUI-C110 — the console level decides whether this line exists, and it decides ONCE.** Everything
 * else the CLI prints goes through `utils/consoleUtils.ts` and is filtered by `consoleLevel`; this
 * class wrote straight to stdout and consulted nothing, so its label and its dots survived every
 * rung, `error` included. The gate is now the same predicate `consoleUtils` uses
 * ({@link @gaunt-sloth/core!utils/consoleLevel.shouldDisplayLevel | shouldDisplayLevel}, in a module
 * both can import) rather than a second copy of the level logic living here.
 *
 * The writes stay on `systemUtils`' stdout instead of moving into a `consoleUtils` helper because
 * there is no helper they fit: every one of those takes a complete message and terminates it, and
 * this is a single line assembled from a label, a dot per second, and a terminating newline written
 * some seconds later. What routing it through `consoleUtils` was for is one gate, not one function
 * call, and one gate is what it now has.
 *
 * **Why the decision is taken once, in the constructor.** A per-write check would let a level change
 * mid-line tear the line in half: a label with no newline after it, or a newline closing a line
 * nothing opened — and that second one is the blank row a naive gate leaves behind exactly where the
 * dots used to be. Deciding once makes the line all-or-nothing, which is the same rule
 * `consoleUtils`' notices follow (the gate is per notice, never per line).
 *
 * A gated-out indicator also arms **no interval**: there is nothing for it to write, and the timer
 * is an active libuv handle, so a quieted run now has one fewer per-second wakeup rather than a
 * silent one.
 *
 * **EXT-53 — always stop it, on every exit path.** In its automatic (non-`manual`) mode the
 * indicator owns a 1s `setInterval`, which is an *active libuv handle*: while it is alive Node's
 * event loop can never drain and the process cannot exit, no matter that every await has resolved.
 * A `stop()` that is only reachable on the success path therefore turns any error into a hang
 * rather than an exit. Construct the indicator OUTSIDE the `try` and clear it in a `finally`.
 *
 * `stop()` is idempotent (see below), so a `finally { indicator.stop() }` is always safe to add
 * even where a success-path `stop()` already ran.
 */
export class ProgressIndicator {
  private interval: number | undefined = undefined;
  private readonly manual: boolean;
  /**
   * Whether this line is drawn at all, resolved once from the console level when the line starts.
   * `false` makes every write of this indicator — label, dots, and the terminating newline — a
   * no-op, which is what stops a quieted run gaining a blank line where the dots used to be.
   */
  private readonly visible: boolean;
  private stopped = false;

  constructor(initialMessage: string, manual?: boolean) {
    this.manual = !!manual;
    this.visible = shouldDisplayLevel(PROGRESS_STATUS_LEVEL);
    if (!this.visible) {
      return;
    }
    stdout.write(initialMessage);
    if (!this.manual) {
      this.interval = setInterval(this.indicateInner, 1000) as unknown as number;
    }
  }

  /**
   * Passed to `setInterval` unbound, so it must not read `this` — a timer callback is invoked with
   * the Timeout object as its receiver, and `this.visible` read here would be `undefined`, silently
   * suppressing the dots at every rung. The visibility check belongs where the receiver is known:
   * the constructor (which never arms the interval when hidden) and {@link indicate}.
   */
  private indicateInner(): void {
    stdout.write('.');
  }

  indicate(): void {
    if (!this.manual) {
      throw new Error('ProgressIndicator.indicate only to be called in manual mode');
    }
    // Checked after the misuse guard on purpose: calling this on an automatic indicator is a
    // programming error at every console level, and a quieted console must not swallow it.
    if (!this.visible) {
      return;
    }
    this.indicateInner();
  }

  /**
   * Clear the interval (releasing the libuv handle) and terminate the dot line with a newline.
   *
   * The newline is written only for a line that was actually started: a hidden indicator closes
   * nothing, because there is nothing to close.
   *
   * Idempotent: the handle is nulled and a second call is a complete no-op, so it emits no stray
   * blank line. That is what makes it safe to call from a `finally` on top of an existing
   * success-path `stop()`.
   */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    if (this.visible) {
      stdout.write('\n');
    }
  }
}
