/**
 * GS2-88 PTY e2e config: the same scripted readline session as
 * `resume-recall.gsloth.config.mjs`, with local history recording switched OFF.
 *
 * It is the second half of a pair. The suite seeds a real store under a throwaway HOME with the
 * recording config, then opens a session with this one against that very store — so the only thing
 * that differs between the two sessions is `history.enabled`, and whatever `/history` says
 * differently is attributable to the switch rather than to whether a database file happened to be
 * there.
 */
import { configure as recallConfigure } from './resume-recall.gsloth.config.mjs';

export async function configure() {
  return { ...(await recallConfigure()), history: { enabled: false } };
}
