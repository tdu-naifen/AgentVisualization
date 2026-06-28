// scenarios/02_agent.ts — the classic auto-RAG agent loop (folder 02).
//
// Each Next press = ONE subphase of the agent loop:
//   input    — build context + input panel (working memory read)
//   think    — stream Gemma native reasoning
//   generate — structured tool call (schema-validated, retried on failure)
//   act      — execute the tool → observation panel; terminal: conclusion
//
// 4 Next presses = 1 iteration. Terminates on mark_done or maxSteps.
// Guardrails (whitelist refusal, budget cap, dry-run, terminal) are enforced
// inside CorpusTools and surfaced via panels/trace.
//
// Mirrors reference/02_auto_rag_agent/{agent,prompts,tools}.py behavior, adapted
// to the unified Scenario framework + browser LLM.

import type { ChatMsg, Doc, LLM, ScenarioMeta, StepCallbacks, ToolCall } from '@/types';
import { CorpusTools } from '@/lib/tools';
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
import {
  INCIDENT_QUESTION,
  buildContext,
  conclusionSystemPrompt,
  conclusionUserPrompt,
  decideInstruction,
  decisionSchemaHint,
  systemPrompt,
  thinkingInstruction,
  thinkingSystemPrompt,
} from '@/lib/prompts';
import type { StepView } from '@/types';

/** Canonical signature of a tool call (tool + sorted args) for duplicate detection. */
export function toolCallSignature(tc: ToolCall): string {
  const args = tc.args ?? {};
  const keys = Object.keys(args).sort();
  const norm = keys.map((k) => `${k}=${JSON.stringify(args[k])}`).join('&');
  return `${tc.tool}(${norm})`;
}

const MAX_STEPS = 6;

export class AgentScenario extends BaseScenario {
  readonly meta: ScenarioMeta = {
    id: '02_agent',
    title: 'Auto-RAG Agent',
    subtitle: 'input → think → generate → act, one step at a time',
    intro:
      'A tool-using agent solves an incident by looping: it reads its working memory (input), thinks, generates ONE tool call, the harness acts, and the result feeds the next input. It picks one tool at a time on a leash (max 6 turns) and ends with a stated root cause + remediation. Watch the rail: only THINK and GENERATE are the model; ACT is the harness running your tool.',
    kind: 'agent',
    teaches: 'An agent picks ONE tool at a time and loops — think, act, observe — until it can answer.',
  };

  private llm: LLM;
  private tools: CorpusTools;
  private docs: Doc[];

  // ─── Per-run history (for buildContext) ────────────────────────────────────
  private history: StepView[] = [];

  // ─── Stall guard state ─────────────────────────────────────────────────────
  // Signatures of every executed tool call, and a run of consecutive hard stalls.
  // Both reset() with the rest of the run.
  private priorSignatures: string[] = [];
  private consecutiveStalls = 0;

  // ─── Subphase state: cycling across next() calls ───────────────────────────
  private iteration = 0;
  private subphase: 'input' | 'think' | 'generate' | 'act' = 'input';

  // Fields that carry intermediate work between the 4 subphases of one iteration.
  private _context = '';
  private _decision: ToolCall | null = null;
  private _decisionPanel: ReturnType<typeof makePanel> | null = null;
  private _guardrail: string | undefined = undefined;

  constructor(llm: LLM, docs: Doc[]) {
    super();
    this.llm = llm;
    this.docs = docs;
    this.tools = new CorpusTools(docs, { maxCalls: MAX_STEPS + 4 });
  }

  protected traceName(): string {
    return 'auto_rag_agent';
  }

  reset(): void {
    super.reset();
    this.history = [];
    this.priorSignatures = [];
    this.consecutiveStalls = 0;
    this.iteration = 0;
    this.subphase = 'input';
    this._context = '';
    this._decision = null;
    this._decisionPanel = null;
    this._guardrail = undefined;
    this.tools = new CorpusTools(this.docs, { maxCalls: MAX_STEPS + 4 });
  }

  protected async runStep(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    switch (this.subphase) {
      case 'input':
        return this._runInput(stepIndex, cb);
      case 'think':
        return this._runThink(stepIndex, cb);
      case 'generate':
        return this._runGenerate(stepIndex, cb);
      case 'act':
        return this._runAct(stepIndex, cb);
    }
  }

  // ─── INPUT subphase ────────────────────────────────────────────────────────
  // Build the agent's working memory: incident + prior observations. Show both
  // context and input panels so the user can read WHAT the model receives before
  // anything streams.
  private _runInput(stepIndex: number, cb: StepCallbacks): StepResult {
    this.iteration += 1;
    this.trace.spanOpen('agent_step_input', { iteration: this.iteration });

    // ① CONTEXT — incident + summarized prior history (the loop's closure).
    const context = buildContext(INCIDENT_QUESTION, this.history);
    const contextPanel = makePanel('context', codeTitle('Context'), context, 'ctx');
    this.trace.step('context', { chars: context.length });
    cb.onPanel?.(contextPanel);

    // ①ᵇ INPUT — the prompt handed to the model for the THINKING stream.
    //    Shows the real prompt before thinking starts (honest: thinkingSystemPrompt
    //    framing, without the numbered OPERATING_PROCEDURE that governs GENERATE).
    const thinkNudge = thinkingInstruction();
    const inputText =
      `SYSTEM (thinking step):\n${thinkingSystemPrompt()}\n\n` +
      `USER (context / working memory):\n${context}\n\n` +
      `USER (this step):\n${thinkNudge}\n\n` +
      `NOTE: the GENERATE step (next) swaps in the full systemPrompt() — it adds the ` +
      `numbered OPERATING PROCEDURE + the tool menu that constrain the tool call.`;
    const inputPanel = makePanel('input', codeTitle('Input prompt → model'), inputText, 'ctx');
    this.trace.step('input', { chars: inputText.length }, inputText);
    cb.onPanel?.(inputPanel);

    // Emit INPUT phase so the rail lights the Input node with the iteration number.
    cb.onPhase?.({ phase: 'input', iteration: this.iteration });

    // Persist across phases.
    this._context = context;
    this._guardrail = undefined;

    this.trace.spanClose({ outcome: 'input_done' });
    this.subphase = 'think';

    const step = makeStep(stepIndex, `Iter ${this.iteration} · Input`, {
      panels: [contextPanel, inputPanel],
    });
    return { step, done: false };
  }

  // ─── THINK subphase ────────────────────────────────────────────────────────
  // Stream Gemma's native reasoning. runStream(mode:'think') internally emits
  // cb.onPhase?.({ phase: 'think' }) so we get that for free.
  private async _runThink(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    this.trace.spanOpen('agent_step_think', { iteration: this.iteration });

    const thinkNudge = thinkingInstruction();
    const thinkMessages: ChatMsg[] = [
      { role: 'system', content: thinkingSystemPrompt() },
      { role: 'user', content: this._context },
      { role: 'user', content: thinkNudge },
    ];
    // runStream with mode:'think' emits cb.onPhase?.({ phase: 'think' }) internally.
    await runStream({
      llm: this.llm,
      messages: thinkMessages,
      label: llmTitle('Thinking'),
      kind: 'thinking',
      mode: 'think',
      cb,
      trace: this.trace,
      traceStep: 'thinking',
    });

    this.trace.spanClose({ outcome: 'think_done' });
    this.subphase = 'generate';

    const step = makeStep(stepIndex, `Iter ${this.iteration} · Think`, { panels: [] });
    return { step, done: false };
  }

  // ─── GENERATE subphase ─────────────────────────────────────────────────────
  // Structured tool call (schema-validated, retried). Includes stall guard logic.
  private async _runGenerate(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    this.trace.spanOpen('agent_step_generate', { iteration: this.iteration });

    const messages: ChatMsg[] = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: this._context },
    ];
    const decideMsgs: ChatMsg[] = [
      ...messages,
      { role: 'user', content: decideInstruction(this.iteration - 1, MAX_STEPS) },
    ];

    let decision: ToolCall;
    let guardrail: string | undefined;
    let decisionStreamId: string | undefined;
    try {
      const res = await runDecide({
        llm: this.llm,
        messages: decideMsgs,
        schemaHint: decisionSchemaHint(),
        cb,
        trace: this.trace,
        label: llmTitle('Decision (raw output)'),
      });
      decision = res.decision;
      decisionStreamId = res.stream.id;
      if (res.retries > 0) guardrail = 'retry';
    } catch (err) {
      // Decision could not be coerced into a valid tool call after retries.
      this.trace.spanClose({ outcome: 'decision_failed' });
      const panel = makePanel(
        'decision',
        'Decision',
        `(failed to produce a valid decision: ${err instanceof Error ? err.message : String(err)})`,
        'tool',
      );
      cb.onPhase?.({ phase: 'generate' });
      const step = makeStep(stepIndex, `Iter ${this.iteration} · Generate`, {
        panels: [panel],
        guardrail: 'retry',
      });
      this.history.push(step);
      return { step, done: true };
    }

    // ─── STALL GUARD ──────────────────────────────────────────────────────────
    const sig = toolCallSignature(decision);
    const isDuplicate = this.priorSignatures.includes(sig);
    if (isDuplicate) {
      // (a) Inject one corrective hint and let the model RE-DECIDE in-place.
      const nudgeMsgs: ChatMsg[] = [
        ...decideMsgs,
        { role: 'assistant', content: `${decision.tool}(${JSON.stringify(decision.args)})` },
        {
          role: 'user',
          content:
            'You ALREADY made that exact tool call and got the same result. Do NOT repeat it. Advance: open a specific doc id with get_doc_summary/get_doc, or call mark_done with {root_cause, remediation}.',
        },
      ];
      let recovered = false;
      try {
        const reRes = await runDecide({
          llm: this.llm,
          messages: nudgeMsgs,
          schemaHint: decisionSchemaHint(),
          cb,
          trace: this.trace,
          label: llmTitle('Decision (raw output)'),
          streamId: decisionStreamId,
        });
        const reDecision = reRes.decision;
        const sig2 = toolCallSignature(reDecision);
        if (!this.priorSignatures.includes(sig2)) {
          decision = reDecision;
          this.consecutiveStalls = 0;
          guardrail = 'loop_retry';
          recovered = true;
        }
      } catch {
        // A thrown re-decide is itself a hard stall — fall through to (c).
      }

      // (c) Still duplicate (or the re-decide threw): HARD STALL.
      if (!recovered) {
        this.consecutiveStalls += 1;
        this.trace.step('loop_stalled', { repeated: sig, attempts: this.consecutiveStalls });
        this.trace.spanClose({ outcome: 'loop_stalled' });

        const repeatedDecisionPanel = makePanel(
          'decision',
          codeTitle('Parsed tool call'),
          `${decision.tool}(${JSON.stringify(decision.args)})`,
          'tool',
        );
        const stalledPanel = makePanel(
          'stalled',
          '⚠ loop stalled',
          'The model kept proposing the same tool call (' +
            sig +
            ') and made no new progress, so the harness halted the loop. No completion was fabricated — this is the real behavior of a small model that got stuck.',
          'observe',
        );
        cb.onPhase?.({ phase: 'generate' });
        const step = makeStep(stepIndex, `Iter ${this.iteration} · Generate`, {
          panels: [repeatedDecisionPanel, stalledPanel],
          guardrail: 'loop_stalled',
        });
        this.history.push(step);
        return { step, done: true };
      }
    } else {
      this.consecutiveStalls = 0;
    }

    const decisionPanel = makePanel(
      'decision',
      codeTitle('Parsed tool call'),
      `${decision.tool}(${JSON.stringify(decision.args)})`,
      'tool',
    );
    cb.onPhase?.({ phase: 'generate' });

    // Persist for act phase.
    this._decision = decision;
    this._decisionPanel = decisionPanel;
    this._guardrail = guardrail;

    this.trace.spanClose({ outcome: 'generate_done' });
    this.subphase = 'act';

    const step = makeStep(stepIndex, `Iter ${this.iteration} · Generate`, {
      panels: [decisionPanel],
      guardrail,
    });
    return { step, done: false };
  }

  // ─── ACT subphase ──────────────────────────────────────────────────────────
  // Execute the tool, show observation. If terminal: write the conclusion and
  // return done:true. Non-terminal: reset subphase to 'input' for next iteration.
  private async _runAct(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    this.trace.spanOpen('agent_step_act', { iteration: this.iteration });

    const decision = this._decision!;

    // ACT phase event — the rail highlights the tool being executed.
    cb.onPhase?.({ phase: 'act', tool: decision.tool });

    // Record the executed signature BEFORE running the tool.
    this.priorSignatures.push(toolCallSignature(decision));

    // Execute the tool → OBSERVATION.
    const result = this.tools.call(decision);
    const okTag = result.ok ? 'ok' : 'REFUSED';
    let guardrail = this._guardrail;
    if (!result.ok && decision.tool === 'propose_action') guardrail = 'whitelist_blocked';
    const observationBody = `[${okTag}] ${result.message}` + summarizeData(result.data);
    const observationPanel = makePanel('observation', codeTitle('Observation'), observationBody, 'observe');
    this.trace.step(
      'tool_call',
      { tool: decision.tool, ok: result.ok, message: result.message },
      JSON.stringify(result.data ?? {}, null, 2),
    );

    // Terminal predicate: mark_done or hitting the step cap.
    const isDone = this.tools.isDone() || this.iteration >= MAX_STEPS;

    const panels = [observationPanel];
    let title = `Iter ${this.iteration} · Act`;
    if (isDone) {
      const conclusion = await this.concludeAnswer(this._context, observationBody, decision, cb);
      panels.push(makePanel('conclusion', llmTitle('Conclusion — root cause & remediation'), conclusion, 'decide'));
      title = this.tools.isDone()
        ? `Iter ${this.iteration} · Act (concluded)`
        : `Iter ${this.iteration} · Act (budget reached)`;
    }

    this.trace.spanClose({ tool: decision.tool, ok: result.ok });

    const step = makeStep(stepIndex, title, { panels, guardrail });

    // Push to history so buildContext sees the observation in the next iteration.
    // We include decision + observation panels so buildContext can extract them.
    const historyStep = makeStep(stepIndex, title, {
      panels: [this._decisionPanel!, observationPanel],
      guardrail,
    });
    this.history.push(historyStep);

    if (!isDone) {
      this.subphase = 'input';
    }

    return { step, done: isDone };
  }

  /**
   * Synthesize the FINAL incident answer from the full investigation transcript.
   * Streamed live (the box persists via the framework merge). Grounded ONLY in what
   * the agent actually gathered — no new tools, no invention. Falls back to a plain
   * note if the model returns nothing (never a fabricated root cause).
   */
  private async concludeAnswer(
    latestContext: string,
    latestObservation: string,
    lastDecision: ToolCall,
    cb: StepCallbacks,
  ): Promise<string> {
    const transcript =
      `${latestContext}\n` +
      `- ${lastDecision.tool}(${JSON.stringify(lastDecision.args)})\n` +
      `  → ${latestObservation}`;
    const messages: ChatMsg[] = [
      { role: 'system', content: conclusionSystemPrompt() },
      { role: 'user', content: conclusionUserPrompt(INCIDENT_QUESTION, transcript) },
    ];
    const { text } = await runStream({
      llm: this.llm,
      messages,
      label: llmTitle('Concluding'),
      kind: 'generation',
      mode: 'stream',
      cb,
      trace: this.trace,
      traceStep: 'conclusion',
    });
    return text.trim() || '(model produced no conclusion)';
  }
}

/** Compact a tool result's data payload for the Observation panel — and, crucially,
 *  for the agent's WORKING MEMORY (buildContext copies the observation body into the
 *  next step's context). So this function decides WHAT THE MODEL REMEMBERS. The whole
 *  point of get_doc is to read a body; recording only "body: N chars" (the old
 *  behavior) discarded the content the model paid to read, so it could never state a
 *  root cause and looped re-opening docs until the stall guard fired. We now surface
 *  the REAL content: full body for get_doc, clean title+summary for get_doc_summary. */
export function summarizeData(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data !== 'object') return `\n${String(data).slice(0, 200)}`;
  const rec = data as Record<string, unknown>;

  // search_corpus → id + title per hit, so the model can triage by TITLE (not just a
  // bare id). Titles are what let it pick the right doc to open next.
  if (Array.isArray(rec.results)) {
    const rows = (rec.results as Array<{ id?: string; title?: string }>)
      .map((r) => (r?.title ? `${r.id} — ${r.title}` : r?.id))
      .filter(Boolean);
    return rows.length ? `\nhits:\n${rows.map((r) => `  • ${r}`).join('\n')}` : '';
  }

  // get_doc → the FULL body (the expensive read's ENTIRE purpose: put the document
  // content into working memory). This is what lets the model actually reach a
  // root cause + remediation and call mark_done instead of looping. Bodies in this
  // corpus are small (≤~1.4k chars), so we include them whole; the body IS the cost
  // the progressive-disclosure lesson is about.
  if (typeof rec.body === 'string') {
    const body = rec.body.trim();
    const title =
      typeof rec.title === 'string' && !body.startsWith('#') ? `# ${rec.title}\n` : '';
    return `\n${title}${body}`;
  }

  // get_doc_summary → title + summary + tags shown cleanly.
  if (typeof rec.summary === 'string') {
    const name = (rec.title as string) ?? (rec.id as string) ?? '';
    const tags = Array.isArray(rec.tags) ? ` [tags: ${(rec.tags as string[]).join(', ')}]` : '';
    return `\n${name}: ${rec.summary}${tags}`;
  }

  // propose_action / dry-run → the action id is the useful handle for the next step.
  if (typeof rec.action_id === 'string') return `\naction_id: ${rec.action_id}`;
  const keys = Object.keys(rec);
  if (keys.length > 0) return `\n${JSON.stringify(rec).slice(0, 200)}`;
  return '';
}

/** Factory the framework calls. */
export function makeAgentScenario(llm: LLM, docs: Doc[]): AgentScenario {
  return new AgentScenario(llm, docs);
}
