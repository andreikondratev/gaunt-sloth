import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EXT-188 — a mock written with the PACKAGE spelling must intercept the module a core
 * module's own `#src/…` self-import resolves to.
 *
 * `packages/core/src/utils/ProgressIndicator.ts` imports `{ stdout }` from
 * `#src/utils/systemUtils.js` — the subpath-import spelling. This spec sits in
 * `packages/app`, i.e. OUTSIDE core, and mocks the same module by its package spelling
 * `@gaunt-sloth/core/utils/systemUtils.js`. The two spellings are different strings, and
 * `vi.mock` keys on the RESOLVED module, so the only thing that makes the mock bite is
 * `resolveWorkspaceImports` in the root `vitest.config.ts` normalising both to the one
 * file `packages/core/src/utils/systemUtils.ts`.
 *
 * Nothing else in the suite would notice if that normalisation were narrowed or dropped.
 * The mock would still install and every cell that mocks `systemUtils` from outside core
 * would still pass, while silently observing a stub production never writes to — an
 * assertion that cannot fail. This cell is the tripwire: it goes red the moment the two
 * spellings stop being one module.
 *
 * The resolver-level statement of the same invariant, including the case where the two
 * spellings deliberately do NOT converge, is in `resolveWorkspaceImports.spec.ts`.
 */

const stdoutWriteMock = vi.fn();

vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  stdout: { write: stdoutWriteMock },
}));

describe('cross-package mock specifier identity (EXT-188)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('a package-spelling mock intercepts the module a core `#src/` self-import resolves to', async () => {
    // Deliberately the SUBPATH spelling for the subject and the PACKAGE spelling for the
    // mock above: the mixed case is the sensitive one. Importing the subject by the same
    // spelling as the mock would keep the two in step even if the resolver stopped
    // normalising them, and the cell would then pass while pinning nothing.
    const { ProgressIndicator } = await import('#src/utils/ProgressIndicator.js');

    // `manual: true` so no 1s setInterval handle is created; the constructor's write and
    // stop()'s terminating newline are both real production writes through `systemUtils`.
    const indicator = new ProgressIndicator('Fetching.', true);
    indicator.stop();

    // If the mock did not intercept, these are 0 calls on a stub nothing writes to.
    expect(stdoutWriteMock).toHaveBeenCalledWith('Fetching.');
    expect(stdoutWriteMock).toHaveBeenCalledWith('\n');
    expect(stdoutWriteMock).toHaveBeenCalledTimes(2);
  });
});
