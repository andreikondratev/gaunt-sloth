/**
 * @packageDocumentation
 * GS2-16 — pure, fail-soft helpers that harvest per-run analytics (token usage + invoked tool
 * names) from LangChain messages, so the local history recorder can populate `gth insights`
 * with real numbers instead of zeros.
 *
 * The extraction is deliberately structural and defensive (duck-typed reads guarded by a
 * try/catch) rather than `instanceof`-based: the same accumulator serves both the non-streaming
 * `invoke` path (a full `messages[]` from graph state) and the streaming paths (individual
 * message chunks / `ToolMessage`s as they arrive), across providers whose message shapes vary.
 * Nothing here may throw into a run — a missing/odd field just means that datum is skipped.
 */
import { mcpToolErrorPayload } from '#src/core/mcpErrorPayload.js';
import type { GthRunStats, GthToolResult } from '#src/core/types.js';

/**
 * BATCH-21 — cap on a captured tool-result `content` (characters). Keeps a giant payload (a whole
 * file read, a long shell log) from bloating run stats; anything longer is truncated to this
 * length. Sized so realistic structured payloads (the `gth eval` tool-result-assertion use case)
 * survive intact.
 */
export const TOOL_RESULT_CONTENT_CAP = 8192;

/** Mutable tally behind {@link finalizeRunStats}; see {@link createRunStatsAccumulator}. */
export interface RunStatsAccumulator {
  /** Running sum of input/prompt tokens. */
  input: number;
  /** Running sum of output/completion tokens. */
  output: number;
  /** Whether ANY message reported `usage_metadata` — gates whether tokens are recorded at all. */
  sawUsage: boolean;
  /** Deduplicated set of invoked tool names. */
  tools: Set<string>;
  /** BATCH-21 — one record per executed tool result (`ToolMessage`), in arrival order, un-deduped. */
  toolResults: GthToolResult[];
}

/** A fresh, empty accumulator. */
export function createRunStatsAccumulator(): RunStatsAccumulator {
  return { input: 0, output: 0, sawUsage: false, tools: new Set<string>(), toolResults: [] };
}

/**
 * BATCH-21 — derive a tool result's text payload from a `ToolMessage.content`, fail-soft. A string
 * passes through; anything else non-`undefined` is JSON-stringified (the same derivation the
 * `tool_result` stream event uses in `GthAbstractAgent`); the result is capped at
 * {@link TOOL_RESULT_CONTENT_CAP}. Returns `undefined` (payload omitted) when nothing textual can
 * be derived — never throws.
 *
 * **A single content block is captured as the block, NOT unwrapped to its inner text — deliberately.**
 * The alternative (unwrap a lone `{type:'text',text}` so an eval's `tool_result_json_path` reaches
 * the inner JSON without a `text` hop) was considered and rejected:
 *
 * - **The capture must be what the MODEL observed.** That is the one property a tool-result trace
 *   exists to preserve; an eval that grades a payload the model never saw grades a fiction.
 * - **No shape is unreachable, so nothing is being worked around.** `resolveJsonPath` normalizes
 *   `[0]` index syntax, so a block reachable at `text` in the object form is reachable at `[0].text`
 *   in the array form; a bare-string payload parses directly.
 * - **Unwrapping would silently break suites already written to the documented `text` hop**, and it
 *   would make the capture depend on which MCP-adapter branch produced the content (a lone text
 *   block arrives as a bare string, but as a block object once the server also returns
 *   `structuredContent`/`_meta`) — swapping a stated contract for an inferred one.
 * - It would not help the case this capture exists for anyway: a SOFTENED MCP error's payload is
 *   the adapter's own error message (prose, then the server's text), so it is not JSON at any hop.
 */
function toolResultContentText(content: unknown): string | undefined {
  try {
    let text: string | undefined;
    if (typeof content === 'string') {
      text = content;
    } else if (content !== undefined) {
      text = JSON.stringify(content);
    }
    if (text === undefined) return undefined;
    return text.length > TOOL_RESULT_CONTENT_CAP ? text.slice(0, TOOL_RESULT_CONTENT_CAP) : text;
  } catch {
    /* fail-soft: an unstringifiable payload just means no content is recorded */
    return undefined;
  }
}

/**
 * Fold one LangChain message (or message chunk) into the accumulator. Fail-soft: any unexpected
 * shape is swallowed so a run is never affected. Harvests, when present:
 * - `usage_metadata.input_tokens` / `.output_tokens` (summed; marks `sawUsage`),
 * - tool names from an AIMessage's requested `tool_calls[].name` AND from a `ToolMessage`'s own
 *   `.name` (the executed tool), so both "requested" and "executed" tools are captured, and
 * - (BATCH-21) a per-`ToolMessage` result record — `name` + `isError` (from `.status`) + capped
 *   `content` — into `acc.toolResults`, so tool-RESULT assertions can grade what a tool returned.
 *
 * `configuredMcpServers` is `Object.keys(config.mcpServers)`, used only to resolve which server an
 * errored MCP tool belongs to (BATCH-43; see the record's `errorPayload`). It is passed per fold
 * rather than held on the accumulator so this never depends on the accumulator being re-created
 * after the config is known — the default leaves every non-MCP capture exactly as it was.
 */
export function accumulateMessage(
  acc: RunStatsAccumulator,
  message: unknown,
  configuredMcpServers: Iterable<string> = []
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = message as any;
    if (!m || typeof m !== 'object') return;

    const usage = m.usage_metadata;
    if (usage && typeof usage === 'object') {
      acc.sawUsage = true;
      if (typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) {
        acc.input += usage.input_tokens;
      }
      if (typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)) {
        acc.output += usage.output_tokens;
      }
    }

    // Requested tool calls (AIMessage / AIMessageChunk). Continuation chunks in a streamed
    // tool call carry an empty name, so guard on a non-empty string; the Set dedupes repeats.
    const toolCalls = m.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const name = tc?.name;
        if (typeof name === 'string' && name.length > 0) acc.tools.add(name);
      }
    }

    // Executed tool result (ToolMessage). Its `.name` is the tool that produced the result.
    const type: unknown = typeof m.getType === 'function' ? m.getType() : m._getType?.();
    if (type === 'tool' && typeof m.name === 'string' && m.name.length > 0) {
      acc.tools.add(m.name);
      // BATCH-21 — capture the RESULT record too (same capture site, same fail-soft discipline):
      // `.status === 'error'` is LangChain's real tool-error signal, `.content` the returned
      // payload (capped; omitted when no text can be derived). One record per ToolMessage, in
      // arrival order — deliberately NOT deduplicated, unlike the name set above.
      const content = toolResultContentText(m.content);
      // BATCH-43 — beside the observed payload, never instead of it: an errored MCP tool's result
      // is the adapter's own prose-prefixed message, which `tool_result_json_path` cannot parse.
      // `mcpToolErrorPayload` rebuilds that prefix from the resolved server + tool name and strips
      // it, yielding the server's own error body when (and only when) it is JSON. Derived from the
      // RAW `m.content`, not from the capped `content` above — deriving after the cap would work on
      // every payload short enough to test with and silently stop working on the long ones. The cap
      // is applied inside, to the derived payload, for the reason its docblock gives.
      const isError = m.status === 'error';
      const errorPayload = mcpToolErrorPayload(
        { name: m.name, isError, content: m.content },
        configuredMcpServers,
        TOOL_RESULT_CONTENT_CAP
      );
      acc.toolResults.push({
        name: m.name,
        isError,
        ...(content !== undefined ? { content } : {}),
        ...(errorPayload !== undefined ? { errorPayload } : {}),
      });
    }
  } catch {
    /* fail-soft: never let stats capture affect a run */
  }
}

/** Freeze the accumulator into the public {@link GthRunStats}. Tokens omitted unless observed. */
export function finalizeRunStats(acc: RunStatsAccumulator): GthRunStats {
  return {
    tokensInput: acc.sawUsage ? acc.input : undefined,
    tokensOutput: acc.sawUsage ? acc.output : undefined,
    tools: [...acc.tools],
    toolResults: [...acc.toolResults],
  };
}

/**
 * One-shot convenience for the non-streaming path: fold a full `messages[]` (e.g. the final graph
 * state) into a fresh accumulator and finalize. Fail-soft (a non-iterable input yields empties).
 */
export function extractRunStats(
  messages: unknown,
  configuredMcpServers: Iterable<string> = []
): GthRunStats {
  const acc = createRunStatsAccumulator();
  try {
    if (Array.isArray(messages)) {
      for (const m of messages) accumulateMessage(acc, m, configuredMcpServers);
    }
  } catch {
    /* fail-soft */
  }
  return finalizeRunStats(acc);
}
