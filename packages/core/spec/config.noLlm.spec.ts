import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EXT-186 — the READ side of "a config with no `llm` key".
 *
 * Two facts this file pins, both measured against the real `resolveConfig` rather than reasoned
 * about, because the node was filed with the read path explicitly NOT established:
 *
 *   1. A config layer with no `llm` survives the read. `resolveConfig` returns a `GthConfig` whose
 *      `llm` is `undefined`, which is how a model-less config reaches the agent in the first place.
 *      That is deliberate and stays that way — `gth config print` calls `initConfig` and needs no
 *      model, and it is the command a person runs to find out what was actually read. The refusal
 *      lives at the agent's `getEffectiveConfig` funnel instead, where every door reaches it
 *      (`GthLangChainAgent.spec.ts` pins it, with the control that holds the absent case apart from
 *      the present-but-unusable one).
 *
 *   2. `--verbose` must not turn that config into a second `TypeError` naming nothing. Before this
 *      node the assignment was unguarded and `gth --verbose <anything>` died with
 *      `Cannot set properties of undefined (setting 'verbose')` before the funnel was ever reached,
 *      so the named refusal would have been unreachable for exactly the run a user adds `--verbose`
 *      to in order to find out what is wrong.
 *
 * The second cell is the CONTROL for the first: the guard is allowed to skip the assignment only
 * when there is no model, never to stop performing it. A guard written as `if (false)` passes cell
 * one and reds this one.
 */
describe('EXT-186 — a config layer with no llm at the read site', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('resolves to a config whose llm is undefined rather than refusing the read', async () => {
    const { resolveConfig } = await import('#src/config/loader.js');

    const resolved = resolveConfig({}, {});

    expect(resolved.llm).toBeUndefined();
    // The rest of the config still resolved, which is the point: this is a readable config that
    // happens to name no model, not a broken read.
    expect(resolved.commands).toBeDefined();
  });

  it('does not crash on --verbose when there is no model to make verbose', async () => {
    const { resolveConfig } = await import('#src/config/loader.js');

    expect(() => resolveConfig({}, { verbose: true })).not.toThrow();
    expect(resolveConfig({}, { verbose: true }).llm).toBeUndefined();
  });

  it('CONTROL: --verbose still reaches an llm that IS present', async () => {
    const { resolveConfig } = await import('#src/config/loader.js');
    const llm = { verbose: false };

    const resolved = resolveConfig({ llm } as never, { verbose: true });

    expect(resolved.llm.verbose).toBe(true);
    // Set on the model itself, not copied onto some other object.
    expect(llm.verbose).toBe(true);
  });
});
