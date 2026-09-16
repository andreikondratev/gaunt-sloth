import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * EXT-75 — **the release that adds a fifth MCP annotation hint must not discard what is on disk.**
 *
 * `TOOL_ANNOTATION_HINTS` belongs to the MCP specification, not to this project, so it can gain a
 * member. Every grant already saved was written under the smaller set, so on that release each one
 * is read with the new key simply absent. This file pins what happens then: the hint is filled at
 * its fail-closed default and the grant survives.
 *
 * **The whole file runs under a simulated fifth hint**, because a test written against today's four
 * would pass just as well against the code that drops those grants — it is the *future* set the fix
 * is about. The two module mocks below are what a real fifth hint would look like in source: the
 * vocabulary list grows, and the fail-closed constant grows with it. They are mocked together on
 * purpose; a state where only one of them knows the hint is one the type system rejects at build
 * (see the seam docblock in `grants.ts`), so pinning behaviour for it would pin fiction.
 *
 * Both persisted readers are covered here, because `readGrant` is the single reader for both: the
 * project settings file (`PersistedApprovalGrants`) and the resume document
 * (`decodeConversationGrants`). One reader accepting what the other rejects is the failure this
 * arrangement exists to prevent.
 */
const { FIFTH_HINT } = vi.hoisted(() => ({ FIFTH_HINT: 'sandboxedHint' }));

vi.mock('#src/config/shell-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/config/shell-policy.js')>();
  return {
    ...actual,
    TOOL_ANNOTATION_HINTS: [...actual.TOOL_ANNOTATION_HINTS, FIFTH_HINT],
  };
});

vi.mock('#src/core/approvals/matcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/core/approvals/matcher.js')>();
  return {
    ...actual,
    MCP_FAIL_CLOSED_ANNOTATIONS: Object.freeze({
      ...actual.MCP_FAIL_CLOSED_ANNOTATIONS,
      // A new hint arrives at whatever the MCP spec says an absent one means. `true` here stands
      // for "the conservative reading", which is what every fail-closed default is.
      [FIFTH_HINT]: true,
    }),
  };
});

/** The snapshot a grant saved under the FOUR-member set carries: no fifth key, by construction. */
const SNAPSHOT_WRITTEN_UNDER_FOUR_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const ENTRY = {
  type: 'mcpTool' as const,
  server: 'jira',
  matcher: 'exact' as const,
  pattern: 'search',
};

const SUBJECT = { kind: 'mcpTool' as const, server: 'jira', name: 'search' };

let file: string;

describe('EXT-75 — a grant saved under the four-hint set survives the fifth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const dir = mkdtempSync(join(tmpdir(), 'gth-ext75-'));
    mkdirSync(dir, { recursive: true });
    file = join(dir, 'approvals.json');
  });

  /**
   * The node's central clause: **still loads, still matches, and evaluates the new hint at its
   * fail-closed default.** The third assertion is the one that proves the widened set actually
   * reached the reader — load and match would both pass against an unwidened one.
   */
  it('loads it, matches with it, and reads the new hint at its fail-closed default', async () => {
    const { PersistedApprovalGrants } = await import('#src/core/approvals/grants.js');
    const { resolveApprovalRules } = await import('#src/core/approvals/matcher.js');
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        grants: [
          {
            entry: ENTRY,
            grantedAt: '2026-08-02T00:00:00.000Z',
            scope: 'always',
            annotations: SNAPSHOT_WRITTEN_UNDER_FOUR_HINTS,
          },
        ],
      }),
      'utf8'
    );

    const store = new PersistedApprovalGrants(file);
    expect(store.size()).toBe(1);
    expect(
      resolveApprovalRules(SUBJECT, { allow: store.entries(), deny: [], escalate: [] })?.action
    ).toBe('allow');

    const held = store.find(ENTRY)!.annotations as unknown as Record<string, boolean>;
    expect(held[FIFTH_HINT]).toBe(true);
    // …and the four it was actually saved with are untouched by the migration.
    expect(held).toMatchObject(SNAPSHOT_WRITTEN_UNDER_FOUR_HINTS);
  });

  /**
   * The resume document stores grants in the same shape and is read by the same `readGrant`, so a
   * migration that only reached the settings file would leave a resumed conversation losing exactly
   * the approvals a fresh run keeps.
   */
  it('restores it from the resume document too, with the new hint filled the same way', async () => {
    const { decodeConversationGrants } = await import('#src/core/approvals/conversationGrants.js');
    const restored = decodeConversationGrants(
      JSON.stringify({
        version: 1,
        allow: [
          {
            entry: ENTRY,
            grantedAt: '2026-08-02T00:00:00.000Z',
            scope: 'session',
            annotations: SNAPSHOT_WRITTEN_UNDER_FOUR_HINTS,
          },
        ],
        deny: [],
      })
    );

    expect(restored.allow).toHaveLength(1);
    const held = restored.allow[0].annotations as unknown as Record<string, boolean>;
    expect(held[FIFTH_HINT]).toBe(true);
    expect(held).toMatchObject(SNAPSHOT_WRITTEN_UNDER_FOUR_HINTS);
  });

  /**
   * The widened set does not soften the other arm: a hint that is PRESENT and not a boolean still
   * drops the whole grant, because that is the value which could feed a wrong comparison into the
   * weakening check.
   */
  it('still drops the grant when a hint is present but malformed', async () => {
    const { PersistedApprovalGrants } = await import('#src/core/approvals/grants.js');
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        grants: [
          {
            entry: ENTRY,
            grantedAt: '2026-08-02T00:00:00.000Z',
            scope: 'always',
            annotations: { ...SNAPSHOT_WRITTEN_UNDER_FOUR_HINTS, readOnlyHint: 'true' },
          },
        ],
      }),
      'utf8'
    );

    expect(new PersistedApprovalGrants(file).size()).toBe(0);
  });
});
