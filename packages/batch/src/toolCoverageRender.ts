/**
 * @packageDocumentation
 * BATCH-32 — render a {@link ToolCoverageReport} as plain lines.
 *
 * A pure string builder, separate from the reporter that prints it (the `classificationRender.ts`
 * precedent): the console rendering is unit-testable without mocking `consoleUtils`, and another
 * reporter can emit the same block without reimplementing the layout.
 *
 * Total over the report — no "…and 12 more" anywhere. The uncovered list IS the output; a renderer
 * that truncates it turns the one actionable part of the block into a teaser, and a truncated list
 * reads as a complete one.
 */
import type { ToolCoverageReport, ToolCoverageServerReport } from '#src/toolCoverage.js';

/** The headline label, shared by the per-suite line and the run-level aggregate. */
const HEADLINE = 'TOOL COVERAGE';

/** How many tools the report's fraction is over (covered + uncovered). */
function denominatorOf(report: ToolCoverageReport): number {
  return report.covered.length + report.uncovered.length;
}

/** A bucket's human label: the server key, or what the bucket holds instead of one. */
function serverLabel(bucket: ToolCoverageServerReport): string {
  if (bucket.kind === 'mcp') return bucket.server ?? '';
  if (bucket.kind === 'builtin') return 'built-in / config tools';
  return 'unattributed MCP tools';
}

/** Options for {@link renderToolCoverage}. */
export interface RenderToolCoverageOptions {
  /**
   * Prefix the headline with this word — `'TOTAL'` for the run-level aggregate that follows
   * `EVAL TOTAL:`, so the two numbers on screen are never mistaken for each other.
   */
  scope?: string;
}

/**
 * Render the whole block: the fraction, what qualifies it, the uncovered names, the per-server
 * breakdown, any warnings, and any gate failures.
 *
 * The waived count sits on the headline rather than below it. A suite waiving 38 of 41 reports
 * 100%, and a reader who sees only the fraction has been told the opposite of the truth — so the
 * qualifier has to arrive in the same glance as the number it qualifies, not in a detail line that
 * scrolls or gets skimmed.
 */
export function renderToolCoverage(
  report: ToolCoverageReport,
  options: RenderToolCoverageOptions = {}
): string[] {
  const lines: string[] = [];
  const total = denominatorOf(report);
  const headline = options.scope ? `${HEADLINE} ${options.scope}` : HEADLINE;

  const qualifiers: string[] = [];
  if (report.waived.length > 0) qualifiers.push(`${report.waived.length} waived`);
  if (report.filteredOut.length > 0) {
    qualifiers.push(`${report.filteredOut.length} filtered out by allowedTools`);
  }
  if (report.unnamed > 0) qualifiers.push(`${report.unnamed} unnamed (not counted)`);

  lines.push(
    `${headline}: ${report.covered.length}/${total} tools exercised` +
      (qualifiers.length > 0 ? ` — ${qualifiers.join(', ')}` : '')
  );

  // Coverage counts a CALL. Said in the output rather than left for the reader to assume, because
  // the alternative reading (the tool was called AND returned something usable) is the one a person
  // reaching for a coverage number is likely to want.
  lines.push('  a tool counts as covered once a case CALLED it, error result or not');

  if (report.uncovered.length > 0) {
    lines.push(`  uncovered: ${[...report.uncovered].sort().join(', ')}`);
  }
  if (report.waived.length > 0) {
    lines.push(`  waived: ${[...report.waived].sort().join(', ')}`);
  }
  if (report.filteredOut.length > 0) {
    lines.push(`  filtered out by allowedTools: ${[...report.filteredOut].sort().join(', ')}`);
  }

  // Per-server only once more than one MCP server is configured — with a single server the
  // breakdown restates the headline, and printing it twice is noise rather than information. The
  // report still carries every bucket in `results.json`, where a reader is not paying for lines.
  const mcpBuckets = report.byServer.filter((bucket) => bucket.kind === 'mcp');
  if (mcpBuckets.length > 1) {
    lines.push('  by server:');
    for (const bucket of report.byServer) {
      const bucketTotal = bucket.covered.length + bucket.uncovered.length;
      lines.push(
        `    ${serverLabel(bucket)}: ${bucket.covered.length}/${bucketTotal}` +
          (bucket.uncovered.length > 0
            ? ` — uncovered: ${[...bucket.uncovered].sort().join(', ')}`
            : '')
      );
    }
  }

  for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  for (const failure of report.gateFailures) lines.push(`TOOL COVERAGE GATE FAILED — ${failure}`);

  return lines;
}
