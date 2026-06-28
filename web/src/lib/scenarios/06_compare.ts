// scenarios/06_compare.ts — Pipeline vs Agent (folder 06): the SAME task solved
// twice, measured side by side, so "pipeline or agent?" stops being an argument
// from taste and becomes a claim you can defend with numbers.
//
// The task (golden row g002): the rare-id SRE question "error E1342 on shard
// restart" → a cited root cause + fix. A closed, gradeable question BOTH
// architectures can solve over the SAME corpus and index — so the only thing that
// varies is who owns the control flow:
//   • PIPELINE — control flow FIXED in code: retrieve → synthesize → validate,
//     always, in that order. The model supplies judgment at ONE known point
//     (synthesis). Constant cost: 1 LLM call.
//   • AGENT — control flow DECIDED by the model, one step at a time: it re-plans
//     each turn (search → inspect → read → … → mark_done). The model supplies
//     judgment AND control. Variable cost: more calls, data-dependent.
//
// This is the framework's ONE dual-track scenario, but the UI renders a single
// current step at a time — so we convey "side by side" by running the WHOLE
// pipeline track first (steps 1–3), then the agent track (steps 4–5), then a
// terminal COMPARISON step (6) that lays the two measurements next to each other.
// Each track's panels carry a distinct key prefix ('pipeline_' / 'agent_') so a
// future UI could split them into two columns without touching this file.
//
// Mirrors reference/06_pipeline_vs_agent/{pipeline,agent,measure,run}.py, adapted
// to the unified Scenario framework + browser LLM. The headline trade-off TABLE in
// the final step reports the reference harness's measured run (N=3×, where
// predictability becomes observable at all); the per-step panels show THIS demo's
// own live call counts, which we abbreviate to keep the walk-through short.

import type { ChatMsg, Doc, LLM, ScenarioMeta, StepCallbacks, ToolCall } from '@/types';
import {
  BaseScenario,
  codeTitle,
  llmTitle,
  makePanel,
  makeStep,
  runDecide,
  runStream,
  type StepResult,
} from '@/lib/scenarioBase';
import { rankDocs } from '@/lib/retrieval';
import { CorpusTools } from '@/lib/tools';

// ─── the shared task (golden g002) ────────────────────────────────────────────

/** The rare-id question both architectures answer — BM25's strength (the exact
 *  code E1342 is a token a dense model would smear). reference/.../common.py. */
const TASK_QUERY = 'error E1342 on shard restart';
const TASK_ID = 'g002';
/** The golden root cause + fix the graders check both answers against. */
const GOLDEN_ANSWER =
  'E1342 means an unclean WAL tail blocks shard replay after restart; quarantine ' +
  'the shard, truncate the WAL to the last checkpoint, and restart.';

/** Retrieval window (recall@k) and how many docs ground the synthesis prompt. */
const RETRIEVE_K = 5;
const GROUNDING_K = 3;

// The pipeline's three FIXED stages and the agent's planned loop. The agent loop
// would also fire get_doc_summary + mark_done in a full run (~4 calls); we stream
// the two most informative turns (search, read) live and note the rest.
const PIPELINE_STAGES = ['retrieve', 'synthesize', 'validate'] as const;

/** Agent guardrail: cap the autonomous loop so it provably halts even if the
 *  model never marks done. The whole point is the agent is VARIABLE — but bounded. */
const AGENT_MAX_TURNS = 6;

interface MetricRow {
  metric: string;
  pipeline: string;
  agent: string;
  reading: string;
}

const PUNCHLINE =
  'The agent spent more calls for the SAME answer. Capability you don’t use ' +
  'is pure cost. Default to a pipeline; pay for an agent only on steps that ' +
  'genuinely need open-ended exploration.';

export class CompareScenario extends BaseScenario {
  // `meta` as a class FIELD is safe: BaseScenario creates its trace LAZILY (first
  // `this.trace` access in runStep), never in the constructor — so the field is
  // initialized by the time anything reads it.
  readonly meta: ScenarioMeta = {
    id: '06_compare',
    title: 'Pipeline vs Agent',
    subtitle: 'same task, two architectures, measured',
  };

  private llm: LLM;
  private docs: Doc[];
  /** id → Doc, for grounding lookups + the agent's "read" turn. */
  private byId: Map<string, Doc>;

  // ─ state threaded across the next() calls ─
  /** Shared retrieval (both tracks rank the SAME query over the SAME index). */
  private hits: ReturnType<typeof rankDocs> = [];
  /** The pipeline's single synthesized answer (the validate gate inspects it). */
  private pipelineAnswer = '';
  /** Live LLM-call counters per track — shown in panels (FIXED 1 vs VARIABLE). */
  private pipelineLlmCalls = 0;
  private agentLlmCalls = 0;
  /** The agent track owns a REAL CorpusTools instance + transcript (like folder 02). */
  private agentTools: CorpusTools;
  private agentTranscript: string[] = [];
  private agentSteps = 0; // how many real agent turns have run
  private agentDone = false; // the model called mark_done
  /** which phase we're in: pipeline (0..2) → agent (variable) → comparison. */
  private phase: 'pipeline' | 'agent' | 'compare' = 'pipeline';

  constructor(llm: LLM, docs: Doc[]) {
    super();
    this.llm = llm;
    this.docs = docs;
    this.byId = new Map(docs.map((d) => [d.id, d]));
    this.agentTools = new CorpusTools(docs, { maxCalls: AGENT_MAX_TURNS + 4 });
  }

  protected traceName(): string {
    return 'pipeline_vs_agent';
  }

  reset(): void {
    super.reset();
    this.hits = [];
    this.pipelineAnswer = '';
    this.pipelineLlmCalls = 0;
    this.agentLlmCalls = 0;
    this.agentTools = new CorpusTools(this.docs, { maxCalls: AGENT_MAX_TURNS + 4 });
    this.agentTranscript = [];
    this.agentSteps = 0;
    this.agentDone = false;
    this.phase = 'pipeline';
  }

  protected async runStep(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    // Pipeline track: fixed 3 stages (steps 0,1,2).
    if (stepIndex === 0) return this.pipelineRetrieve(stepIndex);
    if (stepIndex === 1) return this.pipelineSynthesize(stepIndex, cb);
    if (stepIndex === 2) {
      const r = this.pipelineValidate(stepIndex);
      this.phase = 'agent';
      return r;
    }
    // Agent track: a REAL decide() loop, variable length, until mark_done or cap.
    if (this.phase === 'agent' && !this.agentDone && this.agentSteps < AGENT_MAX_TURNS) {
      return this.agentTurn(stepIndex, cb);
    }
    // Comparison (terminal).
    return this.compare(stepIndex);
  }

  // ═══════════════════════════ PIPELINE TRACK ═════════════════════════════════

  // ① PIPELINE · RETRIEVE — rank k docs for the planted query. NO model: the
  //    control flow is FIXED in code — the engineer decided "retrieve first" at
  //    design time, so this step never varies run to run.
  private pipelineRetrieve(stepIndex: number): StepResult {
    this.trace.spanOpen('compare_step', { step: stepIndex, track: 'pipeline', stage: 'retrieve' });

    this.hits = rankDocs(this.docs, TASK_QUERY, RETRIEVE_K);
    const hitsBody =
      this.hits.length === 0
        ? '(no documents matched any query term)'
        : this.hits
            .map((h, i) => {
              const title = this.byId.get(h.id)?.title ?? '(unknown)';
              const mark = i === 0 ? '   <- top hit' : '';
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

    const planBody = [
      `task (golden ${TASK_ID}): "${TASK_QUERY}"`,
      '',
      `PIPELINE · stage 1/3 — fixed plan: ${PIPELINE_STAGES.join(' → ')}`,
      'control flow FIXED in code: the engineer chose these steps at design time,',
      'so every run takes the exact same path. This stage uses NO model — BM25',
      `retrieves k=${RETRIEVE_K} docs (the rare code E1342 is exactly where lexical`,
      'retrieval shines). LLM calls so far: 0.',
    ].join('\n');

    const step = makeStep(stepIndex, 'Pipeline · Retrieve', {
      panels: [
        makePanel('pipeline_plan', codeTitle('Pipeline plan'), planBody, 'ctx'),
        makePanel('pipeline_retrieve', codeTitle(`Retrieved · top ${RETRIEVE_K}`), hitsBody, 'ctx'),
      ],
    });
    return { step, done: false };
  }

  // ② PIPELINE · SYNTHESIZE — the ONE model call of the whole pipeline. Stream a
  //    grounded answer from the top-3 docs, required to cite a [doc_id]. This is
  //    the single known point where the pipeline asks the model for JUDGMENT.
  private async pipelineSynthesize(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    this.trace.spanOpen('compare_step', { step: stepIndex, track: 'pipeline', stage: 'synthesize' });

    const grounded = this.groundingDocs();
    const groundingText =
      grounded.length === 0
        ? '(no documents retrieved to ground on)'
        : grounded.map((d) => `[${d.id}] ${d.title}\n  ${d.summary}`).join('\n\n');

    const messages: ChatMsg[] = [
      { role: 'system', content: synthesisSystemPrompt() },
      {
        role: 'user',
        content:
          `Question: ${TASK_QUERY}\n\nContext documents:\n${groundingText}\n\n` +
          'Answer the root cause and the fix, citing a [doc_id] from the context:',
      },
    ];

    const { stream, text } = await runStream({
      llm: this.llm,
      messages,
      label: llmTitle('Pipeline answer'),
      kind: 'generation',
      mode: 'stream',
      cb,
      trace: this.trace,
      traceStep: 'synthesize',
    });
    this.pipelineAnswer = text;
    this.pipelineLlmCalls += 1; // the pipeline's first AND ONLY model call.

    this.trace.spanClose({ chars: this.pipelineAnswer.length, llmCalls: this.pipelineLlmCalls });

    const answerBody = this.pipelineAnswer.trim().length > 0
      ? this.pipelineAnswer.trim()
      : '(model produced no answer)';
    const metaBody = [
      'PIPELINE · stage 2/3 — the ONE model call.',
      `LLM calls so far: ${this.pipelineLlmCalls} (this is the only one).`,
      'one synthesis prompt over the retrieved context — the model supplies',
      'judgment at this single, known point; the code owns everything else.',
    ].join('\n');

    const step = makeStep(stepIndex, 'Pipeline · Synthesize', {
      // Commit the stream into the step so the box persists in history.
      streams: [stream],
      panels: [
        makePanel('pipeline_grounding', codeTitle(`Grounding · top ${GROUNDING_K}`), groundingText, 'ctx'),
        makePanel('pipeline_answer', llmTitle('Pipeline answer'), answerBody, 'decide'),
        makePanel('pipeline_calls', codeTitle('Cost so far'), metaBody, 'decide'),
      ],
    });
    return { step, done: false };
  }

  // ③ PIPELINE · VALIDATE — the citation gate. Pure function, NO model: checks the
  //    answer is non-empty, cites a [doc_id], and that the cited ids were actually
  //    retrieved (grounded provenance). Closes the pipeline track: 1 LLM call,
  //    fixed 3 steps, every run identical → regression-testable.
  private pipelineValidate(stepIndex: number): StepResult {
    this.trace.spanOpen('compare_step', { step: stepIndex, track: 'pipeline', stage: 'validate' });

    const answer = this.pipelineAnswer.trim();
    const nonEmpty = answer.length > 0;
    const cited = extractCitations(this.pipelineAnswer);
    const retrieved = new Set(this.hits.map((h) => h.id));
    const hasCitation = cited.length > 0;
    const ungrounded = cited.filter((id) => !retrieved.has(id));
    const grounded = hasCitation && ungrounded.length === 0;
    const pass = nonEmpty && hasCitation && grounded;
    // An empty answer DEGRADES rather than hard-FAILs (distinguishes "model
    // unavailable" from "model wrong") — same gate semantics as folder 01.
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
    const gateBody = `${verdict}\n\n${reasons.join('\n')}`;

    this.trace.step('gate', { verdict, pass, citations: cited, ungrounded });
    this.trace.spanClose({ verdict, pass });

    const doneBody = [
      'PIPELINE · stage 3/3 — track COMPLETE.',
      `total LLM calls: ${this.pipelineLlmCalls} · fixed ${PIPELINE_STAGES.length} steps, every run identical.`,
      'predictable cost + latency, and pinnable to a regression test — because',
      'there is exactly one path through the code. Next: the agent runs the',
      'SAME task with the model owning the control flow.',
    ].join('\n');

    const guardrail = verdict === 'PASS' ? undefined : verdict === 'DEGRADED' ? 'degraded' : 'citation_gate';

    const step = makeStep(stepIndex, 'Pipeline · Validate', {
      panels: [
        makePanel('pipeline_gate', codeTitle('Validation gate'), gateBody, 'observe'),
        makePanel('pipeline_done', codeTitle('Pipeline done'), doneBody, 'observe'),
      ],
      guardrail,
    });
    return { step, done: false };
  }

  // ═══════════════════════════ AGENT TRACK ════════════════════════════════════

  // AGENT · turn N — a REAL decide() loop (like folder 02). The model THINKS, then
  //    DECIDES a tool (search_corpus / get_doc_summary / get_doc / mark_done), which
  //    the harness EXECUTES against a real CorpusTools. The loop length is VARIABLE
  //    — it runs until the model marks done or hits the cap. This is the honest
  //    contrast to the pipeline's fixed 3 steps: the model owns the control flow.
  private async agentTurn(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    const turn = this.agentSteps; // 0-based
    this.trace.spanOpen('agent_turn', { step: stepIndex, turn });

    const transcriptSoFar = this.agentTranscript.length
      ? this.agentTranscript.map((t, i) => `  step ${i + 1}: ${t}`).join('\n')
      : '  (nothing yet — cold start)';
    const baseMsgs: ChatMsg[] = [
      { role: 'system', content: agentSystemPrompt() },
      {
        role: 'user',
        content:
          `Task (golden ${TASK_ID}): ${TASK_QUERY}\n\n` +
          `History so far:\n${transcriptSoFar}\n\n` +
          'Think about the single best NEXT tool to call to make progress.',
      },
    ];

    // ① THINKING (real, streamed)
    await runStream({
      llm: this.llm,
      messages: baseMsgs,
      label: llmTitle(`Agent thinking · turn ${turn + 1}`),
      kind: 'thinking',
      mode: 'think',
      cb,
      trace: this.trace,
      traceStep: 'agent_think',
    });
    this.agentLlmCalls += 1; // the THINK call

    // ② DECISION (real, schema-validated, streamed) — the model picks the tool.
    let decision: ToolCall;
    try {
      const res = await runDecide({
        llm: this.llm,
        messages: baseMsgs,
        schemaHint: agentDecisionSchemaHint(),
        cb,
        trace: this.trace,
        label: llmTitle(`Agent decision · turn ${turn + 1}`),
      });
      decision = res.decision;
      this.agentLlmCalls += 1; // the DECIDE call (this is why the agent costs more)
    } catch (err) {
      // Honest failure: surface it, end the agent track, move to comparison.
      this.trace.spanClose({ outcome: 'decision_failed' });
      this.agentDone = true;
      const body = `agent decision failed: ${err instanceof Error ? err.message : String(err)}`;
      const step = makeStep(stepIndex, `Agent · turn ${turn + 1} (failed)`, {
        panels: [makePanel('agent_action', codeTitle('Agent decision (failed)'), body, 'tool')],
        guardrail: 'retry',
      });
      return { step, done: false };
    }

    // ③ EXECUTE the model's chosen tool against the REAL CorpusTools.
    const result = this.agentTools.call(decision);
    const observation = `[${result.ok ? 'ok' : 'REFUSED'}] ${result.message}${summarizeData(result.data)}`;
    this.agentTranscript.push(`${decision.tool}(${JSON.stringify(decision.args)}) → ${observation}`);
    this.agentSteps += 1;
    if (decision.tool === 'mark_done') this.agentDone = true;

    this.trace.step(
      'agent_tool_call',
      { turn, tool: decision.tool, ok: result.ok, llmCalls: this.agentLlmCalls },
      JSON.stringify(result.data ?? {}, null, 2),
    );
    this.trace.spanClose({ tool: decision.tool, done: this.agentDone });

    const actionBody = [
      `AGENT · turn ${turn + 1} — the model OWNS the control flow.`,
      '',
      `decided tool: ${decision.tool}(${JSON.stringify(decision.args)})`,
      `observation:  ${observation}`,
      '',
      `LLM calls so far: ${this.agentLlmCalls} (think + decide per turn — VARIABLE).`,
      this.agentDone
        ? 'the model called mark_done — it decided it was finished.'
        : 'the loop continues — the model will re-plan on the next press.',
    ].join('\n');

    const step = makeStep(stepIndex, `Agent · turn ${turn + 1}`, {
      panels: [makePanel('agent_action', codeTitle(`Agent turn ${turn + 1} — parsed`), actionBody, 'tool')],
      guardrail: !result.ok && decision.tool === 'propose_action' ? 'whitelist_blocked' : undefined,
    });
    return { step, done: false };
  }

  // ⑥ COMPARISON — terminal step, NO model. Lay the two tracks' MEASURED counts
  //    side by side: same task, the agent took more LLM calls + more steps to reach
  //    the same place. The numbers come from THIS run, not a reference constant.
  private compare(stepIndex: number): StepResult {
    this.trace.spanOpen('comparison', { step: stepIndex });

    const pipelineSteps = 3;
    const agentToolCalls = this.agentTools.callCount();
    const rows: MetricRow[] = [
      {
        metric: 'who owns control flow',
        pipeline: 'code (fixed)',
        agent: 'model (decides)',
        reading: 'the core difference',
      },
      {
        metric: 'steps',
        pipeline: String(pipelineSteps),
        agent: String(this.agentSteps),
        reading: 'pipeline fixed; agent variable',
      },
      {
        metric: 'LLM calls',
        pipeline: String(this.pipelineLlmCalls),
        agent: String(this.agentLlmCalls),
        reading: 'agent: think + decide each turn',
      },
      {
        metric: 'tool calls',
        pipeline: '0 (pure code)',
        agent: String(agentToolCalls),
        reading: 'agent really drove the tools',
      },
      {
        metric: 'reached the answer',
        pipeline: this.pipelineAnswer.trim() ? 'yes' : 'degraded',
        agent: this.agentDone ? 'yes (marked done)' : 'capped',
        reading: 'same task, same corpus',
      },
    ];
    const tableBody = renderTradeOff(rows);

    const liveBody = [
      'measured on THIS run (live, in your browser — not a reference constant):',
      `  pipeline: ${this.pipelineLlmCalls} LLM call, ${pipelineSteps} fixed steps, 0 tool calls.`,
      `  agent:    ${this.agentLlmCalls} LLM calls, ${this.agentSteps} model-driven turns, ${agentToolCalls} real tool calls.`,
      '',
      'both tracks answered the SAME golden question:',
      `  "${GOLDEN_ANSWER}"`,
    ].join('\n');

    this.trace.step('comparison', {
      pipelineLlmCalls: this.pipelineLlmCalls,
      agentLlmCalls: this.agentLlmCalls,
      agentSteps: this.agentSteps,
      agentToolCalls,
      agentDone: this.agentDone,
    });
    this.trace.spanClose({ done: true });

    const step = makeStep(stepIndex, 'Comparison · the measured verdict', {
      panels: [
        makePanel('agent_compare_table', codeTitle('Measured trade-off (this run, live)'), tableBody, 'observe'),
        makePanel('agent_compare_live', codeTitle('This run'), liveBody, 'observe'),
        makePanel('agent_compare_verdict', codeTitle('Verdict'), PUNCHLINE, 'observe'),
      ],
    });
    return { step, done: true };
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  /** The top-GROUNDING_K retrieved docs, resolved id → Doc (skips unknown ids). */
  private groundingDocs(): Doc[] {
    const out: Doc[] = [];
    for (const h of this.hits.slice(0, GROUNDING_K)) {
      const d = this.byId.get(h.id);
      if (d) out.push(d);
    }
    return out;
  }
}

/** The pipeline's synthesis system prompt: answer ONLY from context, cite a
 *  [doc_id] so the downstream gate can check provenance (reference/01 + 06). */
function synthesisSystemPrompt(): string {
  return [
    'You are an SRE copilot. Using ONLY the context documents below, give the root',
    'cause and the fix for the engineer’s error. Be concise (2–4 sentences).',
    'You MUST cite the document you relied on by its id in square brackets, e.g.',
    '[shard_restart_e1342]. Only cite ids that appear in the context.',
  ].join('\n');
}

/** The agent's autonomous system prompt: the model owns the control flow — it
 *  picks the next tool and decides when to stop (reference/06 agent.py). */
function agentSystemPrompt(): string {
  return [
    'You are an autonomous SRE agent. You own the control flow: each turn, pick the',
    'single best NEXT tool to make progress, then stop. Tools: search_corpus,',
    'get_doc_summary, get_doc, mark_done. Re-plan from what you have seen so far;',
    'call mark_done once you can state the root cause and fix.',
  ].join('\n');
}

/** Schema hint for the agent's decide() — the 4 tools it may call (folder 06). */
function agentDecisionSchemaHint(): string {
  return [
    '{',
    '  "tool": "search_corpus" | "get_doc_summary" | "get_doc" | "mark_done",',
    '  "args": {  // e.g.',
    '    search_corpus -> {"query": string, "k": number},',
    '    get_doc_summary / get_doc -> {"doc_id": string},',
    '    mark_done -> {"result": {"root_cause": string, "remediation": string}}',
    '  }',
    '}',
  ].join('\n');
}

/** Compact a tool result's data payload for the agent's observation line. Like
 *  folder 02's summarizeData, this also decides WHAT THE AGENT REMEMBERS (the
 *  observation is pushed into agentTranscript and handed back next turn). Recording
 *  only "body: N chars" discarded the content the model paid get_doc to read, so the
 *  agent could never conclude and looped — the same stall 02 hit. Surface the REAL
 *  content so the agent track behaves consistently across all multi-turn scenarios. */
function summarizeData(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data !== 'object') return '';
  const rec = data as Record<string, unknown>;

  // search_corpus → id + title per hit (triage by name, not bare id).
  if (Array.isArray(rec.results)) {
    const rows = (rec.results as Array<{ id?: string; title?: string }>)
      .map((r) => (r?.title ? `${r.id} — ${r.title}` : r?.id))
      .filter(Boolean);
    return rows.length ? ` — hits: ${rows.join('; ')}` : '';
  }
  // get_doc → the FULL body (the whole point of the expensive read).
  if (typeof rec.body === 'string') {
    const body = rec.body.trim();
    const title =
      typeof rec.title === 'string' && !body.startsWith('#') ? `# ${rec.title}\n` : '';
    return `\n${title}${body}`;
  }
  // get_doc_summary → clean title + summary.
  if (typeof rec.summary === 'string') {
    const name = (rec.title as string) ?? (rec.id as string) ?? '';
    return ` — ${name}: ${rec.summary}`;
  }
  return '';
}

/** Pull every cited doc id out of an answer: contents of each `[...]` span, split
 *  on separators so `[a, b]` yields both ids. Deduped, first-seen order. Liberal
 *  so a loosely-citing model still gets credit (mirrors folder 01's gate parser). */
function extractCitations(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const spanRe = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = spanRe.exec(text)) !== null) {
    for (const raw of m[1].split(/[,;|\s]+/)) {
      const id = raw.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/** Render the measured trade-off as a fixed-width ASCII table (no UI dependency:
 *  the side-by-side is conveyed by aligned columns + the reading). */
function renderTradeOff(rows: MetricRow[]): string {
  const headers = { metric: 'metric', pipeline: 'pipeline', agent: 'agent', reading: 'reading' };
  const all = [headers, ...rows];
  const w = {
    metric: Math.max(...all.map((r) => r.metric.length)),
    pipeline: Math.max(...all.map((r) => r.pipeline.length)),
    agent: Math.max(...all.map((r) => r.agent.length)),
  };
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
  const line = (r: MetricRow) =>
    `${pad(r.metric, w.metric)} | ${pad(r.pipeline, w.pipeline)} | ${pad(r.agent, w.agent)} | ${r.reading}`;
  const rule =
    `${'-'.repeat(w.metric)}-+-${'-'.repeat(w.pipeline)}-+-${'-'.repeat(w.agent)}-+-${'-'.repeat(7)}`;
  return [line(headers), rule, ...rows.map(line)].join('\n');
}

/** Factory the framework calls. */
export function makeCompareScenario(llm: LLM, docs: Doc[]): CompareScenario {
  return new CompareScenario(llm, docs);
}
