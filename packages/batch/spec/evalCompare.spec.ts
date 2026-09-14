import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EvalCaseResult, EvalSuiteSummary, EvalSweep } from '#src/evalTypes.js';

/** BATCH-25 — the sweep expansion, the config merge, and the run-over-run diff. */
describe('evalCompare', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('expandSweep', () => {
    it('produces the CARTESIAN PRODUCT of the axes, not a zip of them', async () => {
      // A cartesian bug (2 cells instead of 4, or values paired positionally) is invisible to every
      // other test and produces a comparison table that looks entirely reasonable.
      const { expandSweep } = await import('#src/evalCompare.js');
      const sweep: EvalSweep = {
        axes: [
          {
            name: 'rung',
            values: [
              { name: 'assisted', config: { approvals: { rung: 'assisted' } } },
              { name: 'auto', config: { approvals: { rung: 'auto' } } },
            ],
          },
          {
            name: 'model',
            values: [
              { name: 'flash', model: 'gemini-3.6-flash' },
              { name: 'gemma', model: 'gemma4:12b' },
            ],
          },
        ],
      };

      const cells = expandSweep(sweep);
      expect(cells).toHaveLength(4);
      expect(cells.map((cell) => cell.name)).toEqual([
        'rung=assisted · model=flash',
        'rung=assisted · model=gemma',
        'rung=auto · model=flash',
        'rung=auto · model=gemma',
      ]);
      expect(cells.map((cell) => cell.dirName)).toEqual([
        'rung-assisted__model-flash',
        'rung-assisted__model-gemma',
        'rung-auto__model-flash',
        'rung-auto__model-gemma',
      ]);
      // Each cell carries BOTH axes' contributions.
      expect(cells[0]).toMatchObject({
        model: 'gemini-3.6-flash',
        config: { approvals: { rung: 'assisted' } },
      });
      expect(cells[3]).toMatchObject({
        model: 'gemma4:12b',
        config: { approvals: { rung: 'auto' } },
      });
    });

    it('handles a single axis as a plain list of settings', async () => {
      const { expandSweep } = await import('#src/evalCompare.js');
      const cells = expandSweep({
        axes: [
          {
            name: 'backend',
            values: [
              { name: 'lean', config: { agent: { backend: 'lean' } } },
              { name: 'deep', config: { agent: { backend: 'deep' } } },
            ],
          },
        ],
      });
      expect(cells).toHaveLength(2);
      expect(cells[0].name).toBe('backend=lean');
    });
  });

  describe('deepMerge', () => {
    it('merges nested objects rather than replacing them wholesale', async () => {
      const { deepMerge } = await import('#src/evalCompare.js');
      expect(deepMerge({ a: { x: 1, y: 2 }, b: 3 }, { a: { y: 9 } })).toEqual({
        a: { x: 1, y: 9 },
        b: 3,
      });
    });

    it('REPLACES arrays and scalars — an override that appended would silently keep the base value', async () => {
      const { deepMerge } = await import('#src/evalCompare.js');
      expect(deepMerge({ tools: ['a', 'b'] }, { tools: ['c'] })).toEqual({ tools: ['c'] });
      expect(deepMerge({ n: 1 }, { n: 2 })).toEqual({ n: 2 });
    });

    it('skips prototype-polluting keys — a suite file is only semi-trusted input', async () => {
      const { deepMerge } = await import('#src/evalCompare.js');
      const merged = deepMerge({ safe: true }, JSON.parse('{"__proto__": {"polluted": true}}'));
      expect(merged).toEqual({ safe: true });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(
        deepMerge({ safe: true }, JSON.parse('{"constructor": {"x": 1}, "prototype": {"y": 2}}'))
      ).toEqual({ safe: true });
    });
  });

  describe('diffRuns', () => {
    const result = (over: Partial<EvalCaseResult>): EvalCaseResult => ({
      id: 'a',
      verdict: 'PASS',
      passThreshold: 6,
      sutOk: true,
      durationMs: 1,
      reasons: [],
      ...over,
    });
    const summaryOf = (cases: EvalCaseResult[]): EvalSuiteSummary => ({
      total: cases.length,
      passed: cases.filter((c) => c.verdict === 'PASS').length,
      failed: cases.filter((c) => c.verdict === 'FAIL').length,
      cases,
    });

    it('separates regressions from fixes', async () => {
      const { diffRuns } = await import('#src/evalCompare.js');
      const diff = diffRuns(
        summaryOf([
          result({ id: 'a', verdict: 'PASS' }),
          result({ id: 'b', verdict: 'FAIL', reasons: ['x'] }),
        ]),
        summaryOf([
          result({ id: 'a', verdict: 'FAIL', reasons: ['y'] }),
          result({ id: 'b', verdict: 'PASS' }),
        ])
      );
      expect(diff.compared).toBe(2);
      expect(diff.regressed).toEqual([{ id: 'a', before: 'PASS', after: 'FAIL' }]);
      expect(diff.fixed).toEqual([{ id: 'b', before: 'FAIL', after: 'PASS' }]);
    });

    it('reports a RECLASSIFICATION even when the verdict did not move', async () => {
      // The signal a pass-rate comparison structurally cannot see: the label under a still-passing
      // case moved, which is exactly what a rating-prompt edit does.
      const { diffRuns } = await import('#src/evalCompare.js');
      const diff = diffRuns(
        summaryOf([result({ id: 'a', classification: { actualLabel: 'destructive' } })]),
        summaryOf([result({ id: 'a', classification: { actualLabel: 'exfiltration' } })])
      );
      expect(diff.regressed).toEqual([]);
      expect(diff.reclassified).toEqual([
        { id: 'a', before: 'destructive', after: 'exfiltration' },
      ]);
    });

    it('WARNS when the two runs do not cover the same cases — a vanished case cannot regress', async () => {
      const { diffRuns } = await import('#src/evalCompare.js');
      const diff = diffRuns(
        summaryOf([result({ id: 'a' }), result({ id: 'gone' })]),
        summaryOf([result({ id: 'a' }), result({ id: 'new' })])
      );
      expect(diff.compared).toBe(1);
      expect(diff.onlyInBefore).toEqual(['gone']);
      expect(diff.onlyInAfter).toEqual(['new']);
      expect(diff.warnings.join('\n')).toMatch(/"no regressions" here is not "nothing broke"/);
    });

    it('keys matrix cells by id AND identity, so two identities never collide', async () => {
      const { diffRuns } = await import('#src/evalCompare.js');
      const diff = diffRuns(
        summaryOf([
          result({ id: 'a', identity: 'admin', verdict: 'PASS' }),
          result({ id: 'a', identity: 'limited', verdict: 'PASS' }),
        ]),
        summaryOf([
          result({ id: 'a', identity: 'admin', verdict: 'PASS' }),
          result({ id: 'a', identity: 'limited', verdict: 'FAIL', reasons: ['x'] }),
        ])
      );
      expect(diff.compared).toBe(2);
      expect(diff.regressed).toEqual([{ id: 'a__limited', before: 'PASS', after: 'FAIL' }]);
    });

    it('computes metric deltas for metrics both runs produced', async () => {
      const { diffRuns } = await import('#src/evalCompare.js');
      const withMetric = (value: number): EvalSuiteSummary => ({
        ...summaryOf([result({ id: 'a' })]),
        classification: {
          labels: ['safe'],
          actions: [],
          tags: [],
          coverage: { total: 1, scored: 1, excluded: 0 },
          labelMatrix: {
            dimension: 'label',
            rows: [],
            columns: [],
            counts: {},
            counted: 1,
            excluded: 0,
          },
          labelMatrixByTag: {},
          metrics: [
            {
              name: 'false_approve',
              overall: { numerator: 1, denominator: 4, value },
              byTag: {},
              coverage: { total: 4, scored: 4, excluded: 0, denominator: 4 },
              warnings: [],
            },
          ],
          warnings: [],
          gateFailures: [],
        },
      });
      const diff = diffRuns(withMetric(0.5), withMetric(0.25));
      expect(diff.metricDeltas).toEqual([
        { name: 'false_approve', before: 0.5, after: 0.25, delta: -0.25 },
      ]);
    });
  });

  /**
   * BATCH-33 — judge-score drift. Every case here is a suite with NO `classification:` block, which
   * is the shape the other three diff outputs are structurally blind to.
   */
  describe('judge drift', () => {
    /** One judged cell: a rate, and the gate it is graded against. */
    const judged = (id: string, rate: number, passThreshold = 6): EvalCaseResult => ({
      id,
      verdict: rate >= passThreshold ? 'PASS' : 'FAIL',
      passThreshold,
      sutOk: true,
      durationMs: 1,
      reasons: [],
      judge: { attempted: true, ok: true, verdict: { rate, reason: 'because' } },
    });
    const suite = (cases: EvalCaseResult[]): EvalSuiteSummary => ({
      total: cases.length,
      passed: cases.filter((c) => c.verdict === 'PASS').length,
      failed: cases.filter((c) => c.verdict === 'FAIL').length,
      cases,
    });

    it('reports a slide toward the gate on a suite with NO classification block', async () => {
      // The headline gap: 7 → 6 still PASSES, flips no verdict and moves no label, so before this
      // the whole diff for this run was the words "no change." It is the node's own example of the
      // movement that matters.
      const { diffRuns } = await import('#src/evalCompare.js');
      const diff = diffRuns(suite([judged('a', 7)]), suite([judged('a', 6)]));
      expect(diff.regressed).toEqual([]);
      expect(diff.reclassified).toEqual([]);
      expect(diff.judgeDrift).toEqual([
        { id: 'a', before: 7, after: 6, delta: -1, passThreshold: 6, reason: 'near-threshold' },
      ]);
    });

    it('stays QUIET on a stable suite whose cells wobble ABOVE the gate', async () => {
      // The acceptance property, as a deterministic counterpart to the live re-run: a ±1 wobble
      // anywhere above the gate must print NOTHING, or the section fills with noise on every run
      // and gets skipped. A test that only ever asserts firing cannot see this regress.
      //
      // Cell 'e' is the measured case — a live judge re-rating ONE fixed answer twelve times
      // returned 7s and 8s, so 8 → 7 against a gate of 6 is the exact width of the noise. This
      // assertion is what fixes the default tolerance at 0: it fails at a shoulder of 1.
      const { diffRuns, renderRunDiff } = await import('#src/evalCompare.js');
      const diff = diffRuns(
        suite([judged('a', 10), judged('b', 9), judged('c', 8), judged('d', 9), judged('e', 8)]),
        suite([judged('a', 9), judged('b', 10), judged('c', 8), judged('d', 8), judged('e', 7)])
      );
      expect(diff.judgeDrift).toEqual([]);
      const rendered = renderRunDiff(diff).join('\n');
      expect(rendered).not.toMatch(/JUDGE DRIFT/);
      expect(rendered).toMatch(/no change\./);
    });

    it('threshold-ward:1 DOES report the wobble the default ignores', async () => {
      // The shoulder is a knob, not a removed feature. A corpus with a steadier judge than the one
      // measured here can widen it and get the run-before-the-run warning back; this pins that the
      // default is a chosen value rather than the only behaviour the code has.
      const { diffRuns } = await import('#src/evalCompare.js');
      const diff = diffRuns(suite([judged('a', 8)]), suite([judged('a', 7)]), {
        mode: 'threshold-ward',
        tolerance: 1,
      });
      expect(diff.judgeDrift).toEqual([
        { id: 'a', before: 8, after: 7, delta: -1, passThreshold: 6, reason: 'near-threshold' },
      ]);
    });

    it('reports a CROSSING of the gate in either direction', async () => {
      const { diffRuns } = await import('#src/evalCompare.js');
      const down = diffRuns(suite([judged('a', 7)]), suite([judged('a', 5)]));
      expect(down.judgeDrift).toEqual([
        { id: 'a', before: 7, after: 5, delta: -2, passThreshold: 6, reason: 'crossed' },
      ]);
      const up = diffRuns(suite([judged('a', 5)]), suite([judged('a', 7)]));
      expect(up.judgeDrift).toEqual([
        { id: 'a', before: 5, after: 7, delta: 2, passThreshold: 6, reason: 'crossed' },
      ]);
    });

    it('is silent on a big DOWNWARD move that stays clear of the gate', async () => {
      // Direction alone is not the rule. 10 → 8 at a gate of 6 is the node's own example of the
      // movement that matters LESS, and reporting it is how the section goes noisy.
      const { diffRuns } = await import('#src/evalCompare.js');
      expect(diffRuns(suite([judged('a', 10)]), suite([judged('a', 8)])).judgeDrift).toEqual([]);
    });

    it('is silent on an upward move that never crosses', async () => {
      // Proximity alone is not the rule either: a case recovering 7 → 9 is near the gate on one
      // side and must not report.
      const { diffRuns } = await import('#src/evalCompare.js');
      expect(diffRuns(suite([judged('a', 7)]), suite([judged('a', 9)])).judgeDrift).toEqual([]);
    });

    it('measures the shoulder against each case OWN threshold, not a global one', async () => {
      // A case with `pass_threshold: 9` sitting at 9 is ON its gate even though 9 is a high score.
      const { diffRuns } = await import('#src/evalCompare.js');
      const diff = diffRuns(suite([judged('a', 10, 9)]), suite([judged('a', 9, 9)]));
      expect(diff.judgeDrift).toEqual([
        { id: 'a', before: 10, after: 9, delta: -1, passThreshold: 9, reason: 'near-threshold' },
      ]);
    });

    it('uses the LOWEST turn rate for a multi-turn cell, whose top-level judge is unset', async () => {
      // A multi-turn cell passes iff EVERY turn passes, so the weakest turn is the one nearest the
      // gate. Reading only the top-level field would give every multi-turn suite an empty section.
      const { diffRuns } = await import('#src/evalCompare.js');
      const multi = (rates: number[]): EvalCaseResult => ({
        id: 'm',
        verdict: 'PASS',
        passThreshold: 6,
        sutOk: true,
        durationMs: 1,
        reasons: [],
        turns: rates.map((rate) => ({
          user: 'q',
          ok: true,
          verdict: 'PASS' as const,
          reasons: [],
          judge: { attempted: true, ok: true, verdict: { rate, reason: 'because' } },
        })),
      });
      const diff = diffRuns(suite([multi([10, 8])]), suite([multi([10, 6])]));
      expect(diff.judgeDrift).toEqual([
        { id: 'm', before: 8, after: 6, delta: -2, passThreshold: 6, reason: 'near-threshold' },
      ]);
    });

    it('WARNS when a case was judged in the baseline and produced no score now', async () => {
      // "No drift" must not read as "the scores held" when the judge simply stopped answering.
      const { diffRuns } = await import('#src/evalCompare.js');
      const unjudged: EvalCaseResult = {
        id: 'a',
        verdict: 'FAIL',
        passThreshold: 6,
        sutOk: true,
        durationMs: 1,
        reasons: ['judge error'],
        judge: { attempted: true, ok: false, error: 'timeout' },
      };
      const diff = diffRuns(suite([judged('a', 9)]), suite([unjudged]));
      expect(diff.judgeDrift).toEqual([]);
      expect(diff.warnings.join('\n')).toMatch(/not "the scores held"/);
    });

    it('WARNS when the gate itself moved between the two runs', async () => {
      const { diffRuns } = await import('#src/evalCompare.js');
      const diff = diffRuns(suite([judged('a', 8, 6)]), suite([judged('a', 8, 8)]));
      expect(diff.warnings.join('\n')).toMatch(/the gate moving rather than the score/);
    });

    it('applies the threshold-ward filter by DEFAULT, with no filter argument', async () => {
      // The default lives in diffRuns, not only in the CLI, so a caller that never heard of the
      // flag still gets the quiet behaviour.
      const { diffRuns, DEFAULT_JUDGE_DRIFT_FILTER } = await import('#src/evalCompare.js');
      const diff = diffRuns(suite([judged('a', 10)]), suite([judged('a', 8)]));
      expect(diff.judgeDriftFilter).toEqual(DEFAULT_JUDGE_DRIFT_FILTER);
      expect(diff.judgeDriftFilter).toEqual({ mode: 'threshold-ward', tolerance: 0 });
      expect(diff.judgeDrift).toEqual([]);
    });

    it('min-points reports any movement of N+, wherever it lands', async () => {
      const { diffRuns } = await import('#src/evalCompare.js');
      const filter = { mode: 'min-points' as const, points: 2 };
      const far = diffRuns(suite([judged('a', 10)]), suite([judged('a', 8)]), filter);
      expect(far.judgeDrift.map((entry) => entry.reason)).toEqual(['moved']);
      const small = diffRuns(suite([judged('a', 10)]), suite([judged('a', 9)]), filter);
      expect(small.judgeDrift).toEqual([]);
    });

    it('mean reports the suite aggregate and NO per-case rows', async () => {
      const { diffRuns, renderRunDiff } = await import('#src/evalCompare.js');
      const diff = diffRuns(
        suite([judged('a', 10), judged('b', 8)]),
        suite([judged('a', 9), judged('b', 7)]),
        { mode: 'mean' }
      );
      expect(diff.judgeDrift).toEqual([]);
      expect(diff.judgeDriftMean).toEqual({ before: 9, after: 8, delta: -1, cases: 2 });
      expect(renderRunDiff(diff).join('\n')).toMatch(/judge mean: 9\.00 → 8\.00 \(-1\.00\)/);
    });

    it('off reports nothing at all, not even the lost-score warning', async () => {
      const { diffRuns } = await import('#src/evalCompare.js');
      const diff = diffRuns(suite([judged('a', 7)]), suite([judged('a', 5)]), { mode: 'off' });
      expect(diff.judgeDrift).toEqual([]);
      expect(diff.judgeDriftMean).toBeUndefined();
    });

    it('renders drift under its own heading and does NOT then claim "no change."', async () => {
      // The contradiction this guards: a run that printed a JUDGE DRIFT section and then said
      // nothing had changed underneath it.
      const { diffRuns, renderRunDiff } = await import('#src/evalCompare.js');
      const rendered = renderRunDiff(
        diffRuns(suite([judged('a', 8)]), suite([judged('a', 6)]))
      ).join('\n');
      expect(rendered).toMatch(/JUDGE DRIFT — toward the pass threshold \(tolerance 0\) \(1\):/);
      expect(rendered).toMatch(/a: 8 → 6 \(-2\) — now AT the pass threshold 6/);
      expect(rendered).not.toMatch(/no change\./);
    });

    describe('parseJudgeDriftFilter', () => {
      it('accepts the four documented forms', async () => {
        const { parseJudgeDriftFilter } = await import('#src/evalCompare.js');
        expect(parseJudgeDriftFilter('threshold-ward')).toEqual({
          mode: 'threshold-ward',
          tolerance: 0,
        });
        expect(parseJudgeDriftFilter('threshold-ward:2')).toEqual({
          mode: 'threshold-ward',
          tolerance: 2,
        });
        expect(parseJudgeDriftFilter('min:3')).toEqual({ mode: 'min-points', points: 3 });
        expect(parseJudgeDriftFilter('mean')).toEqual({ mode: 'mean' });
        expect(parseJudgeDriftFilter('off')).toEqual({ mode: 'off' });
      });

      it('REFUSES the values that would reconstitute the unfiltered report', async () => {
        // A knob that admits its own degenerate value ships the raw form the union deliberately
        // cannot express — `min:0` keeps every movement, and a shoulder wider than the scale keeps
        // every downward one.
        const { parseJudgeDriftFilter, MAX_JUDGE_DRIFT_TOLERANCE } =
          await import('#src/evalCompare.js');
        expect(() => parseJudgeDriftFilter('min:0')).toThrow(/unfiltered form/);
        expect(() => parseJudgeDriftFilter('min:-1')).toThrow(/unfiltered form/);
        expect(() =>
          parseJudgeDriftFilter(`threshold-ward:${MAX_JUDGE_DRIFT_TOLERANCE + 1}`)
        ).toThrow(/unfiltered form/);
      });

      it('rejects an unrecognised filter rather than silently defaulting', async () => {
        const { parseJudgeDriftFilter } = await import('#src/evalCompare.js');
        expect(() => parseJudgeDriftFilter('all')).toThrow(/unrecognised --drift filter/);
        expect(() => parseJudgeDriftFilter('mean:2')).toThrow(/unrecognised --drift filter/);
        expect(() => parseJudgeDriftFilter('min:two')).toThrow(/unrecognised --drift filter/);
        expect(() => parseJudgeDriftFilter('min')).toThrow(/unrecognised --drift filter/);
      });
    });
  });
});
