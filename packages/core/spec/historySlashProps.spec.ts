import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildHistorySlashProps } from '#src/history/historySlashProps.js';
import { openHistoryStore } from '#src/history/historyStore.js';

/**
 * GS2-88 — the one builder behind `/history` `/insights` `/search`, which every interactive
 * surface shares.
 *
 * **The cells here are about the REASON, not the rows.** The defect this replaces decided purely
 * on whether the DB file opened, which cannot tell "the user switched history off" from "the user
 * switched it on and has recorded nothing yet" — both produce no store — so it named the config in
 * both cases and was wrong in one of them. Reading the config FIRST is what makes the difference a
 * fact, and the `disabled`/`empty` pair below is what would red if that ordering were undone.
 *
 * Every cell passes an explicit `dbPath` under a temp dir. With none, `resolveHistoryDbPath`
 * resolves the developer's real `~/.gsloth/history.db`, which a spec must never read or write.
 */
describe('history/historySlashProps — buildHistorySlashProps (GS2-88)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-history-props-'));
    dbPath = resolve(dir, 'history.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** One real recorded turn, so `available` has something to be available. */
  const seedOneTurn = (): void => {
    const store = openHistoryStore(dbPath, { create: true })!;
    expect(store).not.toBeNull();
    store.record({
      command: 'chat',
      model: 'gpt-5',
      prompt: 'how do I refactor the widget factory',
      response: 'extract a builder',
    });
    store.close();
  };

  it('reports `disabled` from the CONFIG, without consulting the store at all', () => {
    // The store exists AND holds a row. A builder that decided on the file would report the rows;
    // this one reports what the user actually asked for. That is the half of the pair a
    // file-first implementation gets wrong in the other direction.
    seedOneTurn();
    const props = buildHistorySlashProps({ history: { enabled: false, dbPath } });
    expect(props.historyAvailability).toBe('disabled');
    expect(props.historySummary).toBeUndefined();
    expect(props.insightsSummary).toBeUndefined();
    expect(props.historySearch).toBeUndefined();
  });

  it('reports `empty` when history is ON and no store has been written yet', () => {
    const props = buildHistorySlashProps({ history: { dbPath } });
    // Absent `enabled` is ON — the default run — and the reason is "nothing recorded", which is
    // NOT the config. This is the cell the old builder failed: no file, so it blamed the config.
    expect(props.historyAvailability).toBe('empty');
    expect(props.historySummary).toBeUndefined();
  });

  it('reports `available` with the summaries and a working search provider', () => {
    seedOneTurn();
    const props = buildHistorySlashProps({ history: { enabled: true, dbPath } });
    expect(props.historyAvailability).toBe('available');
    expect(props.historySummary?.join('\n')).toContain('widget factory');
    expect(props.insightsSummary?.join('\n')).toContain('Sessions: 1');
    expect(props.historySearch?.('widget').join('\n')).toContain('widget');
    // A term that matches nothing still answers, rather than throwing.
    expect(props.historySearch?.('zzzznotathing')).toEqual(['No matching sessions found.']);
  });

  it('reports `unreadable` when the file IS there and will not open as a store', () => {
    writeFileSync(dbPath, 'this is not a sqlite database');
    const props = buildHistorySlashProps({ history: { dbPath } });
    expect(props.historyAvailability).toBe('unreadable');
    expect(props.historySummary).toBeUndefined();
  });

  it('treats an absent history block as ON, like every other reader of the switch', () => {
    // No `history` key at all is the commonest resolved config, and it must not read as "off" —
    // that would put the config sentence in front of a user who never touched it.
    //
    // With no `dbPath` the builder resolves the GLOBAL store, so the home directory is clamped to
    // this test's temp dir for the duration. Both variables, because `os.homedir()` reads `$HOME`
    // on POSIX and `%USERPROFILE%` on win32 and this suite runs on both — clamping one would leave
    // the Windows cell reading the developer's real `~/.gsloth/history.db`.
    const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    try {
      expect(buildHistorySlashProps({}).historyAvailability).not.toBe('disabled');
      expect(buildHistorySlashProps(undefined).historyAvailability).not.toBe('disabled');
    } finally {
      // Assigning back an `undefined` would set the literal string "undefined", which is a path.
      for (const [name, value] of Object.entries(home)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('never throws, whatever the store does', () => {
    // A directory where a database file should be: `open` throws rather than returning null.
    expect(() => buildHistorySlashProps({ history: { dbPath: dir } })).not.toThrow();
    expect(buildHistorySlashProps({ history: { dbPath: dir } }).historySummary).toBeUndefined();
  });
});
