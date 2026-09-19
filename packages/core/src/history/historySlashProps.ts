/**
 * @packageDocumentation
 * GS2-88 — the ONE builder behind `/history`, `/insights` and `/search`, shared by every
 * interactive surface.
 *
 * The local history store is a SQLite file and a set of pure formatters: nothing about these three
 * commands needs a renderer, so nothing about them may differ between the Ink TUI and the plain
 * readline (`--no-tui`) session. Both call this, so a surface cannot quietly serve a subset.
 *
 * **It reports WHY there is nothing to show, and the reason is checked rather than guessed.**
 * The commands' copy is built from {@link HistoryAvailability}, and the only state that may offer
 * the `history.enabled` config fix is the one where the config is actually what switched history
 * off. Everything else says what was found instead.
 */
import { existsSync } from 'node:fs';

import {
  formatConversationList,
  formatInsightsSummary,
  formatSearchResults,
} from '#src/history/historyFormat.js';
import { isHistoryEnabled, type HistoryConfigView } from '#src/history/historyEnabled.js';
import { openHistoryStore, resolveHistoryDbPath } from '#src/history/historyStore.js';

/**
 * Why the history commands have what they have, established by looking rather than inferred from
 * an absent summary.
 *
 * The ABSENCE of this field is itself a fifth reading — "the surface passed nothing at all" — and
 * the commands render that as *this surface does not provide it*. Absent is the safe direction
 * for the same reason the slash-command context's `hasSlashMenu` chose it: a surface that says
 * nothing is never made to claim a state it never checked.
 */
export type HistoryAvailability =
  /**
   * `history.enabled: false` in the resolved config. **The one state that may name the config**,
   * because it is the one where the config is the answer.
   */
  | 'disabled'
  /** History is on and no store file exists yet — a first session, or the store was deleted. */
  | 'empty'
  /** History is on and a store file IS there, and it could not be opened or read. */
  | 'unreadable'
  /** History is on and the store was read: the summaries below are what it holds. */
  | 'available';

/** The `/history` `/insights` `/search` inputs one surface hands the shared command registry. */
export interface HistorySlashProps {
  /** Why these three commands have what they have. Always set by this builder. */
  historyAvailability: HistoryAvailability;
  /** Pre-rendered recent-conversation lines; present only when `historyAvailability` is `available`. */
  historySummary?: string[];
  /** Pre-rendered analytics lines; present only when `historyAvailability` is `available`. */
  insightsSummary?: string[];
  /** Fail-soft search provider; present only when `historyAvailability` is `available`. */
  historySearch?: (query: string) => string[];
}

/**
 * Build the read-only history slash-command props from the resolved config, fail-soft.
 *
 * **The config is consulted FIRST, and that ordering is the whole point.** Whether the DB file
 * opens cannot distinguish "the user turned history off" from "the user turned it on and has not
 * recorded anything yet" — both produce no store — so a builder that only tried to open the file
 * had to guess, and guessed the config every time. Reading `isHistoryEnabled` before touching the
 * disk makes the difference a fact.
 *
 * Never throws: a store problem must not affect starting or running a session.
 */
export function buildHistorySlashProps(config: HistoryConfigView | undefined): HistorySlashProps {
  if (!isHistoryEnabled(config)) return { historyAvailability: 'disabled' };
  try {
    const dbPath = resolveHistoryDbPath(config?.history?.dbPath);
    const store = openHistoryStore(dbPath, { create: false });
    // `openHistoryStore` returns null both for "no file yet" and "the file would not open", and
    // those are different things to tell a user. `existsSync` is the cheap check that separates
    // them, and it is a check rather than an assumption.
    if (!store) return { historyAvailability: existsSync(dbPath) ? 'unreadable' : 'empty' };
    try {
      const historySummary = formatConversationList(store.listConversations(20));
      const insightsSummary = formatInsightsSummary(store.insights());
      // Search runs later (at dispatch), so it re-opens read-only per call rather than holding a
      // connection open for the session; still fully fail-soft.
      const historySearch = (query: string): string[] => {
        try {
          const s = openHistoryStore(dbPath, { create: false });
          if (!s) return formatSearchResults([]);
          try {
            return formatSearchResults(s.search(query, 20));
          } finally {
            s.close();
          }
        } catch {
          return formatSearchResults([]);
        }
      };
      return { historyAvailability: 'available', historySummary, insightsSummary, historySearch };
    } finally {
      store.close();
    }
  } catch {
    return { historyAvailability: 'unreadable' };
  }
}
