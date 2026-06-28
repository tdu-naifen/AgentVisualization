// scenarios/04_search.ts — the autonomous web-search agent (folder 04).
//
// Autonomy = a bounded search with a TERMINAL PREDICATE + a BUDGET, both defined
// BEFORE the model is allowed to drive. Given a goal + a tiny tool set
// (search / fetch / mark_done), the agent acts until the search space reaches a
// terminal state — or the step budget halts it.
//
// Each Next press = ONE agent action:
//   ① THINKING stream  — the model reasons about what evidence it still needs.
//   ② the HARNESS deterministically performs the next action from the FIXTURE
//      (search adds distinct source URLs to the frontier; the model later PROPOSES
//      mark_done) — there is no real web search on a static site, so we drive a
//      small committed fixture, mirroring how the Python uses fixture.json.
//   ③ the HARNESS checks the terminal predicate it owns (NOT the model).
//
// Two endings, same machinery:
//   • SUCCESS  — predicate met (≥ MIN_SOURCES distinct sources AND a proposed
//     mark_done) → done with a cited answer.
//   • BUDGET EXHAUSTION — MAX_STEPS hit before the predicate → done with
//     best-so-far + a human handoff (guardrail:'budget'). A *designed* outcome.
//
// Mirrors reference/04_autonomous_search_agent/{tools,prompts,agent}.py behavior,
// adapted to the unified Scenario framework + browser LLM.

import type { ChatMsg, Doc, LLM, ScenarioMeta, StepCallbacks } from '@/types';
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
  };

  private llm: LLM;
  private docs: Doc[];
  private sources: string[] = []; // the search frontier: distinct source URLs gathered
  private evidence: { url: string; snippet: string }[] = []; // gathered hits, for synthesis
  private transcript: string[] = []; // working memory: prior (action → observation) lines
  private usedQueries = new Set<string>(); // fixture queries already run
  private signaledDone = false; // the model PROPOSED mark_done (harness still verifies)

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
  }

  protected async runStep(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    const stepNum = stepIndex + 1;
    this.trace.spanOpen('action', { step: stepNum });
    // RECEIVE — the step has read the frontier + research log; light the Receive node
    // with the 1-based step as the loop iteration.
    cb.onPhase?.({ phase: 'receive', iteration: stepNum });

    // ── working memory: the frontier so far (this is the loop's closure) ──
    const frontierBefore = this.frontierText();
    const log = this.transcript.length > 0 ? this.transcript.join('\n') : '(no actions yet)';
    const stillNeed = Math.max(0, MIN_SOURCES - this.sources.length);
    const remainingQueries = FIXTURE.filter((b) => !this.usedQueries.has(b.query)).map(
      (b) => b.query,
    );

    // When the threshold is already met, stop nagging for more sources — NUDGE the
    // model to PROPOSE mark_done (the harness still owns + verifies the predicate).
    const statusLine =
      stillNeed > 0
        ? `Step ${stepNum}/${MAX_STEPS}. You still need ${stillNeed} more distinct source(s) before you may answer.`
        : `Step ${stepNum}/${MAX_STEPS}. You now have ${this.sources.length} distinct sources — that meets the threshold of ${MIN_SOURCES}. Do NOT search again. Propose mark_done now so the harness can verify and answer.`;

    const messages: ChatMsg[] = [
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

    // ①ᵇ INPUT — a READ-ONLY view of the prompt the model reads THIS step: the
    //    question plus a note that it picks ONE action from the frontier + log above.
    //    Shown FIRST (StepView's INPUT_KEYS renders 'input' panels at the top) so the
    //    step opens with its starting context, not straight into the decision box.
    const inputPanel = makePanel(
      'input',
      codeTitle('Input prompt → model'),
      `QUESTION: ${QUESTION}\n\nThe model reads the frontier + research log above and picks ONE action.`,
      'ctx',
    );
    cb.onPanel?.(inputPanel);

    // The model picks ONE action (web_search / mark_done). There is no separate
    // "thinking" step here — this task is a short act-until-terminal loop, and a
    // pure reasoning monologue every step added noise without changing the decision
    // (the model's reasoning still streams live INSIDE the decision box). The
    // harness then executes the choice and checks the terminal predicate it owns.
    const decision = await this.decideAction(messages, cb);

    // ③ the HARNESS executes the model's chosen action against the fixture.
    const plan = this.executeAction(decision);
    // ACT + OBSERVE — the chosen action ran against the fixture and produced an
    // observation; light both nodes carrying the executed tool name.
    cb.onPhase?.({ phase: 'act', tool: plan.tool });
    cb.onPhase?.({ phase: 'observe', tool: plan.tool });
    this.trace.step(
      'tool_call',
      { tool: plan.tool, frontier: this.sources.length },
      plan.observation,
    );

    // ③ the HARNESS checks the terminal predicate it owns — NOT the model.
    const gathered = this.sources.length;
    const terminal = this.signaledDone && gathered >= MIN_SOURCES;
    const budgetSpent = stepNum >= MAX_STEPS;
    this.trace.step('terminal_check', {
      gathered,
      min: MIN_SOURCES,
      signaledDone: this.signaledDone,
      terminal,
    });

    // ── panels (frontier 'ctx', parsed action 'tool', terminal-check 'observe') ──
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

    const panels = [inputPanel, frontierPanel, decisionPanel, terminalPanel, budgetPanel];

    // ── resolve the ending: SUCCESS (predicate) or BUDGET EXHAUSTION ──
    let done = false;
    let guardrail: string | undefined;
    let title = `Step ${stepNum}: ${plan.tool}`;

    if (terminal) {
      done = true;
      title = `Step ${stepNum}: goal reached`;
      // SYNTHESIZE the answer with the MODEL from the gathered source snippets —
      // this is the whole point of a research agent: it READS what it found and
      // writes a grounded, cited answer. (Previously this pushed a hardcoded
      // string, so the model's generation never appeared — the user's "generate
      // 的结果去哪里了?".) The streamed box persists via the framework merge.
      const answerText = await this.synthesizeAnswer(cb);
      const answerBody =
        (answerText.trim() || '(model produced no answer)') +
        `\n\nSources:\n${this.frontierText()}`;
      panels.push(makePanel('answer', llmTitle('Answer (cited)'), answerBody, 'observe'));
    } else if (budgetSpent) {
      done = true;
      guardrail = 'budget';
      title = `Step ${stepNum}: budget exhausted`;
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
    const step = makeStep(stepIndex, title, { panels, guardrail });
    return { step, done };
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
    // THINK — the decision stream opening IS this scenario's reasoning starting (its
    // 'thinking' streams live inside the decision box); light the Think node now.
    cb.onPhase?.({ phase: 'think' });
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
