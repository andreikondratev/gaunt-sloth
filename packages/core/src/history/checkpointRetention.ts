/**
 * @packageDocumentation
 * GS2-107 — **the retention policy for the checkpoint tables, and the readout that makes their
 * size visible.**
 *
 * A checkpoint is not a history row. A `sessions` row is a prompt and a response; a checkpoint is
 * the state the agent was working with — tool results verbatim, file contents that were read,
 * command output, whatever an MCP server returned. `history.enabled` is on by default, so every
 * interactive session writes full graph state per super-step, and until this module nothing ever
 * reclaimed a byte.
 *
 * ## The policy, and why it is split in two
 *
 * **Automatic reclamation removes only what can never be resumed. Anything that would cost a user a
 * resume is available only as an explicit command they type.** That follows the ruling GS2-20 was
 * built to: resume sheds nothing, and shedding is the user's own act. An age-based sweep that
 * silently made an old conversation unresumable would remove, without being asked, the one
 * capability the durable checkpointer exists to provide.
 *
 * So:
 *
 * - {@link reclaimUnresumableThreads} is automatic and cannot cost a resume, because it only
 *   deletes threads **no conversation row names** — see the predicate below.
 * - {@link selectPrunableConversations} + {@link deleteThreads} is `gth history prune`: it removes
 *   state a user *could* still have resumed, so it is never automatic, never has a silent default
 *   bound, and says what it will remove before it removes it.
 * - {@link findWriteOnlyThreads} rides on `gth history prune` and on nothing else. It is the only
 *   pass that can reach a thread with pending writes and no checkpoint at all — rows no reader in
 *   this codebase can return, which is why they need a pass of their own.
 *
 * ## The predicate: one class, not two
 *
 * A resume travels exactly one link — `gth history list` prints a conversation id,
 * `conversations.thread_id` turns that id into a thread, and the thread is what
 * `resolveResumeTarget` looks up. So a thread that **no conversation row names** cannot be reached
 * by any id a person could type: it is unaddressable, and deleting it removes no capability anyone
 * had.
 *
 * That single predicate covers both classes of *addressable-by-a-person* state, because the second
 * collapses into the first at the row level:
 *
 * - a thread with **no conversation row at all** — a `/clear` mints a fresh thread that nothing ever
 *   names ([[EXT-109]]), and an abandoned boot or a test can leave one too;
 * - a conversation whose **`thread_id` is NULL** — written by `clearConversationThread` when a
 *   checkpoint write fails. NULLing the column *destroys the link*, so the thread it used to name is
 *   thereafter an orphan by exactly the definition above. There is no second query to write.
 *
 * ## The one class that predicate cannot see: a thread with writes and no checkpoint
 *
 * Both queries above read `FROM checkpoints`, so they ask a question about threads that *have* a
 * checkpoint. A thread with rows only in `checkpoint_writes` answers neither, and it is not a
 * hypothetical shape: `put` is fail-soft by contract — it catches, reports through
 * `onWriteFailure`, drops the checkpoint row and lets the turn continue — while `putWrites` is a
 * separate call that goes on landing. A thread whose first `put` was dropped therefore keeps its
 * pending writes with no checkpoint to attach them to, for good.
 *
 * Nothing can read those rows. `getTuple` and `list` both source `FROM checkpoints` and return
 * nothing for such a thread, and pending writes are only ever handed back attached to a checkpoint
 * tuple — so the rows are not merely unaddressable by an id a person could type, they are
 * unreachable by this codebase. {@link findWriteOnlyThreads} is the second predicate, and it exists
 * because the readout otherwise counts those bytes in {@link CheckpointStoreStats.checkpointBytes}
 * as ordinary stored weight while no pass in this module can reclaim them.
 *
 * ## Whole threads, never a prefix
 *
 * Pruning the middle of a thread is forbidden here even though it was **measured not to break this
 * graph**: `channelsFromCheckpoint` walks ancestors only for a `DeltaChannel` absent from
 * `channel_values`, and this state schema has none (`messages` is a `BinaryOperatorAggregate` and
 * every checkpoint carries the whole array), so `getDeltaChannelHistory` is never called on a
 * resume. A prefix policy is nevertheless a wider decision than retention makes, and it would become
 * wrong the moment a channel moves behind a reducer. Whole threads only.
 *
 * ## Two guards, and which one covers which case
 *
 * `/clear` rotates a **live** session onto a thread no conversation row names, and it stays there
 * for the rest of the session. So "unaddressable" does not imply "finished": a thread being written
 * right now can satisfy the predicate, and deleting it is silent amnesia rather than a lost resume,
 * because both interactive surfaces send only the new message and let checkpoint state carry the
 * conversation.
 *
 * - **In this process, the write set.** `GthSqliteSaver` remembers every `thread_id` it has written
 *   and excludes that set from every pass it runs. It is the only place that knows: the runner
 *   rotates threads without notifying the checkpointer, so an exclusion assembled by a caller from
 *   the id a session started with names the wrong thread after the first `/clear` or `/resume`.
 * - **Across processes, {@link RECLAIM_GRACE_MS}.** Another process cannot be asked whether it is
 *   still there, so nothing is reclaimed until its newest checkpoint is older than the window. A
 *   thread whose age cannot be established is left alone.
 *
 * The residual is a session in another process that has been idle longer than the window — the
 * write set does not reach it and the age gate no longer holds it. Closing that needs shared
 * cross-process session state, which retention does not add.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';

/**
 * How stale a thread's newest checkpoint must be before automatic reclamation will touch it.
 *
 * Not a tidy-up margin: after a `/clear` a live session writes every remaining checkpoint under a
 * thread no conversation row names, and another process cannot be asked whether it is still there.
 * A day is far longer than the gap between two super-steps of a session anyone is still using,
 * while still reclaiming the rows within a day of the session ending.
 */
export const RECLAIM_GRACE_MS = 24 * 60 * 60 * 1000;

/** How many threads the readout names individually. */
export const DEFAULT_TOP_THREADS = 5;

/** One thread's footprint in the checkpoint tables. */
export interface ThreadUsage {
  threadId: string;
  /** The conversation that names this thread, when one does — absent means unaddressable. */
  conversationId?: number;
  command?: string;
  checkpointCount: number;
  /** Bytes of checkpoint / metadata / pending-write blobs stored under the thread. */
  bytes: number;
  /** The `ts` of the newest checkpoint, when it could be read. */
  newestTs?: string;
}

/** What the checkpoint tables hold, for the readout. */
export interface CheckpointStoreStats {
  dbPath: string;
  /**
   * Size of the database file, which also holds `sessions` / `conversations` / the FTS index — so it
   * is reported beside {@link checkpointBytes} rather than instead of it. Zero when the file is
   * absent.
   */
  fileBytes: number;
  /** Bytes of checkpoint, metadata and pending-write blobs — the checkpoint tables' own share. */
  checkpointBytes: number;
  checkpointCount: number;
  writeCount: number;
  threadCount: number;
  /** The biggest threads by stored bytes, largest first. */
  largestThreads: ThreadUsage[];
  /** Threads no conversation row names, and what they cost — what reclamation will take. */
  unresumableThreadCount: number;
  unresumableBytes: number;
  /**
   * Threads holding pending writes and no checkpoint, and what they cost.
   *
   * Reported apart from {@link unresumableBytes} because the two differ in what they are waiting
   * for: an unresumable thread goes on its own a day after the session ends, and these go only
   * when someone types `gth history prune`. Counted inside {@link checkpointBytes}, which is the
   * whole point — without this pair those bytes sit in the total with nothing naming them, and the
   * per-thread breakdown beside them cannot account for the difference.
   */
  writeOnlyThreadCount: number;
  writeOnlyBytes: number;
}

/** What one {@link reclaimUnresumableThreads} / {@link deleteThreads} pass removed. */
export interface ReclaimSummary {
  threadCount: number;
  checkpointCount: number;
  writeCount: number;
  bytes: number;
}

/** A conversation `gth history prune` would remove the stored state of. */
export interface PrunableConversation {
  conversationId: number;
  threadId: string;
  command?: string;
  /** Last recorded activity: the newest turn's timestamp, or the conversation's start. */
  lastActivityTs: string;
  turnCount: number;
  checkpointCount: number;
  bytes: number;
  /**
   * True when the last recorded turn is newer than {@link RECLAIM_GRACE_MS} — so this conversation
   * may be **open in another window right now**, and pruning it would take a live session's memory
   * rather than an old one's.
   *
   * A flag and not an exclusion, deliberately. `gth history prune` is given an explicit bound by the
   * person typing it, and silently keeping back rows inside that bound would make the bound a lie;
   * liveness across processes is also not knowable from here, so a refusal would be a guess wearing
   * a guarantee. The automatic pass can be conservative because nobody asked for it. This one says
   * what it is about to do and lets the person answer.
   */
  recentlyActive: boolean;
}

/** Bounds for {@link selectPrunableConversations}. At least one is required by the command. */
export interface PruneBounds {
  /** Prune conversations whose last activity is older than this many days. */
  olderThanDays?: number;
  /**
   * Keep the N most recently active resumable conversations **whole** and prune the rest.
   *
   * Deliberately NOT "keep the last N super-steps of each thread": that is the prefix policy this
   * module forbids, and a flag whose name suggested it would be a documentation hazard.
   */
  keepLast?: number;
  /** Injectable clock for the age bound. */
  now?: number;
}

const EMPTY_RECLAIM: ReclaimSummary = {
  threadCount: 0,
  checkpointCount: 0,
  writeCount: 0,
  bytes: 0,
};

/** Whether a table exists in the open database. */
function hasTable(db: DatabaseSync, name: string): boolean {
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) as Record<string, unknown> | undefined;
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * True when both halves of the link this module reasons over are present. Without `conversations`
 * every thread would look unaddressable and a reclamation pass would delete the whole store — so a
 * database missing that table is left entirely alone rather than swept.
 */
export function retentionTablesReady(db: DatabaseSync): boolean {
  return hasTable(db, 'checkpoints') && hasTable(db, 'conversations');
}

/**
 * The `ts` a checkpoint recorded for itself, or `undefined` when it cannot be read.
 *
 * The saver stores the serializer's own bytes; the shipped `JsonPlusSerializer` writes plain JSON
 * with a top-level ISO `ts`, which every checkpoint LangGraph builds carries. Anything else — a row
 * from another serializer, a truncated blob — yields `undefined`, and the callers treat that as
 * "age unknown", which is the safe direction: an unknown age is never old enough to reclaim.
 */
function checkpointTs(blob: unknown): string | undefined {
  if (!(blob instanceof Uint8Array)) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(blob)) as Record<string, unknown>;
    return typeof parsed.ts === 'string' ? parsed.ts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How many thread ids go into one `IN (…)` list. SQLite caps the number of bound parameters in a
 * statement (999 on a default build), and a store with more unaddressable threads than that is
 * exactly the store this feature exists for — so the query is chunked rather than assumed small.
 */
const ID_CHUNK = 200;

/**
 * The predicate itself, as one constant.
 *
 * It asks `conversations` a question once per distinct thread in the store, so it is only cheap
 * while `conversations.thread_id` is indexed — `conversations.id` is a rowid alias and indexes
 * nothing else, which left this scanning the whole table per thread (measured: 3.18s at 6,000
 * threads, 13ms with `idx_conversations_thread_id`, created in `historyStore.migrate`). Named here
 * rather than inlined so the spec that asks SQLite for the query plan is looking at the same text
 * this runs, and cannot go on passing after the query is edited.
 */
export const UNADDRESSABLE_THREADS_SQL = `SELECT DISTINCT c.thread_id AS thread_id
     FROM checkpoints c
    WHERE NOT EXISTS (
            SELECT 1 FROM conversations v WHERE v.thread_id = c.thread_id
          )`;

/** Bytes stored under each of `threadIds`, as one grouped query per chunk. */
function bytesByThread(db: DatabaseSync, threadIds: string[]): Map<string, ReclaimSummary> {
  const out = new Map<string, ReclaimSummary>();
  if (threadIds.length === 0) return out;
  for (const id of threadIds) out.set(id, { ...EMPTY_RECLAIM, threadCount: 1 });
  for (let start = 0; start < threadIds.length; start += ID_CHUNK) {
    const chunk = threadIds.slice(start, start + ID_CHUNK);
    const holes = chunk.map(() => '?').join(', ');
    const checkpointRows = db
      .prepare(
        `SELECT thread_id,
                COUNT(*) AS n,
                COALESCE(SUM(LENGTH(checkpoint) + LENGTH(metadata)), 0) AS bytes
           FROM checkpoints
          WHERE thread_id IN (${holes})
          GROUP BY thread_id`
      )
      .all(...chunk) as Record<string, unknown>[];
    const writeRows = db
      .prepare(
        `SELECT thread_id, COUNT(*) AS n, COALESCE(SUM(LENGTH(value)), 0) AS bytes
           FROM checkpoint_writes
          WHERE thread_id IN (${holes})
          GROUP BY thread_id`
      )
      .all(...chunk) as Record<string, unknown>[];
    for (const r of checkpointRows) {
      const entry = out.get(String(r.thread_id));
      if (!entry) continue;
      entry.checkpointCount = Number(r.n ?? 0);
      entry.bytes += Number(r.bytes ?? 0);
    }
    for (const r of writeRows) {
      const entry = out.get(String(r.thread_id));
      if (!entry) continue;
      entry.writeCount = Number(r.n ?? 0);
      entry.bytes += Number(r.bytes ?? 0);
    }
  }
  return out;
}

/**
 * Every thread in the checkpoint tables that **no conversation row names** — see the module note for
 * why that one predicate covers both unresumable classes.
 *
 * `includeWithinGrace: true` answers "what is unaddressable", which is what the readout reports;
 * the default answers "what may be deleted now", which additionally requires the thread's newest
 * checkpoint to be older than {@link RECLAIM_GRACE_MS}. Never throws.
 */
export function findUnaddressableThreads(
  db: DatabaseSync,
  options: {
    now?: number;
    graceMs?: number;
    includeWithinGrace?: boolean;
    excludeThreadIds?: readonly string[];
  } = {}
): string[] {
  if (!retentionTablesReady(db)) return [];
  const graceMs = options.graceMs ?? RECLAIM_GRACE_MS;
  const now = options.now ?? Date.now();
  const excluded = new Set(options.excludeThreadIds ?? []);
  try {
    // The predicate itself, with no blobs in it: the readout asks this question over the whole
    // store, and dragging a checkpoint payload back for every thread would make a report cost what
    // a delete costs.
    const rows = db.prepare(UNADDRESSABLE_THREADS_SQL).all() as Record<string, unknown>[];
    const candidates = rows
      .map((row) => String(row.thread_id))
      .filter((threadId) => !excluded.has(threadId));
    if (options.includeWithinGrace) return candidates;

    // The age gate. Only the NEWEST checkpoint of each candidate is read — one row per thread, not
    // a scan of its history — because a thread is live if anything in it is recent. Checkpoint ids
    // are uuid6 and sort lexicographically in creation order, the same ordering `getTuple` uses for
    // "the latest checkpoint on this thread".
    const newest = db.prepare(
      `SELECT checkpoint FROM checkpoints
        WHERE thread_id = ?
        ORDER BY checkpoint_id DESC
        LIMIT 1`
    );
    const threads: string[] = [];
    for (const threadId of candidates) {
      const row = newest.get(threadId) as Record<string, unknown> | undefined;
      const ts = checkpointTs(row?.checkpoint);
      if (ts === undefined) continue; // age unknown ⇒ never old enough
      const age = now - Date.parse(ts);
      if (!Number.isFinite(age) || age < graceMs) continue;
      threads.push(threadId);
    }
    return threads;
  } catch {
    return [];
  }
}

/**
 * GS2-108 — the second predicate: a thread with rows in `checkpoint_writes` and none in
 * `checkpoints`. Named as one constant for the same reason the first one is.
 */
export const WRITE_ONLY_THREADS_SQL = `SELECT DISTINCT w.thread_id AS thread_id
     FROM checkpoint_writes w
    WHERE NOT EXISTS (
            SELECT 1 FROM checkpoints c WHERE c.thread_id = w.thread_id
          )`;

/**
 * Every thread holding pending writes with no checkpoint — see the module note for why the
 * conversation-link predicate cannot see one. Never throws.
 *
 * ## Reclaimed, not merely labelled — and what that rejected
 *
 * The alternative was to leave the rows where they are and only report them honestly: add the
 * count to the readout, call the bytes unreclaimable, stop. That is the smaller change and it was
 * rejected, because it ends with a screen telling a user about weight they have no way to remove —
 * `VACUUM` does not touch live rows, and no command in this codebase would have deleted them. It
 * would also have been sized against the wrong hazard: this state is not only a relic of a torn
 * delete from before {@link deleteThreads} became atomic, it is produced by the fail-soft `put`
 * path any time a checkpoint write is dropped and the task's writes are not. It keeps arriving, so
 * a label alone would keep accumulating.
 *
 * ## Why `gth history prune` and never the automatic pass
 *
 * This module reclaims automatically only what it can date: {@link findUnaddressableThreads} reads
 * a thread's newest checkpoint for its `ts` and treats an unreadable one as "age unknown, therefore
 * never old enough". A write-only thread has no checkpoint at all, so no age can be established for
 * it by that rule — which is the same rule, applied consistently, rather than a new exception.
 * `checkpoint_writes` carries no timestamp of its own to substitute, and inventing a stand-in
 * signal would be a guess wearing a guarantee.
 *
 * The explicit command is where it belongs anyway. `gth history prune` already takes a bound the
 * person typed, prints what it will remove, asks, and — as its own help text says — removes state
 * belonging to a conversation that may be open in another window right now. Sweeping rows that no
 * reader can return is strictly weaker than what the command already does with the person's
 * consent.
 *
 * The residual, stated rather than engineered around: another process can hold a thread that is
 * momentarily write-only, between the checkpoint write for a super-step and the writes of its
 * tasks (read from LangGraph's loop, where the checkpoint `put` is chained and `putWrites` is not —
 * so their order at the database is not guaranteed; not measured here). Taking those rows costs
 * that conversation a re-run of one super-step's tasks on a later resume, which is what
 * `durability: "exit"` does by design.
 *
 * Nothing here closes that window, and no reader should believe otherwise. `excludeThreadIds` does
 * not. It mirrors the option {@link findUnaddressableThreads} takes, which the saver makes real by
 * unioning its in-process `writtenThreads` into it — but this function has no such caller: its only
 * production call sites are the readout and `gth history prune`, and a prune process writes no
 * checkpoints of its own, so it holds no live thread to exclude. The parameter is here so an
 * in-process caller could supply that protection, not because one does. What keeps the window
 * narrow today is that a person runs the command deliberately and is shown what it will take.
 */
export function findWriteOnlyThreads(
  db: DatabaseSync,
  options: { excludeThreadIds?: readonly string[] } = {}
): string[] {
  // Both tables, not just the one queried: without `checkpoints` every write row would answer the
  // predicate and a sweep would take the whole table — the same failure {@link retentionTablesReady}
  // guards the conversation predicate against.
  if (!hasTable(db, 'checkpoints') || !hasTable(db, 'checkpoint_writes')) return [];
  const excluded = new Set(options.excludeThreadIds ?? []);
  try {
    const rows = db.prepare(WRITE_ONLY_THREADS_SQL).all() as Record<string, unknown>[];
    return rows
      .map((row) => String(row.thread_id))
      .filter((threadId) => threadId.length > 0 && !excluded.has(threadId));
  } catch {
    return [];
  }
}

/**
 * Delete every checkpoint and pending write of the named threads, and report what went.
 *
 * The single-thread spelling on the saver (`GthSqliteSaver.deleteThread`) routes through here, so
 * there is one implementation of the delete rather than two that can drift.
 *
 * **Both tables go in one transaction.** A thread's rows live in `checkpoints` and in
 * `checkpoint_writes`, and only the first of those is what a reader looks for: `getTuple` and
 * `list` both read `FROM checkpoints`, and so does every predicate here that asks about a
 * conversation. So a failure between the two statements leaves `checkpoint_writes` rows belonging
 * to a thread that no longer appears in `checkpoints` — bytes no reader can reach, that no
 * automatic pass will ever take back, and that the readout would otherwise count as ordinary stored
 * weight. Either both deletes land or neither does.
 *
 * {@link findWriteOnlyThreads} gives that state a remedy; it does not make it acceptable. The
 * remedy is a command someone has to type, on rows this module would rather never have written, so
 * the atomicity is what keeps a routine delete from manufacturing work for it.
 *
 * The caller must not already be inside a transaction: the rollback here would discard theirs. No
 * caller is — the two entry points are the close hook and `gth history prune`.
 */
export function deleteThreads(db: DatabaseSync, threadIds: readonly string[]): ReclaimSummary {
  const ids = [...new Set(threadIds)].filter((id) => id.length > 0);
  if (ids.length === 0) return { ...EMPTY_RECLAIM };
  try {
    const perThread = bytesByThread(db, ids);
    const summary: ReclaimSummary = { ...EMPTY_RECLAIM };
    const deleteCheckpoints = db.prepare(`DELETE FROM checkpoints WHERE thread_id = ?`);
    const deleteWrites = db.prepare(`DELETE FROM checkpoint_writes WHERE thread_id = ?`);
    db.exec('BEGIN');
    try {
      for (const id of ids) {
        deleteCheckpoints.run(id);
        deleteWrites.run(id);
        const counted = perThread.get(id);
        if (!counted) continue;
        summary.threadCount += 1;
        summary.checkpointCount += counted.checkpointCount;
        summary.writeCount += counted.writeCount;
        summary.bytes += counted.bytes;
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the connection may already have unwound the transaction; nothing left to undo */
      }
      throw error;
    }
    return summary;
  } catch {
    // Nothing was deleted, so nothing is reported as deleted — the summary the partial loop had
    // accumulated describes rows the rollback put back.
    return { ...EMPTY_RECLAIM };
  }
}

/**
 * The automatic half of the policy: delete every thread no conversation row names and whose newest
 * checkpoint is past the grace window. Never throws, and never touches a thread a resume could
 * reach.
 */
export function reclaimUnresumableThreads(
  db: DatabaseSync,
  options: { now?: number; graceMs?: number; excludeThreadIds?: readonly string[] } = {}
): ReclaimSummary {
  const threads = findUnaddressableThreads(db, options);
  if (threads.length === 0) return { ...EMPTY_RECLAIM };
  return deleteThreads(db, threads);
}

/**
 * The conversations `gth history prune` would remove the stored state of, newest activity first.
 *
 * A conversation qualifies when it still names a thread that has checkpoints (there is something to
 * remove) and it satisfies **every** bound given. `olderThanDays` and `keepLast` therefore compose
 * as a conjunction: with both, a conversation is pruned only when it is older than the age AND
 * outside the newest N. Passing neither selects nothing — the command requires an explicit bound,
 * so that there is no silent default for an operation that can cost a resume.
 *
 * **Neither of the automatic pass's two guards applies here, and that is the design.** The bounds
 * the person typed are the whole selection: a grace window layered on top would quietly shrink the
 * set they asked for, and the in-process write set is empty in a `gth history prune` process, which
 * shares no state with the session in the window next door. What this does instead is *say so* —
 * {@link PrunableConversation.recentlyActive} marks every candidate whose last turn is inside
 * {@link RECLAIM_GRACE_MS}, the plan prints that marker, and the command asks before removing
 * anything.
 */
export function selectPrunableConversations(
  db: DatabaseSync,
  bounds: PruneBounds
): PrunableConversation[] {
  if (!retentionTablesReady(db)) return [];
  if (bounds.olderThanDays === undefined && bounds.keepLast === undefined) return [];
  try {
    const rows = db
      .prepare(
        `SELECT c.id AS id, c.thread_id AS thread_id, c.command AS command,
                c.started_ts AS started_ts,
                COUNT(s.id) AS turn_count,
                MAX(s.ts) AS last_ts
           FROM conversations c
           LEFT JOIN sessions s ON s.conversation_id = c.id
          WHERE c.thread_id IS NOT NULL AND c.thread_id <> ''
          GROUP BY c.id`
      )
      .all() as Record<string, unknown>[];
    const candidates = rows.map((r) => ({
      conversationId: Number(r.id),
      threadId: String(r.thread_id),
      command: r.command != null ? String(r.command) : undefined,
      lastActivityTs: r.last_ts != null ? String(r.last_ts) : String(r.started_ts),
      turnCount: Number(r.turn_count ?? 0),
    }));
    // Newest activity first, so `keepLast` counts from the most recent conversation.
    candidates.sort((a, b) => b.lastActivityTs.localeCompare(a.lastActivityTs));

    const now = bounds.now ?? Date.now();
    const cutoff =
      bounds.olderThanDays === undefined
        ? undefined
        : now - bounds.olderThanDays * 24 * 60 * 60 * 1000;
    const selected = candidates.filter((candidate, index) => {
      if (bounds.keepLast !== undefined && index < bounds.keepLast) return false;
      if (cutoff !== undefined) {
        const at = Date.parse(candidate.lastActivityTs);
        // An unparseable timestamp is an unknown age, and an unknown age never satisfies an age
        // bound — the same safe direction the grace window takes.
        if (!Number.isFinite(at) || at >= cutoff) return false;
      }
      return true;
    });
    if (selected.length === 0) return [];

    const perThread = bytesByThread(
      db,
      selected.map((c) => c.threadId)
    );
    // Only a conversation with something actually stored is offered: naming one whose thread holds
    // no rows would report a removal that reclaims nothing.
    return selected
      .map((c) => {
        const counted = perThread.get(c.threadId) ?? EMPTY_RECLAIM;
        const at = Date.parse(c.lastActivityTs);
        return {
          ...c,
          checkpointCount: counted.checkpointCount,
          bytes: counted.bytes,
          // Same window the automatic pass uses, read off the turn row rather than the checkpoint
          // blob: the turn is written after the checkpoints of that turn, so it is the later of the
          // two and a conservative answer to "was something happening here recently".
          recentlyActive: Number.isFinite(at) && now - at < RECLAIM_GRACE_MS,
        };
      })
      .filter((c) => c.checkpointCount > 0);
  } catch {
    return [];
  }
}

/**
 * `VACUUM` — the part that actually gives the disk space back. Deleting rows in SQLite moves pages
 * onto the free list and leaves the file exactly as large as it was, so a prune that skipped this
 * would report bytes removed while the file a user can see never moved.
 *
 * Returns whether it ran. It cannot run inside a transaction, and it needs the file to itself; a
 * failure is reported rather than thrown, because the rows are already gone and the run should say
 * so.
 */
export function vacuumStore(db: DatabaseSync): boolean {
  try {
    db.exec('VACUUM');
    return true;
  } catch {
    return false;
  }
}

/**
 * The readout: what the checkpoint tables hold, and what of it is unaddressable.
 *
 * `fileBytes` and `checkpointBytes` are reported separately on purpose — the same file also holds
 * the session transcripts and the FTS index, so one number labelled "checkpoints" that is really the
 * whole file would be a false statement on the very screen this exists to make honest.
 */
export function collectCheckpointStoreStats(
  db: DatabaseSync,
  dbPath: string,
  topN = DEFAULT_TOP_THREADS
): CheckpointStoreStats {
  const empty: CheckpointStoreStats = {
    dbPath,
    fileBytes: 0,
    checkpointBytes: 0,
    checkpointCount: 0,
    writeCount: 0,
    threadCount: 0,
    largestThreads: [],
    unresumableThreadCount: 0,
    unresumableBytes: 0,
    writeOnlyThreadCount: 0,
    writeOnlyBytes: 0,
  };
  let fileBytes = 0;
  try {
    if (existsSync(dbPath)) fileBytes = statSync(dbPath).size;
  } catch {
    /* an unreadable file is reported as zero bytes rather than failing the readout */
  }
  if (!hasTable(db, 'checkpoints')) return { ...empty, fileBytes };
  try {
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS n,
                COUNT(DISTINCT thread_id) AS threads,
                COALESCE(SUM(LENGTH(checkpoint) + LENGTH(metadata)), 0) AS bytes
           FROM checkpoints`
      )
      .get() as Record<string, unknown>;
    const writes = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(value)), 0) AS bytes FROM checkpoint_writes`
      )
      .get() as Record<string, unknown>;

    // The per-thread roll-up carries the conversation that names each thread, so the readout can
    // say which of the biggest threads is a conversation someone could resume and which is dead
    // weight. A LEFT JOIN, because the unaddressable ones are exactly those with no match.
    const conversationsPresent = hasTable(db, 'conversations');
    const threadRows = db
      .prepare(
        conversationsPresent
          ? `SELECT t.thread_id AS thread_id, t.n AS n, t.bytes AS bytes,
                    v.id AS conversation_id, v.command AS command
               FROM (SELECT thread_id, COUNT(*) AS n,
                            COALESCE(SUM(LENGTH(checkpoint) + LENGTH(metadata)), 0) AS bytes
                       FROM checkpoints GROUP BY thread_id) t
               LEFT JOIN conversations v ON v.thread_id = t.thread_id
              ORDER BY t.bytes DESC, t.thread_id ASC
              LIMIT ?`
          : `SELECT thread_id, COUNT(*) AS n,
                    COALESCE(SUM(LENGTH(checkpoint) + LENGTH(metadata)), 0) AS bytes,
                    NULL AS conversation_id, NULL AS command
               FROM checkpoints
              GROUP BY thread_id
              ORDER BY bytes DESC, thread_id ASC
              LIMIT ?`
      )
      .all(Math.max(0, topN)) as Record<string, unknown>[];

    const unaddressable = findUnaddressableThreads(db, { includeWithinGrace: true });
    const unaddressableBytes = [...bytesByThread(db, unaddressable).values()].reduce(
      (sum, entry) => sum + entry.bytes,
      0
    );
    // GS2-108 — disjoint from the set above by construction: that one is sourced FROM checkpoints
    // and this one from threads that have no row there, so no thread is counted twice and the two
    // figures can be read side by side.
    const writeOnly = findWriteOnlyThreads(db);
    const writeOnlyBytes = [...bytesByThread(db, writeOnly).values()].reduce(
      (sum, entry) => sum + entry.bytes,
      0
    );

    return {
      dbPath,
      fileBytes,
      checkpointBytes: Number(totals.bytes ?? 0) + Number(writes.bytes ?? 0),
      checkpointCount: Number(totals.n ?? 0),
      writeCount: Number(writes.n ?? 0),
      threadCount: Number(totals.threads ?? 0),
      largestThreads: threadRows.map((r) => ({
        threadId: String(r.thread_id),
        conversationId: r.conversation_id != null ? Number(r.conversation_id) : undefined,
        command: r.command != null ? String(r.command) : undefined,
        checkpointCount: Number(r.n ?? 0),
        bytes: Number(r.bytes ?? 0),
      })),
      unresumableThreadCount: unaddressable.length,
      unresumableBytes: unaddressableBytes,
      writeOnlyThreadCount: writeOnly.length,
      writeOnlyBytes,
    };
  } catch {
    return { ...empty, fileBytes };
  }
}

/**
 * A read/write connection to the history file for the maintenance commands, or `null` when there is
 * nothing there. Fail-soft in the same shape as `openHistoryStore` / `openCheckpointSaver`, and it
 * never CREATES the file: `gth history prune` on a machine with no history should say there is none,
 * not leave an empty database behind.
 */
export class CheckpointMaintenance {
  private constructor(private readonly db: DatabaseSync) {}

  static open(dbPath: string): CheckpointMaintenance | null {
    if (dbPath !== ':memory:' && !existsSync(dbPath)) return null;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA busy_timeout = 5000');
      // A garbage file opens cleanly and only fails on the first statement, so the probe is what
      // decides whether this handle is usable at all.
      db.prepare(`SELECT name FROM sqlite_master LIMIT 1`).all();
      return new CheckpointMaintenance(db);
    } catch {
      try {
        db?.close();
      } catch {
        /* ignore: the connection may already be broken */
      }
      return null;
    }
  }

  stats(dbPath: string, topN = DEFAULT_TOP_THREADS): CheckpointStoreStats {
    return collectCheckpointStoreStats(this.db, dbPath, topN);
  }

  prunable(bounds: PruneBounds): PrunableConversation[] {
    return selectPrunableConversations(this.db, bounds);
  }

  unaddressable(options: { now?: number; graceMs?: number } = {}): string[] {
    return findUnaddressableThreads(this.db, options);
  }

  /** GS2-108 — threads holding pending writes and no checkpoint, which only a prune reclaims. */
  writeOnly(options: { excludeThreadIds?: readonly string[] } = {}): string[] {
    return findWriteOnlyThreads(this.db, options);
  }

  remove(threadIds: readonly string[]): ReclaimSummary {
    return deleteThreads(this.db, threadIds);
  }

  /** Bytes stored under exactly these threads — what removing them would reclaim. */
  bytesOf(threadIds: readonly string[]): number {
    try {
      return [...bytesByThread(this.db, [...new Set(threadIds)]).values()].reduce(
        (sum, entry) => sum + entry.bytes,
        0
      );
    } catch {
      return 0;
    }
  }

  vacuum(): boolean {
    return vacuumStore(this.db);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

/** Fail-soft opener for {@link CheckpointMaintenance}; `null` when there is no store to maintain. */
export function openCheckpointMaintenance(dbPath: string): CheckpointMaintenance | null {
  return CheckpointMaintenance.open(dbPath);
}
