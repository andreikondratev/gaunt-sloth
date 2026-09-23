/**
 * BATCH-49 — the read-site default for `toolResultCaptureMaxBytes`.
 *
 * The default lives here, not in `DEFAULT_CONFIG`, for the same reason `injectModelContext` and
 * `output.header` default where they are read: a default written into `DEFAULT_CONFIG` appears in
 * the effective-config snapshot `gth config print` renders, so every config that never set the key
 * would grow one. Absence must keep meaning "nobody set this".
 *
 * The number itself is not restated. {@link TOOL_RESULT_CONTENT_CAP} is the single source; this
 * module only decides *when* it applies.
 *
 * @module
 */
import { TOOL_RESULT_CONTENT_CAP } from '#src/core/runStats.js';

/**
 * The capture cap in force for one run, in UTF-8 bytes.
 *
 * A set `toolResultCaptureMaxBytes` is what both capture sites apply; an absent one resolves to
 * {@link TOOL_RESULT_CONTENT_CAP}. The schema has already rejected `0`, negatives and
 * non-integers, so a present value is a positive integer by the time it is read — this function
 * does not re-validate, and it does not treat `0` as "unlimited".
 */
export function resolveToolResultCaptureMaxBytes(config?: {
  toolResultCaptureMaxBytes?: number;
}): number {
  return config?.toolResultCaptureMaxBytes ?? TOOL_RESULT_CONTENT_CAP;
}
