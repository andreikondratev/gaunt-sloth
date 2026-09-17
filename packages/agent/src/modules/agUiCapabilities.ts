import { createRequire } from 'node:module';
import { EventType } from '@ag-ui/core';
import type { AgentCapabilities, Tool } from '@ag-ui/core';
import type { BaseToolkit, StructuredToolInterface } from '@langchain/core/tools';
import { isClientFulfilledTool } from '@gaunt-sloth/core/core/GthAbstractAgent.js';
import type { GthAbstractAgent } from '@gaunt-sloth/core/core/GthAbstractAgent.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { z } from 'zod';

/**
 * [[EXT-166]] — what the AG-UI server says about itself, for `GET /agents/:agentId/capabilities`.
 *
 * The protocol defines the shape (`AgentCapabilitiesSchema` in `@ag-ui/core`) and the client-side
 * hook (`getCapabilities()` on `AbstractAgent`) and deliberately defines no transport, so the
 * endpoint follows the one worked example in the ag-ui repository: the ADK middleware, whose server
 * half serves the declaration as JSON on a sibling path of the run endpoint and whose client half
 * parses it with `AgentCapabilitiesSchema.safeParse`.
 *
 * **Every value here is derived from something the server can be asked at runtime**, and that is
 * the whole point of the file rather than a style preference. A hand-written capability block is a
 * second source of truth: it is correct the day it is written and silently wrong from the first
 * change to the thing it describes, with nothing anywhere to notice. So the tool list is read off
 * the agent's own advertised inventory, the identity off the shipped package manifest, the model
 * off the same config read `GET /info` uses, and the three event-shaped categories off
 * {@link AG_UI_EMITTED_EVENT_TYPES} — the set a spec holds equal to the run path's actual emissions.
 *
 * **Absent means undeclared, not unsupported**, which is the schema's own rule and the reason the
 * categories this server has not measured (`output`, `multiAgent`, `multimodal`, `execution`) are
 * simply missing rather than filled in with `false`.
 */

/**
 * The command `startAgUiServer` initialises its agent as, and the same string reported to a client
 * as `identity.metadata.command`. One constant rather than two literals, so the declaration cannot
 * describe a command the server did not start as.
 */
export const AGUI_AGENT_COMMAND = 'api';

/**
 * Every AG-UI event type the run path in `apiAgUiModule.ts` can write.
 *
 * `transport`, `tools.supported`, `state` and `reasoning` below are projections of this set, so a
 * capability is declared only where an event actually carries it. The set is the one place the
 * server's emissions are written down twice, and `apiAgUiModule.capabilities.spec.ts` closes that
 * gap: it scans the server for its `type: EventType.X` sites and fails unless that set and this one
 * are **equal**. Equality rather than containment on purpose — the drift worth catching is an
 * emission the server gained and this list never heard about, which a subset check passes.
 *
 * Add an emission to the run path and that spec names this constant; update it, and the declared
 * capabilities follow with no further edit.
 */
export const AG_UI_EMITTED_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  EventType.RUN_STARTED,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_RESULT,
  EventType.REASONING_MESSAGE_START,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_END,
  EventType.CUSTOM,
]);

const emits = (type: EventType): boolean => AG_UI_EMITTED_EVENT_TYPES.has(type);

/** The subset of the shipped package manifest this file reads. Every field optional: see below. */
interface AgentPackageManifest {
  name?: string;
  version?: string;
  description?: string;
  homepage?: string;
  author?: string | { name?: string };
}

/**
 * The manifest of the package that implements this server, or `null` when it cannot be read.
 *
 * Resolved relative to this module rather than through `getSlothVersion()`, which reads the
 * manifest under the *install* dir — a location only an entry point registers, so a programmatic
 * `startAgUiServer` caller has none and the read throws. `src/modules/` and `dist/modules/` sit at
 * the same depth, so the one relative path serves the built and the source layout alike, and the
 * four packages are version-locked, so the number here is the number `gth --version` prints.
 *
 * Fail-soft: identity is metadata. A manifest that cannot be read costs a client some display
 * strings; it must never cost it the capability declaration.
 */
function readAgentManifest(): AgentPackageManifest | null {
  try {
    return createRequire(import.meta.url)('../../package.json') as AgentPackageManifest;
  } catch {
    return null;
  }
}

/** The maintainer named by the manifest, as a plain string, or `undefined` when it names none. */
function manifestAuthor(manifest: AgentPackageManifest): string | undefined {
  const author = manifest.author;
  if (typeof author === 'string') return author.trim() || undefined;
  if (author && typeof author === 'object') return author.name?.trim() || undefined;
  return undefined;
}

/**
 * The provider and model serving this config, as `GET /info` reports them.
 *
 * **One derivation for both routes.** `/info` and the capability declaration describing the model
 * differently would be this node's own failure mode reproduced one file away — and the two are read
 * by the same client, for the same reason, often in the same session.
 *
 * `provider` is the LangChain model's `_llmType()` (`"ollama"`, `"anthropic"`, …) and `model` is
 * the configured display name falling back to the chat model's own field. Both are `null` rather
 * than absent when nothing resolves, because `/info` has always answered that way and a caller
 * distinguishing "no model configured" from "key missing from the response" is reading the wrong
 * thing either way.
 *
 * ## The two routes agree only when a model resolved
 *
 * `/info` does not always reach this function. CFG-61 put an `isUsableModel(config.llm)` guard in
 * front of it, so a server holding a raw unrouted `{ type, model }` spec answers `/info` with
 * `{ status: 'error', provider: null, model: null }` while the capability declaration still reports
 * the requested name — measured, not inferred: `/info` says `model: null` where `identity.metadata`
 * says `"gemma4:12b"`. A config carrying no `llm` at all has both saying `null`, so the gap is
 * specific to the raw-spec case.
 *
 * That is deliberate as far as the READINESS question goes: a capability declaration says what this
 * agent is built to do, not whether it can serve a request this second, and `/health` is the
 * endpoint that answers the latter. It is **not** settled for the model NAME, which is a statement
 * of fact rather than of readiness. Do not close the gap by making this function readiness-aware —
 * both callers read it, and that would make the declaration answer a question it is not asked.
 */
export function describeConfiguredModel(config: GthConfig): {
  provider: string | null;
  model: string | null;
} {
  const llm = config.llm as { _llmType?: () => string; model?: string } | undefined;
  let provider: string | null = null;
  try {
    provider = typeof llm?._llmType === 'function' ? llm._llmType() : null;
  } catch {
    provider = null;
  }
  return { provider, model: config.modelDisplayName ?? llm?.model ?? null };
}

/**
 * `config.tools` with toolkits expanded, read-only.
 *
 * Deliberately not `GthAbstractAgent.extractAndFlattenTools`, which is the agent's binding path and
 * *rewrites* a client-fulfilled tool's body to an `interrupt()` stub. Describing the toolset must
 * not be able to change it.
 */
function flattenConfigTools(config: GthConfig): StructuredToolInterface[] {
  const flattened: StructuredToolInterface[] = [];
  for (const entry of (config.tools ?? []) as unknown[]) {
    const maybeToolkit = entry as BaseToolkit;
    if (typeof (entry as { getTools?: unknown })?.getTools === 'function') {
      try {
        flattened.push(...maybeToolkit.getTools());
      } catch {
        // A toolkit that cannot list itself is described as contributing nothing, never as a
        // failed request: this endpoint's job is to answer.
      }
      continue;
    }
    if (entry) flattened.push(entry as StructuredToolInterface);
  }
  return flattened;
}

/** Does this value look like a Zod schema rather than an already-JSON-schema-shaped object? */
function isZodSchema(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('_def' in (value as Record<string, unknown>) ||
      typeof (value as { safeParse?: unknown }).safeParse === 'function')
  );
}

/**
 * A tool's parameters as JSON Schema, or `undefined` when they cannot be expressed as one.
 *
 * A LangChain tool carries either a Zod schema or an already-JSON-schema-shaped object; Zod 4's
 * native converter turns the first into the second. The same two-shape handling the TUI's debug
 * render performs, for the same reason: an unusual schema must degrade to no declaration rather
 * than throw inside a render — or, here, inside a request.
 */
function toolParameters(schema: unknown): Record<string, unknown> | undefined {
  if (schema === undefined || schema === null) return undefined;
  try {
    if (isZodSchema(schema)) {
      return z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>;
    }
    return typeof schema === 'object' ? (schema as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The advertised-tool inventory the agent recorded at `init`, or `undefined` if it has none. */
function readAdvertisedTools(
  agent: GthAbstractAgent | undefined
): ReturnType<GthAbstractAgent['getAdvertisedTools']> {
  try {
    return agent?.getAdvertisedTools?.();
  } catch {
    return undefined;
  }
}

/**
 * The tools this server provides, as the protocol's `Tool` shape.
 *
 * **Which tools** comes from the agent's own advertised inventory — the list it recorded at `init`
 * from everything the resolvers loaded (built-in toolkits, MCP, A2A) *plus* `config.tools`, narrowed
 * by `allowedTools`. `config.tools` alone would be a strict subset of what the run path binds, so a
 * declaration built from it would quietly omit every MCP and built-in tool the agent can actually
 * call. The `allowedTools` narrowing is honoured for the mirror-image reason: a client must not be
 * offered a tool the allow-list will refuse.
 *
 * **What is known about each** comes from `config.tools`, the only place this surface holds real
 * tool objects; the inventory carries names and MCP attribution and no descriptions. A tool the
 * inventory names and the config does not is declared with an empty description rather than
 * dropped — its existence is the part a client acts on.
 *
 * **Client-fulfilled tools are excluded.** They are advertised to the model but answered by the
 * browser through `interrupt()`, so listing them as tools the agent provides would be the one
 * falsehood this list can tell; `tools.clientProvided` is what declares that pathway.
 *
 * When the agent has recorded no inventory at all (never initialised, or a backend that records
 * none), the flattened config tools are the fallback — the same list, minus what only the resolvers
 * know about.
 */
function resolveToolItems(config: GthConfig, agent: GthAbstractAgent | undefined): Tool[] {
  const configTools = flattenConfigTools(config);
  const clientFulfilled = new Set(
    configTools.filter((tool) => isClientFulfilledTool(tool)).map((tool) => tool?.name)
  );

  const described = new Map<string, StructuredToolInterface>();
  for (const tool of configTools) {
    if (typeof tool?.name === 'string' && !described.has(tool.name)) described.set(tool.name, tool);
  }

  const inventory = readAdvertisedTools(agent);
  const filteredOut = new Set((inventory?.filteredOut ?? []).map((entry) => entry.name));
  const names: { name: string; server?: string }[] = inventory
    ? inventory.tools.filter((entry) => !filteredOut.has(entry.name))
    : [...described.keys()].map((name) => ({ name }));

  const items: Tool[] = [];
  for (const entry of names) {
    if (!entry?.name || clientFulfilled.has(entry.name)) continue;
    const tool = described.get(entry.name);
    const parameters = toolParameters(tool?.schema);
    items.push({
      name: entry.name,
      description: typeof tool?.description === 'string' ? tool.description : '',
      ...(parameters ? { parameters } : {}),
      // The falsy branch is not only "no server": `approvalSubjectForToolName` hands an MCP tool
      // whose server it could not resolve the UNRESOLVED_MCP_SERVER sentinel, which is the EMPTY
      // STRING. That is an internal "this call is unattributable", not a name a client may be told,
      // so it must stay off the wire — keep this test truthy rather than `!== undefined`.
      ...(entry.server ? { metadata: { server: entry.server } } : {}),
    });
  }
  return items;
}

/**
 * Build the capability declaration for a running AG-UI server.
 *
 * `agent` is the server's own initialised agent — the one a run without client-declared tools is
 * served from — and is optional only so a caller mid-boot gets a declaration rather than a throw.
 *
 * **Nothing in here throws.** A client asking what a server can do and getting a 500 learns less
 * than one getting a declaration with a field missing, so every read that could fail degrades to
 * an omission.
 *
 * ## Why `humanInTheLoop` is absent, and why `state` is `false`
 *
 * These look inconsistent and are not, and the difference is the schema's absent-means-undeclared
 * rule doing real work.
 *
 * `state` is a **closed measurement**: this server emits no `STATE_SNAPSHOT` and no `STATE_DELTA`,
 * {@link AG_UI_EMITTED_EVENT_TYPES} says so, and a spec holds that set to the run path's emissions.
 * `false` is the answer, and it tells a client something absence would not — that the question was
 * asked.
 *
 * `humanInTheLoop` is **open**: this module wires no tool-approval callback ([[EXT-54]] measured
 * that), so a gated tool on this surface reaches a defined outcome only by not being gated. Neither
 * `true` nor `false` is honest about a pathway that is unfinished rather than declined, and of the
 * ten categories it is the one a client would act on most consequentially — `approvals: true`
 * written to make the block look complete would promise a human review that nothing performs.
 *
 * **So do not "complete" this object by adding the missing category.** EXT-54 fills it in when the
 * callback is wired, and the declaration is honest in the meantime precisely because it is silent.
 */
export function buildAgUiCapabilities(
  config: GthConfig,
  agent?: GthAbstractAgent
): AgentCapabilities {
  const manifest = readAgentManifest();
  const { provider: llmProvider, model } = describeConfiguredModel(config);
  const author = manifest ? manifestAuthor(manifest) : undefined;

  return {
    identity: {
      ...(manifest?.name ? { name: manifest.name } : {}),
      // The framework the graph is built with, which is what this field is for ("langgraph",
      // "mastra", "crewai"). Every backend here compiles a LangGraph graph, so it does not vary
      // with config the way the model underneath it does.
      type: 'langgraph',
      ...(manifest?.description ? { description: manifest.description } : {}),
      ...(manifest?.version ? { version: manifest.version } : {}),
      ...(author ? { provider: author } : {}),
      ...(manifest?.homepage ? { documentationUrl: manifest.homepage } : {}),
      // The sanctioned free-form slot, and where the model belongs: `identity.provider` above is
      // the organisation maintaining the agent, not the LLM vendor serving it. `command` is what a
      // consumer branches on to know which gaunt-sloth verb it is talking to.
      metadata: {
        command: AGUI_AGENT_COMMAND,
        llmProvider,
        model,
      },
    },
    // The run route streams: it takes its content type from the `EventEncoder` and writes each
    // event as it arrives. None of the other transports exist here — no websocket, no protobuf, no
    // webhook, and no sequence numbers to resume a broken stream from — so they stay undeclared.
    transport: { streaming: true },
    tools: {
      supported: emits(EventType.TOOL_CALL_START),
      items: resolveToolItems(config, agent),
      // Truthful whatever the config holds: the run route binds the run-input `tools` array as
      // `interrupt()` stubs, so a client can always declare its own and fulfil them itself.
      clientProvided: true,
    },
    state: {
      snapshots: emits(EventType.STATE_SNAPSHOT),
      deltas: emits(EventType.STATE_DELTA),
    },
    reasoning: {
      supported: emits(EventType.REASONING_MESSAGE_START),
      streaming: emits(EventType.REASONING_MESSAGE_CONTENT),
    },
  };
}
