import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * OPS-134 — Dependabot pull requests are reviewed, and a Dependabot run that cannot read the
 * provider key skips the review instead of failing it. Everyone else still goes red.
 *
 * Three things are pinned here, because each is quiet when it breaks.
 *
 * `concierge` once carried `if: ${{ !startsWith(github.head_ref, 'dependabot') }}`, and since both
 * review jobs declare `needs: concierge`, that did not narrow the review for those branches — it
 * removed it. A re-added head-ref condition would look like a small guard on one job and would
 * again cancel every review downstream of it, silently and only for the pull requests nobody
 * opened by hand.
 *
 * The fail-soft guard is what makes that safe to land: whether a `pull_request_target` run raised
 * by Dependabot can read a secret from the ordinary Actions scope is a property of GitHub's
 * Dependabot secret rules, not of this repository, so there the review skips with a warning.
 *
 * The third is the narrowing, and it is the one most likely to be "simplified" away, because three
 * shell branches look like two with a redundant case. They are not. An absent key on anybody
 * else's pull request means the key is missing or revoked, which is what a loud red is for — and
 * `reviewWorkflowReportGuard.spec.ts` records that principle. Widening the skip to every author
 * would turn that red into a green build with no review.
 *
 * Asserted against the workflow text: nothing executes these files in the unit suite, nothing
 * type-checks them, and no code path references them, so a refactor can drop any of it with no
 * signal at all. Same reasoning as `reviewWorkflowReportGuard.spec.ts`.
 */
const REVIEW_WORKFLOW = new URL('../../../.github/workflows/review.yml', import.meta.url);
const SHARED_WORKFLOW = new URL('../../../.github/workflows/_review-shared.yml', import.meta.url);

const GATE_STEP = 'Decide whether the review can run';
const KEY_GUARD = "if: steps.review_gate.outputs.run_review == 'true'";

/**
 * A workflow's steps, split on the `- name:`/`- uses:` that opens each one, so a step's text
 * carries its own `if:` and nobody else's — the same splitter, and the same reason for it, as
 * `reviewWorkflowReportGuard.spec.ts`.
 */
function steps(workflow: URL): string[] {
  const text = readFileSync(workflow, 'utf8');
  return text.split(/^ {6}- (?=name:|uses:)/m).slice(1);
}

function stepNamed(workflow: URL, name: string): string {
  const found = steps(workflow).filter((step) => step.startsWith(`name: ${name}`));
  expect(found, `expected one step named ${name}`).toHaveLength(1);
  return found[0];
}

/** Every `if:` condition in a workflow, one per line, comments excluded. */
function conditions(workflow: URL): string[] {
  return readFileSync(workflow, 'utf8')
    .split('\n')
    .filter((line) => /^\s*if:/.test(line));
}

/**
 * The gate step's shell script, cut into its three branches. Cutting it up is what lets the tests
 * below say WHICH branch skips the review: asserting that the script mentions both the author and
 * the skip passes just as well when the skip has been moved to the branch that catches everyone.
 */
function gateBranches(): { onKey: string; onDependabot: string; otherwise: string } {
  const step = stepNamed(SHARED_WORKFLOW, GATE_STEP);
  const script = step.slice(step.indexOf('run: |'));
  const ifAt = script.indexOf('\n          if ');
  const elifAt = script.indexOf('\n          elif ');
  const elseAt = script.indexOf('\n          else');
  const fiAt = script.indexOf('\n          fi');
  expect(
    [ifAt, elifAt, elseAt, fiAt].filter((at) => at === -1),
    'expected the gate to be a three-branch shell conditional'
  ).toEqual([]);
  expect(ifAt, 'expected if, elif, else, fi in that order').toBeLessThan(elifAt);
  expect(elifAt, 'expected if, elif, else, fi in that order').toBeLessThan(elseAt);
  expect(elseAt, 'expected if, elif, else, fi in that order').toBeLessThan(fiAt);
  return {
    onKey: script.slice(ifAt, elifAt),
    onDependabot: script.slice(elifAt, elseAt),
    otherwise: script.slice(elseAt, fiAt),
  };
}

describe('review.yml sends Dependabot pull requests down the review path', () => {
  it('has no head-ref exemption on any job', () => {
    const found = conditions(REVIEW_WORKFLOW);
    // The two review jobs are each gated on the classifier's output, so an empty set here would
    // mean the splitter stopped matching rather than that the exemption is gone.
    expect(
      found.length,
      'expected review.yml to still carry its own job conditions'
    ).toBeGreaterThanOrEqual(2);
    for (const condition of found) {
      expect(condition).not.toContain('head_ref');
    }
  });

  it('keeps both review jobs downstream of the classifier, which is why the exemption was fatal', () => {
    const text = readFileSync(REVIEW_WORKFLOW, 'utf8');
    expect(text.match(/needs: concierge/g) ?? []).toHaveLength(2);
  });
});

describe('_review-shared.yml decides what a keyless run does', () => {
  it('reads the key the review profile uses, and the author the decision turns on', () => {
    const gate = stepNamed(SHARED_WORKFLOW, GATE_STEP);
    expect(gate).toContain('id: review_gate');
    expect(gate).toContain('GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}');
    expect(gate).toContain('PR_AUTHOR: ${{ github.event.pull_request.user.login }}');
  });

  it('runs the review whenever the key is readable', () => {
    expect(gateBranches().onKey).toContain('[ -n "$GOOGLE_API_KEY" ]');
    expect(gateBranches().onKey).toContain('run_review=true');
  });

  it('skips only for a Dependabot author, naming OPS-134 and the Dependabot secrets scope', () => {
    const { onDependabot } = gateBranches();
    expect(onDependabot).toContain('"$PR_AUTHOR" = "dependabot[bot]"');
    expect(onDependabot).toContain('run_review=false');
    expect(onDependabot).toContain('OPS-134');
    expect(onDependabot).toContain('Dependabot secrets scope');
  });

  it('still runs the review for a keyless pull request from anybody else, so the run goes red', () => {
    const { otherwise } = gateBranches();
    expect(otherwise).toContain('run_review=true');
    expect(otherwise, 'a keyless human pull request must not be skipped').not.toContain(
      'run_review=false'
    );
  });

  it('holds the skip to that one branch', () => {
    const gate = stepNamed(SHARED_WORKFLOW, GATE_STEP);
    expect(gate.match(/run_review=false/g) ?? []).toHaveLength(1);
  });

  it('guards the review step on that decision', () => {
    expect(stepNamed(SHARED_WORKFLOW, 'Perform code review')).toContain(KEY_GUARD);
  });
});
