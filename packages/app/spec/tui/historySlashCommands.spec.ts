import { describe, expect, it } from 'vitest';
import {
  createCommandRegistry,
  dispatchSlashCommand,
  filterSlashCommands,
  formatHelp,
  parseSlashCommand,
  type SlashCommandContext,
} from '@gaunt-sloth/agent/modules/slashCommands.js';

/**
 * GS2-7 (B20) — the `/history` `/search` `/insights` slash commands live in the pure registry, so
 * they auto-appear in `/help` and the TUI-C10 `/` menu, and each renders a notice from the
 * surface's fail-soft, pre-built context (mirroring `/config`). Tested purely — no DB, no React.
 *
 * GS2-88 — and when there is nothing to show, the notice explains itself from
 * `historyAvailability`, which the surface established, rather than from a guess. The cells below
 * hold the four reasons apart and hold the no-wiring default apart from all of them, because the
 * defect being fixed was one body of copy serving every case and naming the config in all of them.
 */
const baseCtx: SlashCommandContext = {
  mode: 'chat',
  modelDisplayName: 'gpt-5',
  turnCount: 0,
  toolsExpanded: false,
  debugVisible: false,
};

const run = (input: string, ctx: SlashCommandContext) => {
  const parsed = parseSlashCommand(input)!;
  return dispatchSlashCommand(parsed, createCommandRegistry(), ctx);
};

/** The body of whatever notice a command produced, as one string. */
const body = (input: string, ctx: SlashCommandContext): string =>
  (run(input, ctx).notice?.lines ?? []).join('\n');

/** The three commands that share one availability field, and an input that reaches the fallback. */
const HISTORY_COMMANDS = ['/history', '/insights', '/search widget'] as const;

describe('tui/slashCommands — history/search/insights (GS2-7)', () => {
  it('registers the three commands so they surface in /help and the menu', () => {
    const registry = createCommandRegistry();
    const names = registry.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['history', 'search', 'insights']));
    // /config (GS2-1) is still present and undisturbed.
    expect(names).toContain('config');

    const help = formatHelp(registry);
    expect(help.lines.some((l) => l.startsWith('/history'))).toBe(true);
    expect(help.lines.some((l) => l.startsWith('/search'))).toBe(true);
    expect(help.lines.some((l) => l.startsWith('/insights'))).toBe(true);

    // The `/` menu prefix filter finds them.
    expect(filterSlashCommands(registry, 'his').map((c) => c.name)).toContain('history');
    expect(filterSlashCommands(registry, 'ins').map((c) => c.name)).toContain('insights');
  });

  describe('/history', () => {
    it('renders the pre-built recent-session summary', () => {
      const result = run('/history', {
        ...baseCtx,
        historyAvailability: 'available',
        historySummary: ['#2  ts  [chat]', '  hello'],
      });
      expect(result.notice?.title).toBe('Recent sessions');
      expect(result.notice?.lines).toEqual(['#2  ts  [chat]', '  hello']);
    });
    it('names the config ONLY when the config is what switched history off', () => {
      expect(body('/history', { ...baseCtx, historyAvailability: 'disabled' })).toContain(
        'history.enabled'
      );
    });
  });

  describe('/insights', () => {
    it('renders the pre-built insights summary', () => {
      const result = run('/insights', {
        ...baseCtx,
        historyAvailability: 'available',
        insightsSummary: ['Sessions: 5'],
      });
      expect(result.notice?.title).toContain('Session insights');
      expect(result.notice?.lines).toEqual(['Sessions: 5']);
    });
    it('names the config ONLY when the config is what switched history off', () => {
      expect(body('/insights', { ...baseCtx, historyAvailability: 'disabled' })).toContain(
        'history.enabled'
      );
    });
  });

  describe('/search', () => {
    it('shows usage when called with no query', () => {
      const result = run('/search', { ...baseCtx, historySearch: () => ['should not be called'] });
      expect(result.notice?.lines.join(' ')).toContain('Usage: /search');
    });
    it('runs the injected search provider and renders its result lines', () => {
      const calls: string[] = [];
      const provider = (q: string) => {
        calls.push(q);
        return ['#1  ts  [ask]', '  matched line'];
      };
      const result = run('/search widget factory', {
        ...baseCtx,
        historyAvailability: 'available',
        historySearch: provider,
      });
      expect(calls).toEqual(['widget factory']);
      expect(result.notice?.title).toContain('widget factory');
      expect(result.notice?.lines).toEqual(['#1  ts  [ask]', '  matched line']);
    });
    it('names the config ONLY when the config is what switched history off', () => {
      expect(body('/search anything', { ...baseCtx, historyAvailability: 'disabled' })).toContain(
        'history.enabled'
      );
    });
  });

  /**
   * GS2-88 — **the floor: no message may name a cause it has not checked.**
   *
   * These cells are the reason the availability field exists. Before it, every one of these
   * situations rendered the same body, and that body said the config had switched history off —
   * so a user with history on and a surface that never wired it was sent to change a setting that
   * was never the problem, and the readline session sent EVERY user there.
   */
  describe('the reason a command has nothing to show (GS2-88)', () => {
    it.each(HISTORY_COMMANDS)(
      '%s: a surface that wired nothing says so, and blames neither the config nor the store',
      (command) => {
        const lines = body(command, baseCtx);
        expect(lines).toContain('does not provide local session history');
        // The two causes this surface has established nothing about.
        expect(lines).not.toContain('history.enabled');
        expect(lines.toLowerCase()).not.toContain('recorded yet');
      }
    );

    it.each(HISTORY_COMMANDS)('%s: history on and empty is not a config problem', (command) => {
      const lines = body(command, { ...baseCtx, historyAvailability: 'empty' });
      expect(lines).toContain('is on');
      expect(lines).not.toContain('history.enabled');
    });

    it.each(HISTORY_COMMANDS)(
      '%s: an unreadable store says so, and exonerates the config',
      (command) => {
        const lines = body(command, { ...baseCtx, historyAvailability: 'unreadable' });
        expect(lines).toContain('could not be read');
        expect(lines).toContain('config is not the problem');
        expect(lines).not.toContain('history.enabled');
      }
    );

    it.each(HISTORY_COMMANDS)(
      '%s: all four reasons produce four DIFFERENT bodies, so none can stand in for another',
      (command) => {
        const bodies = (['disabled', 'empty', 'unreadable'] as const)
          .map((historyAvailability) => body(command, { ...baseCtx, historyAvailability }))
          .concat(body(command, baseCtx));
        expect(new Set(bodies).size).toBe(bodies.length);
      }
    );
  });
});
