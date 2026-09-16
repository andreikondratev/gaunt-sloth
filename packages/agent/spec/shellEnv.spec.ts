import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  SYNTHESIZED_NODE_ENV_MARKER,
  buildScrubbedEnv,
  shouldScrubEnvVar,
} from '#src/tools/shell/env.js';

describe('shouldScrubEnvVar', () => {
  it('scrubs explicit provider/cloud credentials', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GROQ_API_KEY',
      'XAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'MISTRAL_API_KEY',
      'OPENROUTER_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AZURE_OPENAI_API_KEY',
    ]) {
      expect(shouldScrubEnvVar(name), name).toBe(true);
    }
  });

  it('scrubs by wildcard suffix (unknown provider keys)', () => {
    expect(shouldScrubEnvVar('SOMENEWPROVIDER_API_KEY')).toBe(true);
    expect(shouldScrubEnvVar('FOO_SECRET')).toBe(true);
    expect(shouldScrubEnvVar('BAR_TOKEN')).toBe(true);
    expect(shouldScrubEnvVar('MY_SECRET_KEY')).toBe(true);
  });

  it('keeps generic dev env intact', () => {
    for (const name of [
      'PATH',
      'HOME',
      'SHELL',
      'LANG',
      'PWD',
      'NODE_ENV',
      'npm_config_registry',
    ]) {
      expect(shouldScrubEnvVar(name), name).toBe(false);
    }
  });

  it('keeps GITHUB_TOKEN / GH_TOKEN (needed by gh providers)', () => {
    expect(shouldScrubEnvVar('GITHUB_TOKEN')).toBe(false);
    expect(shouldScrubEnvVar('GH_TOKEN')).toBe(false);
  });
});

describe('buildScrubbedEnv', () => {
  it('removes credentials and preserves the rest', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/home/x',
      ANTHROPIC_API_KEY: 'sk-secret',
      OPENAI_API_KEY: 'sk-other',
      GITHUB_TOKEN: 'ghp_keepme',
      RANDOM_TOKEN: 'should-go',
    };
    const out = buildScrubbedEnv(source);
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/x');
    expect(out.GITHUB_TOKEN).toBe('ghp_keepme');
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.RANDOM_TOKEN).toBeUndefined();
  });
});

/**
 * TUI-C55 — the entry point sets `NODE_ENV=production` so React picks its production build, and
 * that is an implementation detail of how *we* render. It must not reach the commands the agent
 * runs, where `NODE_ENV=production` has real consequences (npm skipping devDependencies, framework
 * build and logging defaults flipping).
 *
 * The distinction these cases pin is provenance, not value: an operator's own `NODE_ENV=production`
 * is byte-identical to ours, so only the marker can tell them apart. Both directions are asserted,
 * because a scrubber that simply always dropped `NODE_ENV` would pass the first case and silently
 * discard a setting the operator made deliberately.
 */
describe('buildScrubbedEnv — synthesized NODE_ENV (TUI-C55)', () => {
  it('drops a NODE_ENV we synthesized, along with its marker', () => {
    const out = buildScrubbedEnv({
      PATH: '/usr/bin',
      NODE_ENV: 'production',
      [SYNTHESIZED_NODE_ENV_MARKER]: '1',
    });
    expect(out.NODE_ENV).toBeUndefined();
    expect(out[SYNTHESIZED_NODE_ENV_MARKER]).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
  });

  it("preserves an operator's own NODE_ENV, which carries no marker", () => {
    const out = buildScrubbedEnv({ PATH: '/usr/bin', NODE_ENV: 'production' });
    expect(out.NODE_ENV).toBe('production');
  });

  it('preserves an operator NODE_ENV that differs from ours', () => {
    const out = buildScrubbedEnv({ PATH: '/usr/bin', NODE_ENV: 'staging' });
    expect(out.NODE_ENV).toBe('staging');
  });

  /**
   * The demonstration rather than the assertion: a real child process, spawned the way the shell
   * tool spawns one, reporting the environment it actually received. The cases above describe the
   * object we build; this one proves what a spawned program sees.
   */
  it('a really-spawned child does not receive the synthesized NODE_ENV', () => {
    const script = 'process.stdout.write(JSON.stringify(process.env.NODE_ENV ?? null))';

    const synthesized = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: buildScrubbedEnv({
        ...process.env,
        NODE_ENV: 'production',
        [SYNTHESIZED_NODE_ENV_MARKER]: '1',
      }),
    });
    expect(synthesized.error).toBeUndefined();
    expect(synthesized.status).toBe(0);
    expect(synthesized.stdout).toBe('null');

    // Control: the identical spawn, identical value, no marker — so the difference the child sees
    // is caused by the provenance marker and nothing else.
    const operatorSet = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: buildScrubbedEnv({ ...process.env, NODE_ENV: 'production' }),
    });
    expect(operatorSet.status).toBe(0);
    expect(operatorSet.stdout).toBe('"production"');
  });
});
