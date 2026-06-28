// scenarios/05_validation.ts — the validation chain / ladder (folder 05).
//
// "I don't trust an LLM output with one check — I climb a validation ladder,
//  cheapest rung first, and each rung is cheaper than the failure it prevents
//  downstream."  The artifact under validation is a Datadog-style MONITOR CONFIG
//  synthesized from a natural-language request.
//
// Each Next press = ONE rung of the ladder:
//   ① rung 1   schema   structural JSON-Schema check        (NO model)   accent ctx
//   ② rung 1b  lint     domain sanity (% threshold range)   (NO model)   accent ctx
//                       ↳ teaching beat: threshold 130 FAILS lint →
//                         feed errors back → regenerate → repaired passes (guardrail retry)
//   ③ rung 2   replay   dry-run vs known-good/known-bad      (NO model)   accent ctx
//   ④ rung 3   judge    LLM-as-judge semantic intent match   (the ONLY   accent decide
//                       model rung — runs LAST, after the cheap certain checks)
//   ⑤ rung 4   human    all green → AUTO-APPLY; else fail closed → safe-default + escalate
//                                                            (NO model)   accent observe
//
// Verifiable rungs (schema/lint/replay) GATE BEFORE the judge, so a config can
// never reach prod on a biased judge's word alone. Fail closed, not open.
//
// Mirrors reference/05_validation_chain/{config,validators,prompts,ladder}.py,
// adapted to the unified Scenario framework. Only rung 3 streams a model.

import type { ChatMsg, Doc, LLM, ScenarioMeta, StepCallbacks } from '@/types';
import {
  BaseScenario,
  codeTitle,
  extractRubricScore,
  llmTitle,
  makePanel,
  makeStep,
  runStream,
  TAG_DETERMINISTIC,
  TAG_MODEL,
  type StepResult,
} from '@/lib/scenarioBase';

// ─── The artifact under validation: a Datadog-style monitor config ────────────

interface MonitorConfig {
  name: string;
  metric: string;
  comparator: '>' | '>=' | '<' | '<=';
  threshold: number;
  window_minutes: number;
  aggregation: 'avg' | 'max' | 'min' | 'sum';
}

/** The natural-language ask the (scripted) generator turns into a monitor config. */
const REQUEST = 'Alert me when CPU is saturated (sustained high CPU on a host).';

// The candidate the generator first emits: schema-valid, but lint-broken on purpose
// (threshold 130 > 100 on a % metric; comparator '<' is the wrong direction too).
const BROKEN_CPU: MonitorConfig = {
  name: 'cpu alert',
  metric: 'system.cpu.user',
  comparator: '<', // wrong direction → would be a replay false-negative
  threshold: 130, // out of 0..100 → lint failure (caught first)
  window_minutes: 5,
  aggregation: 'avg',
};

// The repaired config after errors are fed back — passes every rung.
const GOOD_CPU: MonitorConfig = {
  name: 'High CPU saturation',
  metric: 'system.cpu.user',
  comparator: '>',
  threshold: 90,
  window_minutes: 5,
  aggregation: 'avg',
};

// The conservative fallback we DEGRADE to when generation won't converge (fail
// closed). It must itself re-pass the verifiable rungs before it's trusted.
const SAFE_DEFAULT_CPU: MonitorConfig = {
  name: 'CPU saturation (conservative default)',
  metric: 'system.cpu.user',
  comparator: '>',
  threshold: 85,
  window_minutes: 10,
  aggregation: 'avg',
};

// Replay fixtures: a known-bad window the monitor MUST catch and a known-good
// window it MUST ignore — the dry-run rung's behavioural ground truth.
const REPLAY_BAD = [95, 96, 98, 97, 99]; // sustained saturation → must fire
const REPLAY_GOOD = [20, 35, 28, 40, 31]; // healthy → must stay silent

// ─── The rungs as deterministic, model-free functions (rungs 1/1b/2) ──────────

const COMPARATORS = ['>', '>=', '<', '<='];
const AGGREGATIONS = ['avg', 'max', 'min', 'sum'];
const REQUIRED_FIELDS = ['name', 'metric', 'comparator', 'threshold', 'window_minutes', 'aggregation'];

/** rung 1 — structural validation. Catches format/type errors for almost zero cost. */
function schemaErrors(cfg: MonitorConfig): string[] {
  const rec = cfg as unknown as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of REQUIRED_FIELDS) {
    if (!(k in rec)) errors.push(`${k}: required field missing`);
  }
  if (typeof rec.name !== 'string' || rec.name.length < 1) errors.push('name: must be a non-empty string');
  if (typeof rec.metric !== 'string' || rec.metric.length < 1) errors.push('metric: must be a non-empty string');
  if (typeof rec.comparator !== 'string' || !COMPARATORS.includes(rec.comparator)) {
    errors.push(`comparator: must be one of ${COMPARATORS.join(' ')}`);
  }
  if (typeof rec.threshold !== 'number') errors.push('threshold: must be a number');
  if (
    typeof rec.window_minutes !== 'number' ||
    !Number.isInteger(rec.window_minutes) ||
    rec.window_minutes < 1 ||
    rec.window_minutes > 1440
  ) {
    errors.push('window_minutes: must be an integer in 1..1440');
  }
  if (typeof rec.aggregation !== 'string' || !AGGREGATIONS.includes(rec.aggregation)) {
    errors.push(`aggregation: must be one of ${AGGREGATIONS.join(' ')}`);
  }
  return errors;
}

/** rung 1b — domain sanity JSON Schema can't express cheaply. Still no model. */
function lintErrors(cfg: MonitorConfig): string[] {
  const errors: string[] = [];
  const looksPct = ['cpu', 'util', 'pct', 'percent', 'memory'].some((tok) =>
    cfg.metric.toLowerCase().includes(tok),
  );
  if (looksPct && !(cfg.threshold >= 0 && cfg.threshold <= 100)) {
    errors.push(`threshold ${cfg.threshold} out of range 0..100 for percentage metric '${cfg.metric}'`);
  }
  if (Number.isInteger(cfg.window_minutes) && cfg.window_minutes > 240) {
    errors.push(`window_minutes ${cfg.window_minutes} is unusually long (>4h) — likely a mistake`);
  }
  return errors;
}

/** Reduce a metric window to the single value the comparator tests. */
function aggregate(series: number[], how: MonitorConfig['aggregation']): number {
  if (series.length === 0) return 0;
  const sum = series.reduce((a, b) => a + b, 0);
  const ops: Record<MonitorConfig['aggregation'], number> = {
    avg: sum / series.length,
    max: Math.max(...series),
    min: Math.min(...series),
    sum,
  };
  return ops[how];
}

/** The dry-run core: would the monitor fire on this window? Simulate, don't apply. */
function fires(cfg: MonitorConfig, series: number[]): boolean {
  const value = aggregate(series, cfg.aggregation);
  const t = cfg.threshold;
  const ops: Record<MonitorConfig['comparator'], boolean> = {
    '>': value > t,
    '>=': value >= t,
    '<': value < t,
    '<=': value <= t,
  };
  return ops[cfg.comparator];
}

/** rung 2 — replay against fixtures; fails on a false negative or false positive. */
function replayErrors(cfg: MonitorConfig): string[] {
  const errors: string[] = [];
  if (!fires(cfg, REPLAY_BAD)) {
    errors.push('false negative: did NOT fire on known-bad CPU window (threshold too lax)');
  }
  if (fires(cfg, REPLAY_GOOD)) {
    errors.push('false positive: fired on known-good CPU window (threshold too sensitive)');
  }
  return errors;
}

/**
 * Heuristic intent verdict for the judge rung — approve only if the config's
 * metric token overlaps the request. Mirrors the reference's deterministic
 * fallback so the panel verdict is sensible even when the model is unavailable;
 * the model (when present) supplies the visible reasoning via the stream box.
 */
function judgeHeuristic(request: string, cfg: MonitorConfig): { approved: boolean; score: number; overlap: string[] } {
  const reqTokens = new Set(
    request
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[.,%()]/g, '')),
  );
  const metricTokens = cfg.metric.toLowerCase().replace(/\./g, ' ').split(/\s+/);
  const overlap = metricTokens.filter((tok) => reqTokens.has(tok));
  const approved = overlap.length > 0;
  return { approved, score: approved ? 5 : 2, overlap };
}

/** The LLM-as-judge rubric (the only thing a model is told). Mirrors prompts.py. */
function judgePrompt(request: string, cfg: MonitorConfig): string {
  return (
    'You are validating a generated monitoring config against a request.\n' +
    `REQUEST: ${request}\n` +
    `CONFIG: ${JSON.stringify(cfg)}\n` +
    "Does the config faithfully implement the request's intent (right metric, sensible " +
    'direction/threshold)? Reason briefly, then end with a final line exactly: SCORE: <n>/5. ' +
    'Approve only if the score is >= 4.'
  );
}

function fmt(cfg: MonitorConfig): string {
  return JSON.stringify(cfg, null, 2);
}

// ─── The scenario ─────────────────────────────────────────────────────────────

export class ValidationScenario extends BaseScenario {
  readonly meta: ScenarioMeta = {
    id: '05_validation',
    title: 'Validation Chain',
    subtitle: 'climb the ladder, cheapest rung first; fail closed',
    kind: 'workflow',
    teaches: 'Climb a validation ladder, cheapest check first, and fail closed when a rung doesn’t pass.',
  };

  private llm: LLM;
  /** The artifact currently under validation. Starts broken; repaired at rung 1b. */
  private candidate: MonitorConfig = { ...BROKEN_CPU };
  /** The real rung-3 judge outcome, threaded into rung 4 so the summary is honest. */
  private judgeApproved: boolean | null = null;
  private judgeScore: number | null = null;
  private judgeSource: 'model' | 'heuristic' | null = null;

  constructor(llm: LLM, _docs: Doc[]) {
    super();
    this.llm = llm;
  }

  protected traceName(): string {
    return 'validation_chain';
  }

  reset(): void {
    super.reset();
    this.candidate = { ...BROKEN_CPU };
    this.judgeApproved = null;
    this.judgeScore = null;
    this.judgeSource = null;
  }

  protected async runStep(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    switch (stepIndex) {
      case 0:
        return this.rungSchema();
      case 1:
        return this.rungLint();
      case 2:
        return this.rungReplay();
      case 3:
        return this.rungJudge(cb);
      default:
        return this.rungHuman();
    }
  }

  // ① rung 1 — schema (structural, no model). The cheapest gate: a malformed
  //    artifact can't even be replayed, so rejecting it here saves every rung below.
  private rungSchema(): StepResult {
    this.trace.spanOpen('rung', { step: 0, rung: 'schema', model: false });
    const errors = schemaErrors(this.candidate);
    const passed = errors.length === 0;
    this.trace.step('schema', { passed, errors });
    this.trace.spanClose({ passed });

    const body = passed
      ? 'PASS — required fields present, types & enums valid.\n' +
        'checked: name · metric · comparator∈{>,>=,<,<=} · threshold:number · ' +
        'window_minutes:int 1..1440 · aggregation∈{avg,max,min,sum}'
      : `FAIL\n- ${errors.join('\n- ')}`;

    const hint =
      'Schema proves well-FORMED, not well-AIMED. The threshold of 130 is operational ' +
      'nonsense yet PASSES here — lint (next rung) is what catches that.';

    const panels = [
      makePanel(
        'artifact',
        'candidate config (synthesized from the NL request)',
        `request: ${REQUEST}\n\n${fmt(this.candidate)}`,
        'ctx',
      ),
      makePanel('schema', codeTitle('rung 1 · schema  (structural)'), body, 'ctx'),
    ];
    return { step: makeStep(0, 'rung 1 · schema', { panels, hint }), done: false };
  }

  // ② rung 1b — lint (domain sanity, no model). The teaching beat: the broken
  //    threshold FAILS lint → feed errors back → regenerate → repaired passes.
  private rungLint(): StepResult {
    this.trace.spanOpen('rung', { step: 1, rung: 'lint', model: false });

    const before = lintErrors(this.candidate); // BROKEN_CPU → fails
    this.trace.step('lint', { passed: before.length === 0, errors: before });

    // Errors fed back into the generator → it repairs the whole config.
    const brokenCfg = { ...this.candidate };
    this.candidate = { ...GOOD_CPU };
    const after = lintErrors(this.candidate); // GOOD_CPU → passes
    this.trace.step('lint_repair', { passed: after.length === 0, errors: after, repaired: true });
    this.trace.spanClose({ passed: after.length === 0, repaired: true });

    // Make the example legible: SAY what we're looking at and why it's wrong, before
    // dumping the error. The story: a model turned the plain-English REQUEST into the
    // config on the previous rung; it is schema-valid (well-FORMED) but operationally
    // wrong (not well-AIMED), and lint is the cheap deterministic rung that catches it.
    const failBody =
      `WHAT THIS RUNG DOES: lint the model-generated config for DOMAIN sanity — the\n` +
      `operational rules JSON-Schema can't express cheaply. No model here; pure code.\n\n` +
      `the config under test (synthesized earlier from "${REQUEST}"):\n` +
      `  threshold = ${brokenCfg.threshold}   on metric '${brokenCfg.metric}' (a 0..100 % metric)\n` +
      `  comparator = '${brokenCfg.comparator}'   (the direction it fires)\n\n` +
      `→ FAIL\n- ${before.join('\n- ')}`;
    const repairBody =
      `THE RETRY LOOP: feed the exact lint errors back to the generator → it regenerates.\n\n` +
      `repaired config:\n${fmt(this.candidate)}\n\n` +
      `re-lint: ${after.length === 0 ? 'PASS ✓' : 'FAIL'}  ` +
      `— threshold ${this.candidate.threshold} ∈ 0..100, comparator '${this.candidate.comparator}' now fires ` +
      `when CPU is HIGH.`;

    const hint =
      `A CPU-percent alert with threshold ${brokenCfg.threshold} can NEVER fire (CPU maxes at 100), ` +
      `so it's a silent dead monitor: schema passed it because the value IS a number; lint is the rung ` +
      `that knows "a % can't exceed 100." This is the guardrail-retry beat — a cheap check rejects the ` +
      `artifact, the errors become the fix, and we climb to the next rung. (Datadog-style monitor ` +
      `config = the JSON an alerting system runs.)`;

    const panels = [
      makePanel('lint-fail', codeTitle('rung 1b · lint — FAIL'), failBody, 'ctx'),
      makePanel('lint-repair', codeTitle('retry · feed errors back → regenerate'), repairBody, 'ctx'),
    ];
    return {
      step: makeStep(1, 'rung 1b · lint (retry → repair)', { panels, guardrail: 'retry', hint }),
      done: false,
    };
  }

  // ③ rung 2 — replay / dry-run (behavioural ground truth, no model). Catches the
  //    "passes schema, still operationally wrong" config before it touches prod.
  private rungReplay(): StepResult {
    this.trace.spanOpen('rung', { step: 2, rung: 'replay', model: false });

    const badVal = aggregate(REPLAY_BAD, this.candidate.aggregation);
    const goodVal = aggregate(REPLAY_GOOD, this.candidate.aggregation);
    const firesBad = fires(this.candidate, REPLAY_BAD);
    const firesGood = fires(this.candidate, REPLAY_GOOD);
    const errors = replayErrors(this.candidate);
    const passed = errors.length === 0;
    this.trace.step('replay', { passed, firesBad, firesGood, errors });
    this.trace.spanClose({ passed });

    const { comparator: cmp, threshold: t, aggregation: agg } = this.candidate;
    const body =
      'behavioural ground truth — simulate the config against fixtures instead of applying to prod:\n' +
      `  known-BAD  [${REPLAY_BAD.join(', ')}]  ${agg}=${badVal.toFixed(1)} ${cmp} ${t} → ` +
      `${firesBad ? 'FIRES ✓ (caught)' : 'silent ✗ (false negative)'}\n` +
      `  known-GOOD [${REPLAY_GOOD.join(', ')}]  ${agg}=${goodVal.toFixed(1)} ${cmp} ${t} → ` +
      `${firesGood ? 'FIRES ✗ (false positive)' : 'silent ✓'}\n\n` +
      `${passed ? 'PASS' : 'FAIL'} — catches the right-shape/too-lax-threshold config.`;

    const hint =
      'Dry-run BEFORE apply: applying a bad monitor to prod to "see if it works" IS the outage.';

    const panels = [makePanel('replay', codeTitle('rung 2 · replay / dry-run  (behavioural)'), body, 'ctx')];
    return { step: makeStep(2, 'rung 2 · replay (dry-run)', { panels, hint }), done: false };
  }

  // ④ rung 3 — LLM judge (semantic intent match). The ONLY model rung, and it runs
  //    LAST, after the cheap certain checks. mode:'stream' so the FULL reply (which
  //    carries the rubric "SCORE: n/5") is captured — the score is the MODEL's.
  private async rungJudge(cb: StepCallbacks): Promise<StepResult> {
    this.trace.spanOpen('rung', { step: 3, rung: 'judge', model: true });

    const messages: ChatMsg[] = [
      {
        role: 'system',
        content:
          'You are a strict reviewer validating a generated monitoring config against a ' +
          'request. Reason briefly, then end with a final line exactly: SCORE: <n>/5. ' +
          'Approve only if the score is >= 4.',
      },
      { role: 'user', content: judgePrompt(REQUEST, this.candidate) },
    ];

    // Run the REAL judge. We parse the MODEL's score from its streamed reply and let
    // THAT drive the verdict — the model actually decides. Only if the model is
    // unavailable / unparseable do we fall back to a deterministic keyword heuristic,
    // and we LABEL which path produced the verdict (no pretending a script is a model).
    let judgeText = '';
    let modelFailed = false;
    try {
      const r = await runStream({
        llm: this.llm,
        messages,
        label: llmTitle('Judge'),
        kind: 'judge',
        mode: 'stream',
        cb,
        trace: this.trace,
        traceStep: 'judge',
      });
      judgeText = r.text;
    } catch (err) {
      modelFailed = true;
      this.trace.step('judge_fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const modelScore = extractRubricScore(judgeText, 5);
    const heuristic = judgeHeuristic(REQUEST, this.candidate);

    // Source of truth, honestly labeled: the MODEL's score when we got one, else the
    // deterministic fallback. The verdict (approve ≥4) follows whichever drove it.
    const usingModel = modelScore !== null;
    const score = usingModel ? modelScore : heuristic.score;
    const approved = score >= 4;
    const source = usingModel ? TAG_MODEL : TAG_DETERMINISTIC;
    // Thread the REAL verdict into rung 4 so the final summary reflects what the
    // judge actually decided this run — never a hardcoded "judge ✓".
    this.judgeApproved = approved;
    this.judgeScore = score;
    this.judgeSource = usingModel ? 'model' : 'heuristic';
    const sourceNote = usingModel
      ? "score read live from the model's streamed reply"
      : modelFailed
        ? 'model unavailable — fell back to a deterministic keyword-overlap heuristic'
        : "model gave no parseable score — fell back to a deterministic keyword-overlap heuristic";

    this.trace.step('judge_verdict', {
      approved,
      score,
      source: usingModel ? 'model' : 'heuristic',
      model_score: modelScore,
      heuristic_score: heuristic.score,
      overlap: heuristic.overlap,
    });
    this.trace.spanClose({ approved, score, source: usingModel ? 'model' : 'heuristic' });

    const body =
      `${approved ? 'APPROVED' : 'REJECTED'} · score ${score}/5   ${source}\n` +
      `(${sourceNote}; metric '${this.candidate.metric}' covers request keyword(s) ` +
      `[${heuristic.overlap.join(', ') || 'none'}])`;

    const hint =
      'The judge is the ONLY model rung and it runs LAST, by design. A judge is itself an ' +
      'unevaluated, biased model, so the verifiable rungs gate before it: it can never push a ' +
      'config to prod on its word alone, and it never overrides a hard replay failure. ' +
      "Judgment supplements verifiable checks; it doesn't replace them.";

    const panels = [makePanel('judge', llmTitle('rung 3 · LLM judge — semantic intent match'), body, 'decide')];
    return { step: makeStep(3, 'rung 3 · LLM judge', { panels, hint }), done: false };
  }

  // ⑤ rung 4 — human / outcome (no model). All green → AUTO-APPLY; otherwise fail
  //    closed: degrade to a validated safe-default + escalate to a human. Terminal.
  private rungHuman(): StepResult {
    this.trace.spanOpen('rung', { step: 4, rung: 'human', model: false });

    // The verifiable rungs (schema/lint/replay) all passed by construction in this
    // demo. The judge is the ONE genuinely model-driven rung, so its verdict is read
    // from what actually happened this run — not assumed.
    const judgeOk = this.judgeApproved !== false; // null (unreached) or true → not a block
    const judgeTag =
      this.judgeApproved === null
        ? 'judge ✓ (assumed)'
        : this.judgeApproved
          ? `judge ✓ (score ${this.judgeScore}/5, ${this.judgeSource})`
          : `judge ✗ REJECTED (score ${this.judgeScore}/5, ${this.judgeSource})`;
    const allGreen = judgeOk;
    const status = allGreen ? 'approved' : 'rejected';
    const action = allGreen
      ? 'AUTO-APPLY (behind prod dry-run gate)'
      : 'FAIL CLOSED → safe-default + escalate to human';
    this.trace.step('outcome', { status, action, judge_approved: this.judgeApproved });
    this.trace.spanClose({ status });

    const outcomeBody = allGreen
      ? 'all rungs green → AUTO-APPLY (behind a prod dry-run gate).\n' +
        `  rung 1 schema ✓   rung 1b lint ✓ (after 1 repair)   rung 2 replay ✓   rung 3 ${judgeTag}\n\n` +
        'Fail-closed path (NOT taken here): when retries don\'t converge, DEGRADE to a validated ' +
        `safe-default monitor (${SAFE_DEFAULT_CPU.metric} ${SAFE_DEFAULT_CPU.comparator} ` +
        `${SAFE_DEFAULT_CPU.threshold}, ${SAFE_DEFAULT_CPU.window_minutes}m) and ESCALATE to a human ` +
        '— never ship the plausible-but-wrong artifact.'
      : 'the model judge REJECTED the config → FAIL CLOSED (this is the safe outcome).\n' +
        `  rung 1 schema ✓   rung 1b lint ✓ (after 1 repair)   rung 2 replay ✓   rung 3 ${judgeTag}\n\n` +
        `→ DEGRADE to a validated safe-default monitor (${SAFE_DEFAULT_CPU.metric} ` +
        `${SAFE_DEFAULT_CPU.comparator} ${SAFE_DEFAULT_CPU.threshold}, ${SAFE_DEFAULT_CPU.window_minutes}m) ` +
        'and ESCALATE to a human. The verifiable rungs already passed, so we never SHIP nothing — we ' +
        'ship the conservative default (itself re-validated) and let a human review.';

    const hint =
      'Verifiable rungs (schema/lint/replay) gate BEFORE the judge, so a config can never reach ' +
      'prod on a biased judge\'s word alone. Each rung is cheaper than the failure it prevents ' +
      'downstream. A fallback you didn\'t validate is just another bug, so the safe default itself ' +
      're-climbs schema/lint/replay before it\'s trusted. This is the honest branch: a real model rung ' +
      'means a real reject is possible, and the system degrades safely instead of pretending everything ' +
      'is green. Fail closed, not open.';

    const panels = [
      makePanel('outcome', codeTitle('rung 4 · human / outcome'), outcomeBody, 'observe'),
    ];
    return { step: makeStep(4, 'rung 4 · human / outcome', { panels, hint }), done: true };
  }
}

/** Factory the framework calls. `docs` is accepted for a uniform signature, unused here. */
export function makeValidationScenario(llm: LLM, docs: Doc[]): ValidationScenario {
  return new ValidationScenario(llm, docs);
}
