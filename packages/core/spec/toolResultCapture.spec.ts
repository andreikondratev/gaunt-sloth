import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '#src/config/defaults.js';
import { resolveConfig } from '#src/config/loader.js';
import { resolveToolResultCaptureMaxBytes } from '#src/config/toolResultCapture.js';
import { TOOL_RESULT_CONTENT_CAP } from '#src/core/runStats.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * BATCH-49 — the capture cap's default lives at the read site, and nowhere else.
 *
 * A default in `DEFAULT_CONFIG` would surface in the effective-config snapshot `gth config print`
 * renders, so every config that never set the key would grow one. These cells hold that: the
 * resolver supplies the constant when the key is absent, and the constant is the only place the
 * capture code states the number.
 */
describe('toolResultCaptureMaxBytes read-site default (BATCH-49)', () => {
  it('resolves an absent key to TOOL_RESULT_CONTENT_CAP', () => {
    expect(resolveToolResultCaptureMaxBytes(undefined)).toBe(TOOL_RESULT_CONTENT_CAP);
    expect(resolveToolResultCaptureMaxBytes({})).toBe(TOOL_RESULT_CONTENT_CAP);
    expect(TOOL_RESULT_CONTENT_CAP).toBe(8192);
  });

  it('returns the configured value when one is set', () => {
    expect(resolveToolResultCaptureMaxBytes({ toolResultCaptureMaxBytes: 65536 })).toBe(65536);
  });

  it('leaves the effective-config snapshot unchanged for a config that does not set the key', () => {
    // The snapshot `gth config print` renders is `resolveConfig`'s merge with DEFAULT_CONFIG, not
    // DEFAULT_CONFIG itself. A default written into either one would print for everyone who never
    // set the key; a value the user DID set must still survive the merge.
    expect(DEFAULT_CONFIG).not.toHaveProperty('toolResultCaptureMaxBytes');
    const unset = resolveConfig({ llm: { type: 'openai', model: 'gpt-5.4' } } as never, {});
    expect(unset).not.toHaveProperty('toolResultCaptureMaxBytes');
    const set = resolveConfig(
      { llm: { type: 'openai', model: 'gpt-5.4' }, toolResultCaptureMaxBytes: 65536 } as never,
      {}
    );
    expect(set.toolResultCaptureMaxBytes).toBe(65536);
  });

  it('states the cap number exactly once across the capture code', () => {
    // A second literal is the drift this repo has been bitten by: the resolver, the agent fold and
    // the error-body recovery must all reach the constant rather than restate it. Comments are
    // stripped first, so a docblock that names the constant cannot smuggle a second number past
    // the scan, and neither can it hide one.
    const files = [
      'core/runStats.ts',
      'core/mcpErrorPayload.ts',
      'core/GthAbstractAgent.ts',
      'config/toolResultCapture.ts',
      'config/schema.ts',
    ].map((relative) => resolve(here, '../src', relative));

    const hits = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      return [...source.matchAll(/\b8192\b/g)].map(() => file);
    });

    expect(hits).toEqual([resolve(here, '../src/core/runStats.ts')]);
  });
});
