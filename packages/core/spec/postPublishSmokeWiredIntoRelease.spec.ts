import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * OPS-42 — the post-publish smoke must stay wired into the release pipeline, and must keep reading
 * the version that was PUBLISHED.
 *
 * scripts/post-publish-smoke.mjs is unit-tested next door, but a release alarm nothing invokes is
 * the failure mode that looks exactly like success: releases would go back to being unverified
 * against the registry and every test would stay green. The script reaches the release through
 * strings in a workflow file — a `needs:`, a checkout and a `run:` line — none of which is
 * type-checked, executed by the unit suite, or referenced from any code path. Same problem
 * docsRenderGateWired.spec.ts and releaseNotesWiredIntoRelease.spec.ts exist to solve.
 *
 * Four properties are asserted beyond "the job exists", because each is a way this could be quietly
 * turned into a check that proves nothing:
 *
 *  - it must not read the version from `main`. The pipeline ships the version in
 *    packages/core/package.json and only THEN post-bumps `main`, so a job that checks out `main` and
 *    reads it asks the registry for a version that does not exist and is red on every successful
 *    release. That is a false alarm pointing the reassuring way, and a release alarm that cries wolf
 *    gets muted — the specific way this work would be wasted;
 *  - it must stay key-free. A post-publish alarm that needs provider secrets goes red for reasons
 *    unrelated to packaging, and gets muted the same way;
 *  - nothing may depend on it and it must carry no `continue-on-error`. The publish has already
 *    happened when it runs, so it blocks nothing by design — but it has to be LOUD, and a red step
 *    inside a green job is precisely where nobody looks;
 *  - the release job's own publish path must be untouched. The grant that allowed this workflow to
 *    be edited covered adding this job and nothing else.
 *
 * This asserts facts about the *files*. What the script does is proven by running it, in
 * postPublishSmoke.spec.ts.
 */

const RELEASE_WORKFLOW = new URL('../../../.github/workflows/release.yml', import.meta.url);
const HELPER = new URL('../../../scripts/post-publish-smoke.mjs', import.meta.url);

const SMOKE_JOB = 'post-publish-smoke';
const RELEASE_JOB = 'release';
const HELPER_COMMAND = 'node ci-scripts/scripts/post-publish-smoke.mjs';

/**
 * One job's text, from its `<id>:` key to the start of the next job. Same slicing as
 * releaseNotesWiredIntoRelease.spec.ts, and the terminator is `[^\s#]` for the same reason: against
 * an identifier-shaped pattern the slice would run to end of file, letting another job satisfy an
 * assertion about this one.
 */
function jobText(workflow: string, jobId: string): string {
  const start = workflow.indexOf(`\n  ${jobId}:`);
  if (start === -1) return '';
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}[^\s#]/);
  return next === -1 ? rest : rest.slice(0, next);
}

function workflow(): string {
  return readFileSync(RELEASE_WORKFLOW, 'utf8');
}

function smokeJob(): string {
  return jobText(workflow(), SMOKE_JOB);
}

/** A line whose first non-whitespace content is this text, so a `#`-commented one cannot match. */
function liveLine(text: string): RegExp {
  return new RegExp(`^[ \\t]*${text}`, 'm');
}

/**
 * The job with its comments removed — whole-line AND trailing — for the assertions that say a
 * construct must NOT appear. This job documents the traps it avoids by name — the post-bump trap
 * quotes `packages/core/package.json`, the loudness note quotes `continue-on-error` — and a
 * substring search over the raw text cannot tell a warning about a construct from the construct
 * itself. Trailing comments are stripped for the same reason and not only whole lines: the guard
 * must not red because someone explained a live line in prose beside it, which is exactly the
 * false-alarm shape this job exists to avoid producing. The stripped form is also the honest one —
 * a commented-out `ref: main` is inert YAML.
 */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');
}

describe('OPS-42 the post-publish smoke is wired into the release pipeline', () => {
  it('has the helper script', () => {
    expect(existsSync(HELPER), 'scripts/post-publish-smoke.mjs is missing').toBe(true);
  });

  it('reads live YAML, not the prose beside it', () => {
    // The negative assertions below run over `code()`, so this pins what it strips. A guard that
    // fired because someone explained a live line in prose would be the same false alarm the job
    // itself is built to avoid producing.
    const stripped = code(
      [
        '    # ref: main here would be the post-bump trap',
        '      contents: read # and never packages/core/package.json',
        '      run: node ci-scripts/scripts/post-publish-smoke.mjs',
      ].join('\n')
    );
    expect(stripped).not.toContain('ref: main');
    expect(stripped).not.toContain('packages/core/package.json');
    // Control: the live YAML on those same lines survives, so the stripping is not just emptying
    // the text and passing every assertion for the wrong reason.
    expect(stripped).toContain('contents: read');
    expect(stripped).toContain('node ci-scripts/scripts/post-publish-smoke.mjs');
  });

  it('runs the helper as a job of the release workflow', () => {
    expect(
      liveLine(`run: ${HELPER_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(smokeJob()),
      `the "${SMOKE_JOB}" job must run "${HELPER_COMMAND}" — without it a release is never ` +
        'installed from the registry and the first party to find a broken publish is a user.'
    ).toBe(true);
  });

  it('runs only after the publish', () => {
    expect(
      liveLine(`needs: ${RELEASE_JOB}`).test(smokeJob()),
      'the smoke must depend on the release job: it tests what the registry serves, which does ' +
        'not exist until the publish step has run.'
    ).toBe(true);
  });

  it('never reads the version from main', () => {
    const job = code(smokeJob());
    // Control: an empty slice would satisfy every assertion below for the wrong reason.
    expect(job).toContain(HELPER_COMMAND);
    expect(
      job.includes('ref: main'),
      'checking out `main` here is the post-bump trap: by the time this job runs, `main` carries ' +
        'the NEXT version and the registry has the one just published. A job that reads it is red ' +
        'on every successful release.'
    ).toBe(false);
    expect(
      job.includes('packages/core/package.json'),
      'the published version comes from the release tag at this run’s commit, never from a ' +
        'package.json — the version in the tree moved on after the publish.'
    ).toBe(false);
  });

  it('checks out no workspace, so the package under test can only come from the registry', () => {
    const job = code(smokeJob());
    expect(job).toContain(HELPER_COMMAND);
    expect(
      liveLine('sparse-checkout: scripts').test(job),
      'only scripts/ is checked out. A full workspace on disk invites the check resolving the ' +
        'local build instead of the bytes the registry served.'
    ).toBe(true);
    expect(
      /pnpm install|pnpm run build/.test(job),
      'nothing in this job may install or build the workspace — the point is the published package.'
    ).toBe(false);
  });

  it('stays key-free', () => {
    const job = code(smokeJob());
    expect(job).toContain(HELPER_COMMAND);
    // GITHUB_TOKEN reads the tag that names the published version. Anything else — a provider key,
    // an environment carrying one — makes this go red for reasons unrelated to packaging.
    const secrets = [...job.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(secrets.sort()).toEqual(['GITHUB_TOKEN']);
    expect(
      /^\s*environment:/m.test(job),
      'the smoke must not run in a deployment environment: those carry the release secrets and ' +
        'gate on a manual approval, neither of which an after-the-fact alarm should wait on.'
    ).toBe(false);
  });

  it('blocks nothing, and cannot go quietly red', () => {
    const text = code(workflow());
    const job = code(smokeJob());
    expect(job).toContain(HELPER_COMMAND);
    expect(
      job.includes('continue-on-error'),
      'the publish has already happened, so this blocks nothing by design — but it must be LOUD. ' +
        'A failing step inside a job that still reports success is where nobody looks.'
    ).toBe(false);
    // Nothing may gate on it either: a `needs:` on this job would make a post-publish alarm hold
    // something up, which is not what it is for.
    const dependents = [...text.matchAll(/^\s*needs:.*$/gm)]
      .map((m) => m[0])
      .filter((line) => line.includes(SMOKE_JOB));
    expect(dependents).toEqual([]);
  });

  it('writes the response to a red run into the workflow itself', () => {
    const job = smokeJob();
    // You cannot un-publish freely, so the recovery is unlike every other gate's and nobody should
    // be improvising it while a broken version is live. Each outcome the script can return names
    // its remedy here, next to the job that produces it.
    for (const outcome of ['BROKEN', 'DIST_TAG', 'PARTIAL', 'NOT_VISIBLE']) {
      expect(job, `the workflow does not say what to do about a ${outcome} run`).toContain(outcome);
    }
    expect(job).toMatch(/unpublish/i);
    expect(job).toMatch(/deprecate/i);
  });

  it('leaves the release job’s publish path untouched', () => {
    const release = jobText(workflow(), RELEASE_JOB);
    // The permission to edit this workflow covered ADDING the smoke job. These are the steps the
    // release itself rests on; if one of them has moved, this change went further than it was
    // allowed to.
    expect(release).toContain('run: pnpm run release:publish');
    expect(release).toContain('run: ./tag-packages.sh --push');
    expect(release).toContain('run: git push origin HEAD:main');
    expect(release).toContain('node -p "require(\'./packages/core/package.json\').version"');
    // Control: the slice stops before the smoke job, so the assertions above are about the release
    // job and the one below cannot pass by reading past its end.
    expect(release).not.toContain(HELPER_COMMAND);
  });
});
