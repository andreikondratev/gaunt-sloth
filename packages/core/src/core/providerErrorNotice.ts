/**
 * @packageDocumentation
 * [[EXT-92]] scope (b) — **a provider error is a sentence, not a serialized object.**
 *
 * ## This is a rendering problem, and the measurement says so
 *
 * The line the reporter of gaunt-sloth #433 actually read was, in full:
 *
 * ```text
 * Provider returned error | metadata: {"raw":"google/gemini-3.6-flash is temporarily rate-limited
 * upstream. Please retry shortly, or add your own key …","provider_name":"Google",
 * "provider_error_code":"429","limit_source":"upstream_provider_shared_pool","remedy_hint":"Retry
 * shortly, add your own provider key …, or route to another provider …","previous_errors":[…]}
 * ```
 *
 * Everything that person needed was in that string — that it was a rate limit, that it was the
 * shared upstream pool rather than their own quota, and three remedies the provider itself wrote
 * for them. What they reported was *"error 429"*, because that is what it looked like.
 *
 * **Nothing was lost before it reached the screen.** The ` | metadata: ` join is produced
 * *upstream*, by `@langchain/openrouter`'s `OpenRouterError.fromResponse`, which flattens the
 * metadata into `message` **and keeps it as structured data on the same error object** — it throws
 * `new OpenRouterRateLimitError(message, response.status, code, error?.metadata, headers)`. Our
 * runtime rethrows that error unchanged (`GthAgentRunner`'s classify-and-rethrow sites say so in
 * terms), so at the point a surface renders it, `error.metadata` is still an object with every
 * field above on it. The only thing that ever happened to it is that a renderer read `.message`.
 *
 * So this module does not detect anything, parse anything out of a string, or ask the provider a
 * second question. It reads fields that are already there and writes them as prose.
 *
 * ## The raw payload is moved out of the user's line, never deleted
 *
 * The node's constraint is explicit: the raw payload stays reachable in `/debug-dump`. That archive
 * captures the transcript items themselves, so {@link providerErrorRawPayload} returns the original
 * text for a surface to carry on the item **beside** the rendered prose, in a field the renderer
 * does not print. The user's line loses the blob; the dump keeps it; nobody has to choose.
 *
 * ## Everything the provider wrote is untrusted text
 *
 * `raw` and `remedy_hint` are strings an upstream service chose, reaching a terminal that draws
 * chrome. They are capped and defanged exactly as [[EXT-178]]'s recap treats model-written prose —
 * same helpers, same reason — so a provider cannot spend this surface to forge a fence, a notice
 * header, or a screen's worth of scrollback. **No request body, API key or rated command is read
 * here at all:** every field this module touches comes from a *response* payload, and the fields
 * are named individually rather than spread, so a future upstream addition cannot arrive on screen
 * without someone adding it here on purpose.
 */

import { capUntrustedText, defangUntrustedDelimiters } from '#src/utils/untrustedText.js';

/**
 * The separator `@langchain/openrouter` uses to append the serialized metadata to its message.
 *
 * Exported because two different things key on it — the strip below and the specs that prove the
 * strip — and because naming it is the honest way to record that this module is coupled to an
 * upstream formatting choice. {@link stripSerializedMetadata} is written so that a change to that
 * choice degrades to "the message is printed whole", which is today's behaviour, rather than to a
 * mangled line.
 */
export const PROVIDER_ERROR_METADATA_SEPARATOR = ' | metadata: ';

/** Characters of any one provider-written field rendered to the terminal. */
export const PROVIDER_ERROR_FIELD_MAX_CHARS = 600;

/** Appended when the cap above actually clipped something. */
export const PROVIDER_ERROR_TRUNCATION_MARKER = '… [truncated]';

/**
 * The fields this module recognises on a provider error, normalised out of the upstream snake_case.
 *
 * Every member is optional because every member is optional upstream: OpenRouter populates
 * `metadata` differently per failure mode, and a shape test that required any one of them would
 * silently stop recognising the payload the first time a provider omitted it.
 */
export interface GthProviderErrorPayload {
  /** The provider's own human-readable sentence about what happened (`metadata.raw`). */
  providerText?: string;
  /** The provider's own suggested remedy (`metadata.remedy_hint`). */
  remedyHint?: string;
  /** Which upstream provider refused (`metadata.provider_name`). */
  providerName?: string;
  /** The provider's own code for the condition (`metadata.provider_error_code`). */
  providerErrorCode?: string;
  /** Whose quota was exhausted — e.g. a shared upstream pool (`metadata.limit_source`). */
  limitSource?: string;
  /** The HTTP status the client recorded, when it carried one. */
  statusCode?: number;
}

/** A string field, or `undefined` when the value is absent or not a non-empty string. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** `record.key` when `record` is an object, without asserting a shape onto an unknown. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The structured payload carried by `error`, or `null` when it carries none.
 *
 * **One `cause` hop is walked**, matching what `terminationReason.ts`'s own probes do and for the
 * same measured reason: LangGraph and LangChain sometimes re-wrap a provider throw, and a probe
 * that only ever looked at the top level would report "no payload" for exactly the wrapped cases.
 * It is one hop rather than a full walk because an unbounded walk over an error chain is a way to
 * pick up a field that belongs to something else entirely.
 *
 * Duck-typed on the shape rather than on `OpenRouterError.isInstance`. The class predicate would be
 * exact, but it would also make this module refuse to render an identically-shaped payload from any
 * other provider, and would import a provider package into a module that is about presentation.
 */
export function readProviderErrorPayload(error: unknown): GthProviderErrorPayload | null {
  for (const candidate of [error, field(error, 'cause')]) {
    const metadata = field(candidate, 'metadata');
    const statusCode = field(candidate, 'statusCode');
    const payload: GthProviderErrorPayload = {
      providerText: text(field(metadata, 'raw')),
      remedyHint: text(field(metadata, 'remedy_hint')),
      providerName: text(field(metadata, 'provider_name')),
      providerErrorCode: text(field(metadata, 'provider_error_code')),
      limitSource: text(field(metadata, 'limit_source')),
      ...(typeof statusCode === 'number' ? { statusCode } : {}),
    };
    // Drop the keys that came back undefined so a caller can test the value by its own keys.
    for (const key of Object.keys(payload) as (keyof GthProviderErrorPayload)[]) {
      if (payload[key] === undefined) delete payload[key];
    }
    if (Object.keys(payload).length > 0) return payload;
  }
  return null;
}

/**
 * `message` with any upstream-appended serialized metadata removed.
 *
 * Deliberately conservative: it cuts only at {@link PROVIDER_ERROR_METADATA_SEPARATOR}, only when
 * what follows opens a JSON object, and it keeps everything before the cut. So the *worst* outcome
 * of upstream changing its formatting is that the message is printed exactly as it is printed
 * today, which is the behaviour this is replacing — never a half-cut sentence.
 */
export function stripSerializedMetadata(message: string): string {
  const at = message.indexOf(PROVIDER_ERROR_METADATA_SEPARATOR);
  if (at === -1) return message;
  const tail = message.slice(at + PROVIDER_ERROR_METADATA_SEPARATOR.length).trimStart();
  if (!tail.startsWith('{')) return message;
  return message.slice(0, at).trimEnd();
}

/** One provider-written string, capped and defanged for a terminal. */
function quoted(value: string): string {
  return capUntrustedText(
    defangUntrustedDelimiters(value),
    PROVIDER_ERROR_FIELD_MAX_CHARS,
    PROVIDER_ERROR_TRUNCATION_MARKER
  );
}

/**
 * The prose lines for a provider error, in the order a reader needs them.
 *
 * The provider's own sentence comes **first** and its remedy second, because those are the two
 * halves that were present and unread in the reporter's session; the attribution line is last
 * because "which pool refused" only matters once you know what happened. `headline` is the error's
 * own message with the blob taken off, and is included only when it says something the provider's
 * own text does not — a bare `Provider returned error` above a sentence that explains the error is
 * the noise this module exists to remove.
 */
export function providerErrorLines(
  headline: string,
  payload: GthProviderErrorPayload | null
): string[] {
  const lines: string[] = [];
  if (payload?.providerText) lines.push(quoted(payload.providerText));
  if (payload?.remedyHint) lines.push(`Suggested remedy: ${quoted(payload.remedyHint)}`);

  const attribution: string[] = [];
  if (payload?.providerName) attribution.push(`provider ${quoted(payload.providerName)}`);
  if (payload?.providerErrorCode) attribution.push(`code ${quoted(payload.providerErrorCode)}`);
  else if (typeof payload?.statusCode === 'number') attribution.push(`code ${payload.statusCode}`);
  if (payload?.limitSource) attribution.push(`limit source ${quoted(payload.limitSource)}`);
  if (attribution.length > 0) lines.push(`Reported by ${attribution.join(', ')}.`);

  // The headline leads when nothing else did; otherwise it is only worth a line of its own if it
  // carries wording the provider's sentence does not already give the reader.
  const trimmed = headline.trim();
  if (trimmed !== '' && (lines.length === 0 || !payload?.providerText)) lines.unshift(trimmed);
  return lines;
}

/**
 * The whole user-facing rendering of a thrown provider error: prose, and no serialized object.
 *
 * Returns `null` when there is nothing to improve on — no structured payload **and** no blob to
 * strip — so a caller can keep its existing rendering for the ordinary runtime errors this module
 * has nothing to say about, rather than routing every failure through a provider-shaped renderer.
 */
export function providerErrorNotice(
  error: unknown
): { text: string; raw: string; payload: GthProviderErrorPayload | null } | null {
  const raw = error instanceof Error ? error.message : String(error);
  const payload = readProviderErrorPayload(error);
  const headline = stripSerializedMetadata(raw);
  if (payload === null && headline === raw) return null;
  const lines = providerErrorLines(headline, payload);
  if (lines.length === 0) return null;
  return { text: lines.join('\n'), raw, payload };
}

/**
 * The original, unrendered error text — what `/debug-dump` must still be able to show.
 *
 * A separate accessor rather than a field a surface happens to keep, so the archive's claim on the
 * raw payload is something a spec can assert on directly.
 */
export function providerErrorRawPayload(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
