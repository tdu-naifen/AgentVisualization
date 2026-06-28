// scenarios/03_eval.ts — the evaluation hierarchy (folder 03).
//
// Each Next press climbs ONE level of the evaluation pyramid. You climb only as far
// as the task forces you: cheap/objective at the bottom, expensive/subjective at the
// top. A fixed demo (a CPU-saturation question + a candidate answer that is a CORRECT
// paraphrase of a reference answer) is graded the same way at every level, so each
// level's blind spot — and the reason to climb — is visible.
//
//   L1 Reference-based  — exact-match / ROUGE token-overlap F1.   NO LLM (model-free)
//   L2 Task-verifiable  — retrieval recall@k + faithfulness/relevance.  NO LLM
//   L3 LLM-as-judge     — rubric scoring; the ONLY streaming step.  LLM (streams)
//   L4 Human eval       — Cohen's κ calibrates the judge.  NO LLM (terminal)
//
// Teaching contrast: levels 1/2/4 are pure metric code — no stream box. Only L3 (the
// judge) streams, because the judge IS the model reasoning. Mirrors the behavior of
// reference/03_eval_hierarchy/{run,judge,prompts}.py, adapted to the unified Scenario
// framework + browser LLM.

import type { ChatMsg, Doc, LLM, Panel, ScenarioMeta, StepCallbacks, StepView } from '@/types';
import {
  BaseScenario,
  codeTitle,
  extractRubricScore,
  llmTitle,
  makePanel,
  makeStep,
  runStream,
  TAG_MODEL,
  type StepResult,
} from '@/lib/scenarioBase';

const TOTAL_LEVELS = 4;

// The pinned judge version — an unpinned judge drifts silently under you (failure
// mode #4). The gate stamps it so cross-version compares can be refused.
const JUDGE_VERSION = 'rubric-judge-v1';

// ─── The fixed demo: one question, one reference, one candidate paraphrase ─────
// The candidate is SEMANTICALLY CORRECT but lexically different — it reuses few of
// the reference's exact words. That gap is the whole point of L1: a correct answer
// scores low on token overlap, so surface-form metrics go blind on paraphrase.

const QUESTION =
  'A storage service is pegging CPU while its shards restart in a loop with error ' +
  'E1342. What is the root cause and the safe remediation?';

const REFERENCE_ANSWER =
  'The shards are stuck in a restart loop triggered by the E1342 out-of-memory ' +
  'fault, and that churn is saturating the CPU. The safe remediation is to raise ' +
  "each shard's memory limit and roll the pods one at a time.";

const CANDIDATE_ANSWER =
  'Runaway shard restarts from the E1342 fault are pinning the processor. Fix it by ' +
  'lifting the per-shard RAM ceiling and recycling instances sequentially, one node ' +
  'at a time.';

export class EvalScenario extends BaseScenario {
  readonly meta: ScenarioMeta = {
    id: '03_eval',
    title: 'Evaluation Hierarchy',
    subtitle: 'climb the pyramid: reference → verifiable → judge → human',
    kind: 'workflow',
    teaches: 'Climb the evaluation pyramid only as far as the task forces you: cheap metrics first, judge last.',
    intro: 'Evaluation is a pyramid: cheap deterministic metrics first, the expensive LLM judge only when needed. L1 ROUGE and L2 task-checks are code; L3 is the LLM-as-judge (the one model call); L4 is human calibration. Climb only as far as the task forces.',
  };

  private llm: LLM;
  private docs: Doc[];

  constructor(llm: LLM, docs: Doc[]) {
    super();
    this.llm = llm;
    this.docs = docs;
  }

  protected traceName(): string {
    return 'eval_hierarchy';
  }

  reset(): void {
    super.reset();
    // No mutable scenario state to clear — the demo is a pure climb. (Base resets
    // the step counter, finished flag, and trace.)
  }

  protected async runStep(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    const done = stepIndex + 1 >= TOTAL_LEVELS;
    switch (stepIndex) {
      case 0:
        return { step: this.level1(stepIndex, cb), done };
      case 1:
        return { step: this.level2(stepIndex, cb), done };
      case 2:
        return { step: await this.level3(stepIndex, cb), done };
      default:
        return { step: this.level4(stepIndex, cb), done };
    }
  }

  // ── L1 · Reference-based — exact-match / ROUGE-1 token-overlap F1 (NO LLM) ────
  private level1(stepIndex: number, cb: StepCallbacks): StepView {
    cb.onPhase?.({ phase: 'act', stage: stepIndex });
    this.trace.spanOpen('level', { step: stepIndex, level: 'L1', name: 'reference-based' });

    const r = rouge1(CANDIDATE_ANSWER, REFERENCE_ANSWER);
    const exact = normalize(CANDIDATE_ANSWER) === normalize(REFERENCE_ANSWER);
    this.trace.step('rouge1', {
      precision: r.precision,
      recall: r.recall,
      f1: r.f1,
      overlap: r.overlap,
      exact_match: exact,
    });

    const scores = [
      `exact-match     : ${exact ? 'PASS' : 'FAIL'}   (verbatim copies only)`,
      `ROUGE-1 overlap : ${r.overlap} unigrams shared  (cand ${r.candLen} | ref ${r.refLen} tokens)`,
      `ROUGE-1 precision: ${pct(r.precision)}`,
      `ROUGE-1 recall   : ${pct(r.recall)}`,
      `ROUGE-1 F1       : ${pct(r.f1)}   ← the headline number`,
    ].join('\n');

    const scoresPanel = makePanel(
      'l1-scores',
      codeTitle('L1 · Reference-based scores'),
      `${scores}\n\n` +
        'Computed live, no model: lowercased whitespace tokens, F1 of the shared ' +
        'unigrams (no stemming — "shards" ≠ "shard", "pods" ≠ "pod").',
      'ctx',
    );

    this.trace.spanClose({ f1: r.f1, exact_match: exact });
    return makeStep(stepIndex, 'L1 · Reference-based (exact-match / ROUGE)', {
      panels: [this.pyramidPanel(1), scoresPanel],
      hint:
        'The candidate is a CORRECT paraphrase yet fails exact-match and scores low ROUGE F1. ' +
        'Reference metrics are paraphrase-blind: they reward word reuse, not meaning — which is ' +
        'why open-ended answers force the next level up.',
    });
  }

  // ── L2 · Task-verifiable — retrieval metrics + faithfulness/relevance (NO LLM) ─
  private level2(stepIndex: number, cb: StepCallbacks): StepView {
    cb.onPhase?.({ phase: 'act', stage: stepIndex });
    this.trace.spanOpen('level', { step: stepIndex, level: 'L2', name: 'task-verifiable' });
    this.trace.step('retrieval_bakeoff', { k: 5, corpus_docs: this.docs.length, best: 'hybrid' });

    const retrieval = [
      'RETRIEVAL — did we fetch the right facts? (k = 5)',
      '  method   recall@5   MRR    nDCG@5',
      '  light      0.71     0.62    0.66',
      '  dense      0.94     0.88    0.90',
      '  hybrid     0.978    0.95    0.96   ← ship this',
      '',
      'recall@k bounds the best possible answer: a doc you never retrieve is',
      'unrecoverable downstream, no matter how good generation is.',
    ].join('\n');

    const generation = [
      'GENERATION — two ORTHOGONAL questions, measured separately:',
      '  answer                    relevance   faithfulness',
      '  grounded (correct)           1.00         0.93',
      '  hallucinated (on-topic)      1.00         0.19   ← relevant yet ungrounded',
      '  off-topic dodge             0.12         0.10   ← fails both',
      '',
      'EXECUTABLE output — the strongest, cheapest tier: when the model emits a',
      'config/SQL/code you PARSE it, you don\'t ask a judge (e.g. lint the agent YAML).',
    ].join('\n');

    const splitPanel = makePanel(
      'l2-split',
      codeTitle('Split retrieval eval from answer eval'),
      `${retrieval}\n\n${generation}`,
      'ctx',
    );

    this.trace.spanClose({ recall_at_5: 0.978, faithfulness_hallucinated: 0.19 });
    return makeStep(stepIndex, 'L2 · Task-verifiable (retrieval + faithfulness)', {
      panels: [this.pyramidPanel(2), splitPanel],
      hint:
        'Splitting the stages localizes failure: a retriever can "succeed" (return a doc) while ' +
        'handing generation semantically wrong context — metrics look fine, the answer breaks. ' +
        'But faithfulness/relevance still need ground-truth docs or a runnable output. For an ' +
        'open-ended answer with no key to grade against, even L2 runs out — which forces the judge (L3).',
    });
  }

  // ── L3 · LLM-as-judge — rubric scoring. The ONLY streaming step. ─────────────
  private async level3(stepIndex: number, cb: StepCallbacks): Promise<StepView> {
    cb.onPhase?.({ phase: 'generate', stage: stepIndex });
    this.trace.spanOpen('level', { step: stepIndex, level: 'L3', name: 'llm-as-judge' });

    const messages: ChatMsg[] = [
      { role: 'system', content: judgeSystemPrompt() },
      { role: 'user', content: judgeUserPrompt() },
    ];

    // mode:'stream' (NOT 'think'): the judge must emit its full reply, because the
    // rubric verdict — the final "SCORE: n/5" line — lives in the ANSWER, not the
    // thought channel. (think() returns only the thought text and would discard the
    // score, so the box used to flicker through reasoning then show NO number.) We
    // stream the whole judgement so you watch the reasoning AND land on a real score.
    const { stream, text } = await runStream({
      llm: this.llm,
      messages,
      label: llmTitle('Judge score'),
      kind: 'judge',
      mode: 'stream',
      cb,
      trace: this.trace,
      traceStep: 'judge',
    });

    // The score is the MODEL's — parsed from its output, never fabricated. If the
    // model emitted no parseable score we say so honestly (no invented number).
    const score = extractRubricScore(text, 5);
    this.trace.step('verdict', { judge_version: JUDGE_VERSION, score: score ?? 'unparsed' });

    const verdictHeadline =
      score !== null
        ? `★ Rubric score: ${score}/5   ${TAG_MODEL}`
        : `Rubric score: not parseable from the model's reply   ${TAG_MODEL}`;

    const verdictPanel = makePanel(
      'l3-verdict',
      llmTitle('L3 · Judge verdict'),
      `${verdictHeadline}\n` +
        `judge ${JUDGE_VERSION} (pinned) · the score above is the MODEL's, read live from\n` +
        "its streamed reply — not computed by the harness.\n\n" +
        (score !== null && score >= 4
          ? 'The judge rewarded the correct paraphrase that L1 exact-match PENALIZED — '
          : score !== null
            ? 'The judge scored the paraphrase below the pass bar — judges are biased, which '
            : 'No machine-readable score came back this run — a judge is a model, so it can '
        ) +
        'needs NO reference key: it reads the rubric and reasons about meaning.',
      'decide',
    );

    const failurePanel = makePanel(
      'l3-failure-modes',
      "The judge's 4 failure modes (each with its mitigation)",
      [
        'position bias   — favors an answer by SLOT not content → score pairwise in',
        '                  BOTH orders, reconcile; a flip ⇒ return "tie".',
        'verbosity bias  — longer scores higher regardless → rubric says "ignore',
        '                  length"; a long-but-empty answer should LOSE (5 vs 1).',
        'self-preference — over-scores its own family\'s style → judge with a',
        '                  DIFFERENT model; anchor on a rubric; calibrate (L4).',
        'judge drift     — the instrument changes silently → PIN + stamp the version',
        `                  (${JUDGE_VERSION}); the gate refuses cross-version compares.`,
      ].join('\n'),
      'decide',
    );

    this.trace.spanClose({ judge_version: JUDGE_VERSION, score: score ?? null });
    // Carry the finished judge stream in the returned step so the box STAYS visible
    // after the step settles (page.tsx replaces `current` with this step) — the one
    // stream box in the whole scenario, making the model-free vs model contrast plain.
    return makeStep(stepIndex, 'L3 · LLM-as-judge (rubric scoring)', {
      streams: [stream],
      panels: [this.pyramidPanel(3), verdictPanel, failurePanel],
      hint:
        'That is why eval can scale here — a judge needs no reference key — but a judge is itself ' +
        'a biased model, which is why L4 calibrates it.',
    });
  }

  // ── L4 · Human eval — Cohen's κ calibrates the judge (NO LLM, terminal) ───────
  private level4(stepIndex: number, cb: StepCallbacks): StepView {
    cb.onPhase?.({ phase: 'act', stage: stepIndex });
    this.trace.spanOpen('level', { step: stepIndex, level: 'L4', name: 'human-eval' });

    // Binarize the judge's 1–5 score (good = ≥4) and compare to a small committed
    // hand-labeled set (a few deliberately adversarial). Cohen's κ — not raw %
    // agreement — because if most answers are "good", two labelers who always say
    // "good" agree 90% while sharing ZERO signal; κ subtracts that chance agreement.
    const k = cohenKappa(HUMAN_CALIBRATION);
    this.trace.step('cohens_kappa', {
      n: HUMAN_CALIBRATION.length,
      po: k.po,
      pe: k.pe,
      kappa: k.kappa,
      band: kappaBand(k.kappa),
    });

    const calc = [
      `hand-labeled rows : ${HUMAN_CALIBRATION.length}   (judge-binary vs human-binary; some adversarial)`,
      `observed agreement: po = ${pct(k.po)}`,
      `chance agreement  : pe = ${pct(k.pe)}`,
      `Cohen's κ         : ${k.kappa.toFixed(2)}   → "${kappaBand(k.kappa)}" (Landis–Koch)`,
      '',
      'κ = (po − pe) / (1 − pe): raw % agreement would read ' + pct(k.po) + ', but κ',
      'strips the agreement two raters get by chance — the honest receipt.',
    ].join('\n');

    const kappaPanel = makePanel(
      'l4-kappa',
      codeTitle("L4 · Human eval calibrates the judge (Cohen's κ)"),
      calc,
      'observe',
    );

    this.trace.spanClose({ kappa: k.kappa });
    return makeStep(stepIndex, 'L4 · Human eval (Cohen\'s κ) — pyramid complete', {
      panels: [this.pyramidPanel(4), kappaPanel],
      hint:
        'An uncalibrated judge is just another unevaluated model — κ is its receipt. Human labels ' +
        'are the calibration gold standard: expensive and slow, so you spend a small set to ' +
        'CALIBRATE the L3 judge, report κ, and pin the judge version. That closes the pyramid.',
    });
  }

  // A compact view of the climb, marking where we are and which levels use the
  // model. Reinforces the teaching contrast: only L3 streams.
  private pyramidPanel(level: number): Panel {
    const rows = [
      { n: 4, label: 'L4 · Human eval        — hand labels → Cohen\'s κ', model: false },
      { n: 3, label: 'L3 · LLM-as-judge      — rubric scoring (biased)', model: true },
      { n: 2, label: 'L2 · Task-verifiable   — recall@k · faithfulness', model: false },
      { n: 1, label: 'L1 · Reference-based   — exact-match / ROUGE', model: false },
    ];
    const body = rows
      .map((r) => {
        const here = r.n === level ? '▶ ' : '  ';
        const tag = r.model ? '  [LLM · streams]' : '  [model-free]';
        return `${here}${r.label}${tag}`;
      })
      .join('\n');
    return makePanel(
      'pyramid',
      `The evaluation pyramid — level ${level} of ${TOTAL_LEVELS}`,
      `${body}\n\nClimb only as far as the task forces you: cheap/objective at the ` +
        'bottom, expensive/subjective at the top. Only L3 calls the model.',
      'ctx',
    );
  }
}

// ─── L1 metric: ROUGE-1 token-overlap F1 (pure, no model) ─────────────────────

/** Lowercase, strip punctuation to spaces — the normalized surface form. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Whitespace tokens of the normalized string. */
function tokenize(s: string): string[] {
  const n = normalize(s);
  return n.length === 0 ? [] : n.split(' ');
}

interface Rouge1 {
  precision: number;
  recall: number;
  f1: number;
  overlap: number;
  candLen: number;
  refLen: number;
}

/**
 * ROUGE-1 (unigram) overlap of candidate vs reference. Overlap is the multiset
 * intersection (sum of min counts per token); precision divides by candidate length,
 * recall by reference length, F1 is their harmonic mean. No stemming — surface form
 * only, which is exactly the blind spot L1 exhibits.
 */
function rouge1(candidate: string, reference: string): Rouge1 {
  const cand = tokenize(candidate);
  const ref = tokenize(reference);
  const refCounts = new Map<string, number>();
  for (const t of ref) refCounts.set(t, (refCounts.get(t) ?? 0) + 1);

  let overlap = 0;
  const seen = new Map<string, number>();
  for (const t of cand) {
    const used = seen.get(t) ?? 0;
    if (used < (refCounts.get(t) ?? 0)) {
      overlap += 1;
      seen.set(t, used + 1);
    }
  }

  const precision = cand.length ? overlap / cand.length : 0;
  const recall = ref.length ? overlap / ref.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, overlap, candLen: cand.length, refLen: ref.length };
}

// ─── L3 judge: prompts + score extraction ─────────────────────────────────────

function judgeSystemPrompt(): string {
  return (
    `You are ${JUDGE_VERSION}, a careful evaluation judge. Score a CANDIDATE answer ` +
    'against a REFERENCE answer on a 1–5 rubric:\n' +
    '  5 = fully correct: same root cause AND same safe remediation as the reference\n' +
    '  3 = partially correct: one of cause/remediation right, the other missing or wrong\n' +
    '  1 = wrong or unrelated\n' +
    'Judge MEANING, not wording — a correct paraphrase must score high even if it ' +
    'shares few words with the reference. IGNORE answer length; longer is not better. ' +
    'Reason briefly, then end with a final line exactly: SCORE: <n>/5.'
  );
}

function judgeUserPrompt(): string {
  return (
    `QUESTION:\n${QUESTION}\n\n` +
    `REFERENCE ANSWER:\n${REFERENCE_ANSWER}\n\n` +
    `CANDIDATE ANSWER:\n${CANDIDATE_ANSWER}\n\n` +
    'Score the candidate against the reference using the rubric. End with SCORE: <n>/5.'
  );
}

// ─── L4 metric: Cohen's κ (pure, no model) ────────────────────────────────────

/** One calibration row: the judge's binarized good/bad vs a human hand label. */
interface CalibrationRow {
  judgeGood: boolean;
  humanGood: boolean;
}

// 10 committed rows. Designed so κ = 0.80 exactly ("substantial"): 5 agree-good,
// 4 agree-bad, 1 adversarial disagreement (judge fooled into "good", human says bad
// — e.g. a verbose but empty answer). po = 0.90, pe = 0.50 → κ = 0.40/0.50 = 0.80.
const HUMAN_CALIBRATION: CalibrationRow[] = [
  { judgeGood: true, humanGood: true },
  { judgeGood: true, humanGood: true },
  { judgeGood: true, humanGood: true },
  { judgeGood: true, humanGood: true },
  { judgeGood: true, humanGood: true },
  { judgeGood: true, humanGood: false }, // adversarial: verbosity-fooled judge
  { judgeGood: false, humanGood: false },
  { judgeGood: false, humanGood: false },
  { judgeGood: false, humanGood: false },
  { judgeGood: false, humanGood: false },
];

interface Kappa {
  po: number;
  pe: number;
  kappa: number;
}

/**
 * Cohen's κ for two binary raters (judge vs human). po = observed agreement; pe =
 * agreement expected by chance from the marginals; κ = (po − pe) / (1 − pe).
 */
function cohenKappa(rows: CalibrationRow[]): Kappa {
  const n = rows.length || 1;
  let agree = 0;
  let judgeGood = 0;
  let humanGood = 0;
  for (const r of rows) {
    if (r.judgeGood === r.humanGood) agree += 1;
    if (r.judgeGood) judgeGood += 1;
    if (r.humanGood) humanGood += 1;
  }
  const po = agree / n;
  const pJg = judgeGood / n;
  const pHg = humanGood / n;
  // chance both-good + chance both-bad
  const pe = pJg * pHg + (1 - pJg) * (1 - pHg);
  const kappa = pe < 1 ? (po - pe) / (1 - pe) : 1;
  return { po, pe, kappa };
}

/** Landis–Koch interpretive band for a κ value. */
function kappaBand(k: number): string {
  if (k < 0) return 'poor';
  if (k <= 0.2) return 'slight';
  if (k <= 0.4) return 'fair';
  if (k <= 0.6) return 'moderate';
  if (k <= 0.8) return 'substantial';
  return 'almost perfect';
}

// ─── small format helpers ─────────────────────────────────────────────────────

/** A 0..1 ratio as a 2-decimal percentage-style fraction, e.g. 0.41. */
function pct(x: number): string {
  return x.toFixed(2);
}

// ─── factory the framework calls ──────────────────────────────────────────────

/** Factory the framework calls. */
export function makeEvalScenario(llm: LLM, docs: Doc[]): EvalScenario {
  return new EvalScenario(llm, docs);
}
