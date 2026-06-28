// scenarios/01_rag.ts — the RAG pipeline (folder 01): a FIXED three-stage loop,
// NOT an agent. Each Next press advances exactly ONE stage and the run terminates
// after stage 3:
//
//   ① Retrieve  BM25 rank a planted query     (deterministic — NO model)
//   ② Reason    copilot answers from context  (the ONE model call — streamed)
//   ③ Validate  a pure citation gate          (deterministic — NO model)
//
// This is the plain story of a RAG system: RETRIEVE the relevant docs, put them in
// the model's CONTEXT, and let it SUMMARIZE/answer — grounded and cited. (We do not
// dwell on ingest/chunking; the teaching point is retrieval → context → answer.)
//
// The teaching contrast vs 02 (the agent) lives in the SHAPE: a RAG system is a
// predictable pipeline whose model is used at exactly one step. So stages ①/③
// emit no streaming box at all; only stage ② carries an LlmStream. The retrieval
// step is intentionally model-free — that determinism is the point (retrieval eval
// is recall@k / MRR, separate from answer eval).
//
// The demo query "why is my service CPU pegged and saturated at 100%" is a PLANTED
// lexical collision: BM25 matches the literal token `CPU` and ranks the CPU-cooler
// *buying guide* high (a lexically-perfect, semantically-wrong distractor doc, type
// `distractor`) — but the real `cpu_saturation_runbook` is ALSO retrieved into the
// grounding window. So the model must REASON PAST the look-alike to the right doc,
// and the validation gate checks grounded PROVENANCE (was the cited id retrieved?),
// not semantic correctness — the senior nuance: lexical "success" can still rank a
// wrong doc first, and grounding is what lets the model recover.
//
// Mirrors reference/01_rag_pipeline/{generate,bakeoff}.py behavior, adapted to the
// unified Scenario framework + browser LLM.

import type { ChatMsg, Doc, LLM, ScenarioMeta, StepCallbacks } from '@/types';
import { BaseScenario, codeTitle, llmTitle, makePanel, makeStep, runStream, type StepResult } from '@/lib/scenarioBase';
import { rankDocs } from '@/lib/retrieval';

/** The planted-collision demo query (reference/01 config.py — the headline case).
 *  Chosen so BM25 ranks the CPU-cooler *distractor* high (lexical collision on the
 *  token `cpu`) while STILL retrieving the real cpu_saturation_runbook into the
 *  grounding window — the model has to reason past the look-alike to the right doc. */
const DEMO_QUERY = 'why is my service CPU pegged and saturated at 100%';
/** How many hits to retrieve (recall@k window) and how many to ground reasoning on. */
const RETRIEVE_K = 5;
const GROUNDING_K = 3;

/** Stable scenario identity, returned by the `meta` getter (see note on the class). */
const RAG_META: ScenarioMeta = {
  id: '01_rag',
  title: 'RAG Pipeline',
  subtitle: 'fixed Ingest → Retrieve → Reason → Validate',
};

export class RagScenario extends BaseScenario {
  // NOTE: `meta` is a GETTER, not a field. BaseScenario's constructor calls
  // newTrace() → reads `this.meta.id` during super(). A subclass *field*
  // initializer (`readonly meta = {…}`) does not run until AFTER super() returns
  // (ECMAScript class-field ordering), so a field would be `undefined` there and
  // the base ctor would throw. A getter lives on the prototype and resolves
  // immediately, so it is safe to read during super(). Returns a stable reference.
  get meta(): ScenarioMeta {
    return RAG_META;
  }

  private llm: LLM;
  private docs: Doc[];
  /** id → Doc, for grounding lookups by retrieved id. */
  private byId: Map<string, Doc>;

  // ─ state threaded across the four next() calls ─
  /** Retrieve → Reason/Validate: the ranked hits (ids + scores). */
  private hits: ReturnType<typeof rankDocs> = [];
  /** Reason → Validate: the streamed answer text the gate inspects. */
  private answer = '';

  constructor(llm: LLM, docs: Doc[]) {
    super();
    this.llm = llm;
    this.docs = docs;
    this.byId = new Map(docs.map((d) => [d.id, d]));
  }

  protected traceName(): string {
    return 'rag_pipeline';
  }

  reset(): void {
    super.reset();
    this.hits = [];
    this.answer = '';
  }

  protected async runStep(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    switch (stepIndex) {
      case 0:
        return this.retrieve(stepIndex);
      case 1:
        return this.reason(stepIndex, cb);
      default:
        // Stage 3 (and any defensive overflow) is the terminal gate.
        return this.validate(stepIndex);
    }
  }

  // ① RETRIEVE — BM25 rank the planted query. Deterministic, NO model: this is the
  //    teaching beat — retrieval is a pure function, evaluated on its OWN terms
  //    (recall@k / MRR), separate from the answer it later feeds.
  private retrieve(stepIndex: number): StepResult {
    this.trace.spanOpen('retrieve', { query: DEMO_QUERY, k: RETRIEVE_K });

    this.hits = rankDocs(this.docs, DEMO_QUERY, RETRIEVE_K);

    const queryBody = [
      `"${DEMO_QUERY}"`,
      '',
      'BM25 lexical retrieval over the corpus — deterministic, NO model.',
      'BM25 ranks on literal token overlap, so a CPU-cooler buying guide (a',
      'lexical look-alike: right token `cpu`, wrong intent) ranks high alongside',
      'the real saturation runbook. That collision is the lesson — and it is why',
      'retrieval eval (recall@k / MRR) is kept separate from answer eval.',
    ].join('\n');

    // Tag the distractor inline so the collision is legible in the ranked list.
    const distractorIds = new Set(
      this.docs.filter((d) => d.type === 'distractor').map((d) => d.id),
    );
    const hitsBody =
      this.hits.length === 0
        ? '(no documents matched any query term)'
        : this.hits
            .map((h, i) => {
              const doc = this.byId.get(h.id);
              const title = doc?.title ?? '(unknown)';
              const tags: string[] = [];
              if (i === 0) tags.push('top hit');
              if (distractorIds.has(h.id)) tags.push('⚠ lexical distractor');
              if (h.id === 'cpu_saturation_runbook') tags.push('★ the real answer');
              const mark = tags.length ? `   <- ${tags.join(' · ')}` : '';
              return `#${i}  [${h.id}]  ${h.score.toFixed(2)}${mark}\n      ${title}`;
            })
            .join('\n');

    this.trace.step('retrieval', {
      method: 'bm25',
      k: RETRIEVE_K,
      ids: this.hits.map((h) => h.id),
      top: this.hits[0]?.id,
    });
    this.trace.spanClose({ hits: this.hits.length });

    const step = makeStep(stepIndex, 'Retrieve', {
      panels: [
        makePanel('query', codeTitle('Query'), queryBody, 'ctx'),
        makePanel('hits', codeTitle(`Retrieved · top ${RETRIEVE_K}`), hitsBody, 'ctx'),
      ],
    });
    return { step, done: false };
  }

  // ② REASON — the ONE model call. Stream a grounded answer from the top-3 docs'
  //    titles + summaries; the prompt requires a [doc_id] citation. This is the
  //    only step that carries a streaming box.
  private async reason(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    this.trace.spanOpen('reason', { groundingK: GROUNDING_K });

    const grounded = this.groundingDocs();
    const groundingText =
      grounded.length === 0
        ? '(no documents retrieved to ground on)'
        : grounded.map((d) => `[${d.id}] ${d.title}\n  ${d.summary}`).join('\n\n');

    const messages: ChatMsg[] = [
      { role: 'system', content: groundedSystemPrompt() },
      {
        role: 'user',
        content: `Question: ${DEMO_QUERY}\n\nContext documents:\n${groundingText}\n\nAnswer (cite a [doc_id] from the context):`,
      },
    ];

    // The sole streamed LLM box of the whole pipeline.
    const { stream, text } = await runStream({
      llm: this.llm,
      messages,
      label: llmTitle('Answer'),
      kind: 'generation',
      mode: 'stream',
      cb,
      trace: this.trace,
      traceStep: 'generate',
    });
    this.answer = text;

    this.trace.spanClose({ chars: this.answer.length });

    const answerBody = this.answer.trim().length > 0 ? this.answer.trim() : '(model produced no answer)';
    const step = makeStep(stepIndex, 'Reason', {
      // Include the stream in the committed step so the box persists in history —
      // this is what makes "stage ② is the only step with a streaming box" visible.
      streams: [stream],
      panels: [
        makePanel('grounding', codeTitle(`Context · retrieved docs (top ${GROUNDING_K})`), groundingText, 'ctx'),
        makePanel('answer', llmTitle('Answer'), answerBody, 'decide'),
      ],
    });
    return { step, done: false };
  }

  // ③ VALIDATE — the citation gate. Pure function, NO model (degrades gracefully if
  //    the copilot above was empty). Checks, cheapest-first: non-empty, has a
  //    [doc_id] citation, and every cited id was actually retrieved (grounded
  //    provenance — catches a model citing a doc we never surfaced). Terminal step.
  private validate(stepIndex: number): StepResult {
    this.trace.spanOpen('validate');

    const answer = this.answer.trim();
    const nonEmpty = answer.length > 0;
    const cited = extractCitations(this.answer);
    const retrieved = new Set(this.hits.map((h) => h.id));
    const hasCitation = cited.length > 0;
    const ungrounded = cited.filter((id) => !retrieved.has(id));
    const grounded = hasCitation && ungrounded.length === 0;
    const pass = nonEmpty && hasCitation && grounded;
    // Three verdicts (reference generate.py): an empty answer DEGRADES rather than
    // hard-FAILs — the gate distinguishes "model unavailable" from "model wrong".
    const verdict = !nonEmpty ? 'DEGRADED' : pass ? 'PASS' : 'FAIL';

    const reasons: string[] = [
      `1. non-empty answer:      ${nonEmpty ? 'OK' : 'MISSING'}`,
      `2. has [doc_id] citation: ${
        !nonEmpty ? 'SKIPPED' : hasCitation ? `OK — ${cited.map((c) => `[${c}]`).join(', ')}` : 'MISSING'
      }`,
      `3. cited ids retrieved:   ${
        !hasCitation
          ? 'SKIPPED (no citation)'
          : ungrounded.length === 0
            ? 'OK (grounded provenance)'
            : `FAILED — ungrounded: ${ungrounded.map((c) => `[${c}]`).join(', ')}`
      }`,
    ];
    const body = `${verdict}\n\n${reasons.join('\n')}`;

    this.trace.step('gate', {
      verdict,
      pass,
      citations: cited,
      ungrounded,
    });
    this.trace.spanClose({ verdict, pass });

    // Surface the gate firing as a guardrail when it does not cleanly pass.
    const guardrail = verdict === 'PASS' ? undefined : verdict === 'DEGRADED' ? 'degraded' : 'citation_gate';

    const step = makeStep(stepIndex, 'Validate', {
      panels: [makePanel('validation', codeTitle('Validation gate'), body, 'observe')],
      guardrail,
    });
    return { step, done: true };
  }

  /** The top-GROUNDING_K retrieved docs, resolved id → Doc (skips any unknown id). */
  private groundingDocs(): Doc[] {
    const out: Doc[] = [];
    for (const h of this.hits.slice(0, GROUNDING_K)) {
      const d = this.byId.get(h.id);
      if (d) out.push(d);
    }
    return out;
  }
}

/** The grounded-answer system prompt (reference/01 prompts.py): answer ONLY from
 *  context, and cite a doc id so the gate downstream can check provenance. */
function groundedSystemPrompt(): string {
  return [
    'You are an SRE copilot. Answer the engineer’s question using ONLY the context',
    'documents provided below. Be concise (2–4 sentences).',
    'You MUST cite the document you relied on by its id in square brackets, e.g.',
    '[cpu_saturation_runbook]. Only cite ids that appear in the context. If the',
    'context does not contain the answer, say so plainly and cite the closest doc.',
  ].join('\n');
}

/**
 * Pull every cited doc id out of an answer. Captures the contents of each
 * `[...]` span and splits on separators, so `[a, b]` yields both ids. Deduped,
 * first-seen order. This is the gate's parser — kept liberal so a model that cites
 * loosely still gets credit for ids it genuinely names.
 */
function extractCitations(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (const raw of m[1].split(/[\s,;]+/)) {
      const id = raw.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

/** Factory the framework calls. */
export function makeRagScenario(llm: LLM, docs: Doc[]): RagScenario {
  return new RagScenario(llm, docs);
}
