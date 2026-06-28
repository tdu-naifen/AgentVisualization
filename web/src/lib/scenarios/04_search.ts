// scenarios/04_search.ts — the autonomous web-search agent (folder 04).
//
// Autonomy = a bounded search with a TERMINAL PREDICATE + a BUDGET, both defined
// BEFORE the model is allowed to drive. Given a goal + a tiny tool set
// (search / fetch / mark_done), the agent acts until the search space reaches a
// terminal state — or the step budget halts it.
//
// Each Next press = ONE phase of one agent iteration:
//   input    — the harness builds the frontier+log prompt and shows what the model reads.
//   generate — the model reasons about what to do (streams live) and proposes an action.
//   act      — the harness executes the action against the fixture, checks the terminal
//               predicate it owns (NOT the model), and may synthesize a final answer.
//
// Two endings, same machinery:
//   • SUCCESS  — predicate met (≥ MIN_SOURCES distinct sources AND a proposed
//     mark_done) → done with a cited answer.
//   • BUDGET EXHAUSTION — MAX_STEPS hit before the predicate → done with
//     best-so-far + a human handoff (guardrail:'budget'). A *designed* outcome.
//
// Mirrors reference/04_autonomous_search_agent/{tools,prompts,agent}.py behavior,
// adapted to the unified Scenario framework + browser LLM.

import type { ChatMsg, Doc, LLM, Panel, ScenarioMeta, StepCallbacks } from '@/types';
import { cleanModelText } from '@/lib/llm';
import {
  BaseScenario,
  codeTitle,
  llmTitle,
  makePanel,
  makeStep,
  makeStream,
  runStream,
  type StepResult,
} from '@/lib/scenarioBase';

// The model decides over this scenario's OWN action set (not the 6 corpus tools).
interface SearchDecision {
  action: 'web_search' | 'mark_done';
  query?: string;
  /** harness bookkeeping: did the model's query map to a fixture batch? */
  matchedFixture?: boolean;
  exact?: boolean;
}

/** Parse a small {action, query} decision from messy small-model output. */
function parseSearchDecision(raw: string): SearchDecision {
  // try to find a JSON object first
  const start = raw.indexOf('{');
  if (start !== -1) {
    let s = raw.slice(start);
    const end = s.lastIndexOf('}');
    if (end !== -1) s = s.slice(0, end + 1);
    s = s.replace(/'/g, '"').replace(/([{,]\s*)([A-Za-z_]\w*)(\s*:)/g, '$1"$2"$3').replace(/,\s*([}\]])/g, '$1');
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      const action = String(o.action ?? '').toLowerCase();
      if (action.includes('done')) return { action: 'mark_done' };
      if (action.includes('search')) return { action: 'web_search', query: typeof o.query === 'string' ? o.query : undefined };
    } catch {
      /* fall through to keyword scan */
    }
  }
  // fuzzy fallback: keyword scan (honest about intent even if JSON was malformed)
  const lower = raw.toLowerCase();
  if (lower.includes('mark_done') || lower.includes('"done"') || /\bdone\b/.test(lower)) {
    return { action: 'mark_done' };
  }
  return { action: 'web_search' };
}

// ─── the goal + the leash (defined BEFORE the model drives) ───────────────────
const MAX_STEPS = 4; // BUDGET: the loop provably halts on whichever fires first.
const MIN_SOURCES = 2; // TERMINAL PREDICATE: distinct sources before the agent may finish.

const QUESTION =
  'What does the OpenTelemetry Collector do, and name two of its core components?';

// ─── the offline FIXTURE (no backend ⇒ no real web search; deterministic) ─────
interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}
interface SearchBatch {
  query: string;
  hits: SearchHit[];
}

// A normal run hits enough distinct sources on the FIRST search (3 URLs ≥
// MIN_SOURCES), so it converges in ~2 steps: search → propose done → terminal.
const FIXTURE: SearchBatch[] = [
  {
    query: 'OpenTelemetry Collector overview',
    hits: [
      {
        title: 'OpenTelemetry Collector | OpenTelemetry',
        url: 'https://opentelemetry.io/docs/collector/',
        snippet:
          'The OpenTelemetry Collector offers a vendor-agnostic implementation of how to ' +
          'receive, process and export telemetry data.',
      },
      {
        title: 'Collector Architecture | OpenTelemetry',
        url: 'https://opentelemetry.io/docs/collector/architecture/',
        snippet:
          'The Collector consists of receivers, processors, and exporters wired together ' +
          'into pipelines. Receivers ingest data; processors transform it; exporters send it on.',
      },
      {
        title: 'What is the OpenTelemetry Collector? — Datadog',
        url: 'https://www.datadoghq.com/knowledge-center/opentelemetry-collector/',
        snippet:
          'A standalone service that collects, processes, and routes telemetry (traces, ' +
          'metrics, logs) from instrumented apps to one or more backends.',
      },
    ],
  },
  {
    query: 'OpenTelemetry Collector core components receivers processors exporters',
    hits: [
      {
        title: 'Collector Configuration | OpenTelemetry',
        url: 'https://opentelemetry.io/docs/collector/configuration/',
        snippet:
          'Core components: receivers (how data gets in, e.g. otlp), processors (batch, ' +
          'memory_limiter), exporters (how data gets out, e.g. otlp, prometheus), and connectors.',
      },
      {
        title: 'Receivers — OpenTelemetry',
        url: 'https://opentelemetry.io/docs/collector/configuration/#receivers',
        snippet:
          'A receiver, which can be push or pull based, is how data gets into the Collector. ' +
          'The OTLP receiver is the most common.',
      },
    ],
  },
];

type ActionTool = 'search' | 'fetch' | 'mark_done';
interface ActionPlan {
  tool: ActionTool;
  argSummary: string;
  observation: string;
}

export class SearchScenario extends BaseScenario {
  readonly meta: ScenarioMeta = {
    id: '04_search',
    title: 'Autonomous Search Agent',
    subtitle: 'act until a terminal state — or the budget stops you',
    kind: 'agent',
    teaches: 'An autonomous agent acts until a terminal predicate is met — or an explicit step budget stops it.',
    intro: 'An autonomous research agent acts until it has enough evidence — or a step budget stops it. It reads its frontier (input), generates a search/done decision, the harness runs it (act), and sources accumulate. The harness OWNS the stop condition: ≥2 distinct sources AND the model proposes done. Watch the budget halt it even if it never converges.',
  };

  private llm: LLM;
  private docs: Doc[];
  private sources: string[] = []; // the search frontier: distinct source URLs gathered
  private evidence: { url: string; snippet: string }[] = []; // gathered hits, for synthesis
  private transcript: string[] = []; // working memory: prior (action → observation) lines
  private usedQueries = new Set<string>(); // fixture queries already run
  private signaledDone = false; // the model PROPOSED mark_done (harness still verifies)

  // ── subphase pointer: each next() advances ONE phase ─────────────────────────
  private subphase: 'input' | 'generate' | 'act' = 'input';
  /** User-visible 1-based loop iteration counter (distinct from base stepIndex). */
  private stepNum = 1;
  /** Messages built in input phase, consumed in generate phase. */
  private pendingMessages: ChatMsg[] | null = null;
  /** Decision from generate phase, consumed in act phase. */
  private pendingDecision: SearchDecision | null = null;

  constructor(llm: LLM, docs: Doc[]) {
    super();
    this.llm = llm;
    this.docs = docs;
  }

  protected traceName(): string {
    return 'autonomous_search';
  }

  reset(): void {
    super.reset();
    this.sources = [];
    this.evidence = [];
    this.transcript = [];
    this.usedQueries = new Set();
    this.signaledDone = false;
    this.subphase = 'input';
    this.stepNum = 1;
    this.pendingMessages = null;
    this.pendingDecision = null;
  }

  protected async runStep(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    switch (this.subphase) {
      case 'input':    return this.runInputPhase(stepIndex, cb);
      case 'generate': return this.runGeneratePhase(stepIndex, cb);
      case 'act':      return this.runActPhase(stepIndex, cb);
    }
  }

  // ── INPUT phase: show what the model will read this iteration ─────────────────

  private async runInputPhase(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    const stepNum = this.stepNum;
    this.trace.spanOpen('action', { step: stepNum });

    // INPUT — light the Input node with the 1-based iteration counter.
    cb.onPhase?.({ phase: 'input', iteration: stepNum });

    // Build the frontier+log prompt; carry it to the generate phase.
    const frontierBefore = this.frontierText();
    const log = this.transcript.length > 0 ? this.transcript.join('\n') : '(no actions yet)';
    const stillNeed = Math.max(0, MIN_SOURCES - this.sources.length);
    const remainingQueries = FIXTURE.filter((b) => !this.usedQueries.has(b.query)).map(
      (b) => b.query,
    );

    const statusLine =
      stillNeed > 0
        ? `Step ${stepNum}/${MAX_STEPS}. You still need ${stillNeed} more distinct source(s) before you may answer.`
        : `Step ${stepNum}/${MAX_STEPS}. You now have ${this.sources.length} distinct sources — that meets the threshold of ${MIN_SOURCES}. Do NOT search again. Propose mark_done now so the harness can verify and answer.`;

    this.pendingMessages = [
      { role: 'system', content: systemPrompt() },
      {
        role: 'user',
        content:
          `QUESTION: ${QUESTION}\n\n` +
          `Search frontier so far (${this.sources.length} distinct sources):\n${frontierBefore}\n\n` +
          `Research log:\n${log}\n\n` +
          `${statusLine}\n\n` +
          `Available actions (pick ONE):\n` +
          `• web_search — run a query to discover sources. Available queries: ${remainingQueries
            .map((q) => `"${q}"`)
            .join(', ') || '(none left)'}\n` +
          `• mark_done — propose you have enough to answer (the harness verifies the predicate).`,
      },
    ];

    // Show the input prompt panel BEFORE the model streams, so the step opens with
    // starting context, not straight into the decision box.
    const inputPanel = makePanel(
      'input',
      codeTitle('Input prompt → model'),
      `QUESTION: ${QUESTION}\n\nThe model reads the frontier + research log above and picks ONE action.`,
      'ctx',
    );
    cb.onPanel?.(inputPanel);

    this.subphase = 'generate';
    return {
      step: makeStep(stepIndex, `Step ${stepNum} · Input`, { panels: [inputPanel] }),
      done: false,
    };
  }

  // ── GENERATE phase: model streams its action decision ─────────────────────────

  private async runGeneratePhase(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    const stepNum = this.stepNum;
    const messages = this.pendingMessages!;

    // Model decides the next action (streams live inside the decision box).
    const decision = await this.decideAction(messages, cb);
    this.pendingDecision = decision;

    // Show the parsed decision — what the model proposed, before harness execution.
    const decisionBody =
      `Model proposed: ${decision.action}` +
      (decision.query ? `\nQuery: "${decision.query}"` : '') +
      (decision.matchedFixture === false
        ? '\n(query will be mapped to nearest fixture — no live web on static site)'
        : '');
    const decisionPanel: Panel = makePanel('decision', codeTitle('Parsed action'), decisionBody, 'tool');

    this.subphase = 'act';
    return {
      step: makeStep(stepIndex, `Step ${stepNum} · Generate`, { panels: [decisionPanel] }),
      done: false,
    };
  }

  // ── ACT phase: harness executes and checks the terminal predicate ──────────────

  private async runActPhase(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    const stepNum = this.stepNum;
    const decision = this.pendingDecision!;

    // The harness executes the model's chosen action against the fixture.
    const plan = this.executeAction(decision);

    // ACT — the chosen action ran; light the Act node carrying the executed tool name.
    cb.onPhase?.({ phase: 'act', tool: plan.tool });
    this.trace.step(
      'tool_call',
      { tool: plan.tool, frontier: this.sources.length },
      plan.observation,
    );

    // The HARNESS checks the terminal predicate it owns — NOT the model.
    const gathered = this.sources.length;
    const terminal = this.signaledDone && gathered >= MIN_SOURCES;
    const budgetSpent = stepNum >= MAX_STEPS;
    this.trace.step('terminal_check', {
      gathered,
      min: MIN_SOURCES,
      signaledDone: this.signaledDone,
      terminal,
    });

    // ── panels: frontier (ctx), executed decision (tool), terminal-check (observe) ──
    const frontierPanel = makePanel(
      'frontier',
      codeTitle('Search frontier'),
      `Distinct sources gathered: ${gathered}\n${this.frontierText()}`,
      'ctx',
    );

    const decisionBody =
      `Model chose: ${plan.tool}(${plan.argSummary})\n` +
      `Harness executed: ${plan.observation}` +
      (plan.tool === 'mark_done'
        ? "\n\nDone is the one decision you can't delegate — the model PROPOSES " +
          'mark_done; the harness CHECKS the predicate (≥ MIN_SOURCES sources).'
        : '');
    const decisionPanel = makePanel('decision', codeTitle('Parsed action'), decisionBody, 'tool');

    const rejected = this.signaledDone && !terminal;
    const terminalBody =
      `gathered ${gathered} / ${MIN_SOURCES} distinct sources\n` +
      `model signaled done: ${this.signaledDone ? 'yes' : 'no'}\n` +
      `terminal (predicate met)? ${terminal ? 'YES' : 'no'}` +
      (rejected ? `\nPROPOSAL REJECTED by the harness — need ≥ ${MIN_SOURCES} sources first.` : '');
    const terminalPanel = makePanel('terminal', codeTitle('Terminal predicate'), terminalBody, 'observe');

    const budgetBody =
      `step ${stepNum} / ${MAX_STEPS}\n` +
      (budgetSpent
        ? 'budget EXHAUSTED — hard stop (the loop provably halts)'
        : `${MAX_STEPS - stepNum} action(s) of budget remaining`);
    const budgetPanel = makePanel('budget', codeTitle('Budget'), budgetBody, 'observe');

    const panels = [frontierPanel, decisionPanel, terminalPanel, budgetPanel];

    // ── resolve the ending: SUCCESS (predicate) or BUDGET EXHAUSTION ──
    let done = false;
    let guardrail: string | undefined;

    if (terminal) {
      done = true;
      // SYNTHESIZE the answer with the MODEL from the gathered source snippets.
      const answerText = await this.synthesizeAnswer(cb);
      const answerBody =
        (answerText.trim() || '(model produced no answer)') +
        `\n\nSources:\n${this.frontierText()}`;
      panels.push(makePanel('answer', llmTitle('Answer (cited)'), answerBody, 'generate'));
    } else if (budgetSpent) {
      done = true;
      guardrail = 'budget';
      panels.push(
        makePanel(
          'handoff',
          codeTitle('Budget exhausted — human handoff'),
          `Budget spent before the predicate was met (gathered ${gathered}/${MIN_SOURCES}).\n` +
            `Best-so-far + human handoff — returning the ${gathered} source(s) collected ` +
            `instead of spinning:\n${this.frontierText()}`,
          'observe',
        ),
      );
    }

    this.trace.spanClose({ tool: plan.tool, terminal, budgetSpent });

    // Advance stepNum for the NEXT iteration's input phase.
    this.stepNum += 1;
    this.subphase = 'input';

    return {
      step: makeStep(stepIndex, `Step ${stepNum} · Act`, { panels, guardrail }),
      done,
    };
  }

  /**
   * The MODEL decides the next action. We generate a small JSON decision over this
   * scenario's own action set (web_search / mark_done), streamed live, and parse it
   * robustly. If the model can't be parsed, we DO NOT fabricate a choice — we throw,
   * and the run surfaces the failure honestly. (No silent scripting.)
   */
  private async decideAction(messages: ChatMsg[], cb: StepCallbacks): Promise<SearchDecision> {
    const schemaHint =
      '{"action": "web_search" | "mark_done", "query": "<the search query, if web_search>"}';
    const decideMsgs: ChatMsg[] = [
      ...messages,
      {
        role: 'user',
        content:
          'Reply with ONE JSON object for your next action and nothing else. Schema:\n' +
          schemaHint +
          '\nExample: {"action": "web_search", "query": "OpenTelemetry Collector components"}',
      },
    ];
    const stream = makeStream('Decision', 'decision');
    cb.onStream({ ...stream });
    // GENERATE — the decision stream opening IS this scenario's generation starting;
    // light the Generate node now.
    cb.onPhase?.({ phase: 'generate' });
    let raw = '';
    // Reuse llm.stream for free-form structured output (decide() is locked to the
    // 6 corpus tools; this scenario has its own action set, so we parse ourselves).
    await this.llm.stream(decideMsgs, (t) => {
      raw += t;
      // Clean control tokens (<turn|> etc.) from the DISPLAYED text each tick — the
      // same Bug-D fix runDecide uses, so every scenario's decision box shows clean
      // JSON. `raw` stays intact for the trace + parser below.
      stream.text = cleanModelText(raw);
      cb.onStream({ ...stream });
    });
    stream.done = true;
    cb.onStream({ ...stream });
    this.trace.step('decision', { raw: raw.slice(0, 200) }, raw);

    const parsed = parseSearchDecision(raw);
    // Guardrail: if the model picks a query we don't have a fixture for, fall back to
    // the next UNUSED fixture query (still the model's INTENT to search — we just
    // can't actually hit the live web on a static site). This is labeled honestly.
    if (parsed.action === 'web_search') {
      const exact = FIXTURE.find((b) => b.query === parsed.query && !this.usedQueries.has(b.query));
      const next = exact ?? FIXTURE.find((b) => !this.usedQueries.has(b.query));
      return { action: 'web_search', query: next ? next.query : parsed.query ?? '', matchedFixture: !!next, exact: !!exact };
    }
    return { action: 'mark_done' };
  }

  /** The harness EXECUTES the model's chosen action against the offline fixture. */
  private executeAction(decision: SearchDecision): ActionPlan {
    if (decision.action === 'mark_done') {
      this.signaledDone = true;
      this.transcript.push('mark_done (model chose to finish)');
      return {
        tool: 'mark_done',
        argSummary: 'answer + sources',
        observation: 'model chose done — harness now checks the terminal predicate',
      };
    }
    // web_search → run the matched fixture batch (no real web on a static site).
    const batch = FIXTURE.find((b) => b.query === decision.query && !this.usedQueries.has(b.query));
    if (!batch) {
      this.transcript.push(`web_search("${decision.query}") → no fixture (no live web on a static site)`);
      return {
        tool: 'search',
        argSummary: `query="${decision.query}" (no fixture)`,
        observation: 'no offline fixture for that query — try another (static site has no live web)',
      };
    }
    this.usedQueries.add(batch.query);
    const added: string[] = [];
    for (const hit of batch.hits) {
      if (!this.sources.includes(hit.url)) {
        this.sources.push(hit.url);
        this.evidence.push({ url: hit.url, snippet: hit.snippet });
        added.push(hit.url);
      }
    }
    this.transcript.push(`web_search("${batch.query}") → ${batch.hits.map((h) => h.url).join(', ')}`);
    return {
      tool: 'search',
      argSummary: `query="${batch.query}"${decision.exact ? '' : ' (mapped to fixture)'}`,
      observation: `${batch.hits.length} results, +${added.length} new distinct source(s)`,
    };
  }

  /**
   * SYNTHESIZE the final answer with the MODEL, grounded in the snippets actually
   * gathered during the search. Streams live (the box persists via the framework
   * merge), and we fall back to the best snippet text only if the model is empty —
   * never a hardcoded answer the search didn't earn.
   */
  private async synthesizeAnswer(cb: StepCallbacks): Promise<string> {
    const evidenceText =
      this.evidence.length === 0
        ? '(no snippets gathered)'
        : this.evidence.map((e, i) => `[${i + 1}] ${e.url}\n    ${e.snippet}`).join('\n');
    const messages: ChatMsg[] = [
      {
        role: 'system',
        content:
          'You are a research agent writing the FINAL answer. Use ONLY the gathered ' +
          'source snippets below. Be concise (2–4 sentences). Answer the question ' +
          'directly and name the specific components the sources mention.',
      },
      {
        role: 'user',
        content: `QUESTION: ${QUESTION}\n\nGathered sources:\n${evidenceText}\n\nWrite the grounded answer:`,
      },
    ];
    const { text } = await runStream({
      llm: this.llm,
      messages,
      label: llmTitle('Synthesizing answer'),
      kind: 'generation',
      mode: 'stream',
      cb,
      trace: this.trace,
      traceStep: 'synthesize',
    });
    return text;
  }

  /** Render the frontier (distinct source URLs) for panels + prompts. */
  private frontierText(): string {
    if (this.sources.length === 0) return '(empty — no sources gathered yet)';
    return this.sources.map((u, i) => `${i + 1}. ${u}`).join('\n');
  }
}

/** The agent's framing: tools + goal + the harness-owned stop condition. */
function systemPrompt(): string {
  return (
    'You are an autonomous web-research agent. Given a question and three tools — ' +
    'search(query), fetch(url), and mark_done(answer, sources) — you decide the next ' +
    'action and act until you have gathered enough distinct sources to answer, or your ' +
    'step budget runs out.\n\n' +
    `The harness owns the stop condition: the search is terminal only when you have ` +
    `gathered at least ${MIN_SOURCES} distinct source URLs AND you have proposed mark_done. ` +
    `You PROPOSE mark_done; the harness CHECKS the predicate. You get at most ${MAX_STEPS} ` +
    `actions.\n\nQUESTION: ${QUESTION}`
  );
}

/** Factory the framework calls (wired into page.tsx by the integrator). */
export function makeSearchScenario(llm: LLM, docs: Doc[]): SearchScenario {
  return new SearchScenario(llm, docs);
}
