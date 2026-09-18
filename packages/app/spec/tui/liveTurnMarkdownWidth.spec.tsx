import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import { LiveTurn } from '#src/tui/components/LiveTurn.js';
import { renderMarkdown } from '#src/tui/markdown.js';
import { foldEventSequence } from '#src/tui/viewModel.js';

/**
 * [[REL-13]] — the row-count oracle and the renderer draw a committed turn's markdown at the SAME
 * width.
 *
 * `transcriptWindow.ts` measures a committed text run as `renderMarkdown(segment.text, { columns })`
 * — the turn's own frame width. `<LiveTurn>` paints that run through its own `renderMarkdown` call,
 * and a call that passes no width falls back to `stdout.columns` instead, so the two sit on two
 * different numbers. Both normally resolve to the same terminal, which is why the disagreement is
 * latent rather than something a reader sees; what it costs is that the oracle's measurement is
 * taken of a string the renderer never draws, once per text run.
 *
 * The asserted quantity is the **rendered width** each path produces, not the argument each passes:
 * a spec that checked the options object still passes when the number in it is the wrong one.
 * Width is observable because `columns` feeds exactly one thing inside the renderer — the full-width
 * `─` rules that bracket a fenced block and stand in for a `---`.
 */

/** A fenced block, so the render contains rules whose width IS the number under test. */
const MARKDOWN = ['Here is the shape:', '', '```ts', 'const a = 1;', '```'].join('\n');

/** The turn's own frame width — deliberately not the fallback, and not the ambient terminal. */
const TURN_COLUMNS = 24;

/**
 * The ambient `stdout.columns` an options-less render would fall back to. Pinned, and distinct from
 * both {@link TURN_COLUMNS} and `ruleWidth`'s 80-column unknown-terminal default, so this spec's
 * red is the same number on a TTY-attached run as on a piped one.
 */
const AMBIENT_COLUMNS = 100;

/**
 * The Ink terminal the turn is rendered into. Wider than `AMBIENT_COLUMNS` on purpose: rendered at
 * the ambient width, Ink would wrap an ambient-width rule back down to the frame and both paths
 * would measure the same however wide the rule was drawn — an assertion that cannot fail.
 */
const INK_COLUMNS = 160;

/** The widest row of a rendered block, ANSI stripped and ignoring any trailing padding. */
const widestRow = (rendered: string): number =>
  Math.max(
    ...stripAnsi(rendered)
      .split('\n')
      .map((row) => row.trimEnd().length)
  );

let originalColumns: PropertyDescriptor | undefined;

describe('REL-13 — a committed turn renders markdown at the width the oracle measures it at', () => {
  beforeEach(() => {
    // `systemUtils.stdout` IS `process.stdout`, and `renderMarkdown` reads `.columns` off it per
    // call, so redefining the property pins the fallback. Done here rather than by mocking the
    // module because the spread mock would hand every other consumer in `<LiveTurn>`'s import graph
    // a stream object that is not the real one.
    originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', {
      value: AMBIENT_COLUMNS,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalColumns) Object.defineProperty(process.stdout, 'columns', originalColumns);
    else delete (process.stdout as unknown as { columns?: number }).columns;
  });

  it('paints its rules at the turn’s frame width, matching what the oracle measured', () => {
    const turn = foldEventSequence([{ type: 'text', delta: MARKDOWN } as AgentStreamEvent]);

    // The renderer path: what a reader actually sees, measured off Ink's own output.
    const painted = renderToString(<LiveTurn turn={turn} columns={TURN_COLUMNS} />, {
      columns: INK_COLUMNS,
    });
    // The oracle path: the exact expression `transcriptWindow.ts` measures a text run through.
    const measured = renderMarkdown(MARKDOWN, { columns: TURN_COLUMNS });

    expect(widestRow(painted)).toBe(widestRow(measured));
    // Anchored, so the two cannot agree by both drifting onto the ambient width together.
    expect(widestRow(measured)).toBe(TURN_COLUMNS);
  });

  it('has an ambient width that would show, so the agreement above is not a coincidence', () => {
    // The control: proves the pin took effect and that the fixture really can tell the two widths
    // apart. Without it, a render that collapsed both paths onto one wrong number would read green.
    expect(widestRow(renderMarkdown(MARKDOWN))).toBe(AMBIENT_COLUMNS);
  });
});
