/**
 * The console level — the single piece of state `consoleLevel` configures, and the single predicate
 * that decides whether a given {@link StatusLevel} reaches the terminal.
 *
 * ## Why this is a module of its own and not a section of `consoleUtils`
 *
 * The gate has to be reachable by every writer, and `consoleUtils` is not a place every writer can
 * import from. Its helpers each take a whole message and terminate it with a newline, so a writer
 * that emits a PARTIAL line — `utils/ProgressIndicator.ts`, which writes a label, then a dot per
 * second, then the newline that closes the line — has no helper it can use and, while the level was
 * private to that module, no gate it could consult either. What it did instead was write straight to
 * `systemUtils`' stdout, which put a whole class of terminal output outside the level system: no
 * rung of `consoleLevel`, including `error`, could quieten it.
 *
 * Splitting the state out costs nothing and removes the reason: consulting the gate no longer means
 * importing the console surface. {@link @gaunt-sloth/core!utils/consoleUtils | consoleUtils}
 * re-exports the three public setters so `consoleLevel` keeps one public spelling, and both it and
 * the indicator now ask the same {@link shouldDisplayLevel}.
 *
 * It also makes the gate real under test, which matters for a gate: specs across all three packages
 * replace `consoleUtils` wholesale with a factory mock, and a predicate imported from there is one
 * that disappears in exactly the specs that drive the writers.
 *
 * @module
 */
import { StatusLevel } from '#src/core/types.js';

// Internal state for console level control
interface ConsoleLevelState {
  currentLevel: StatusLevel;
}

const consoleLevelState: ConsoleLevelState = {
  currentLevel: StatusLevel.INFO, // Default to INFO level, not debug
};

/**
 * Set the console logging level.
 * Only messages at or above this level will be displayed.
 * @param level - The minimum level to display
 */
export const setConsoleLevel = (level: StatusLevel): void => {
  consoleLevelState.currentLevel = level;
};

/**
 * Get the current console logging level.
 * @returns The current console level
 */
export const getConsoleLevel = (): StatusLevel => {
  return consoleLevelState.currentLevel;
};

/**
 * Reset console level to default (INFO) for testing purposes
 */
export const resetConsoleLevel = (): void => {
  consoleLevelState.currentLevel = StatusLevel.INFO;
};

/**
 * Check if a given status level should be displayed based on current console level.
 * @param level - The status level to check
 * @returns true if the level should be displayed
 */
export function shouldDisplayLevel(level: StatusLevel): boolean {
  // Use enum values for comparison (higher values = more verbose)
  return level >= consoleLevelState.currentLevel;
}
