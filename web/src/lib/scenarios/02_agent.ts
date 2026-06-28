// scenarios/02_agent.ts — the classic auto-RAG agent loop (folder 02).
//
// Each Next press = ONE agent step:
//   ① CONTEXT panel  (incident + summarized history — the model's working memory)
//   ② THINKING stream (Gemma native thinking, streamed token-by-token)
//   ③ DECISION stream (structured tool call, schema-validated, retried on failure)
//   ④ OBSERVATION panel (the tool result — which FEEDS INTO the next step's context)
//
// Terminates on mark_done or maxSteps. Guardrails (whitelist refusal, budget cap,
// dry-run, terminal) are enforced inside CorpusTools and surfaced via panels/trace.
//
// Mirrors reference/02_auto_rag_agent/{agent,prompts,tools}.py behavior, adapted to
// the unified Scenario framework + browser LLM.

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
    subtitle: 'context-gather → think → decide → observe, on a leash',
    kind: 'agent',
    teaches: 'An agent picks ONE tool at a time and loops — think, act, observe — until it can answer.',
  };

  private llm: LLM;
  private tools: CorpusTools;
  private docs: Doc[];
  private history: StepView[] = [];
  // Stall guard state: signatures of every executed tool call, and a run of
  // consecutive hard stalls. Both reset() with the rest of the run.
  private priorSignatures: string[] = [];
  private consecutiveStalls = 0;

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
    this.tools = new CorpusTools(this.docs, { maxCalls: MAX_STEPS + 4 });
  }

  protected async runStep(stepIndex: number, cb: StepCallbacks): Promise<StepResult> {
    this.trace.spanOpen('agent_step', { step: stepIndex });

    // ① CONTEXT — incident + summarized history (the loop's closure: prior
    //    observations flow in here).
    const context = buildContext(INCIDENT_QUESTION, this.history);
    const contextPanel = makePanel('context', codeTitle('Context'), context, 'ctx');
    this.trace.step('context', { chars: context.length });

    // Emit the CONTEXT block to the live step RIGHT NOW — this is the STARTING block
    // the user reads BEFORE anything streams. Without this, the step opened straight
    // into the Thinking box; the context only appeared at commit. (Bug: "这应该是起始
    // block，这个block之后才会thinking".)
    cb.onPanel?.(contextPanel);
    // RECEIVE — the step has read its working memory (incident + prior observations);
    // light the Receive node with the 1-based iteration so the rail shows the loop turn.
    cb.onPhase?.({ phase: 'receive', iteration: stepIndex + 1 });

    const messages: ChatMsg[] = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: context },
    ];

    // ①ᵇ INPUT — the exact prompt handed to the model THIS step, shown before the
    //    Thinking box so you can read what the model is reacting to (not just its
    //    output). Honest: this is the verbatim system + context + thinking nudge.
    const thinkNudge = thinkingInstruction();
    const inputText =
      `SYSTEM:\n${systemPrompt()}\n\n` +
      `USER (context / working memory):\n${context}\n\n` +
      `USER (this step):\n${thinkNudge}`;
    const inputPanel = makePanel('input', codeTitle('Input prompt → model'), inputText, 'ctx');
    this.trace.step('input', { chars: inputText.length }, inputText);
    // Emit the INPUT prompt block too, still BEFORE thinking starts.
    cb.onPanel?.(inputPanel);

    // ② THINKING — stream Gemma's native reasoning. Append a thinking instruction
    //    so the model reasons briefly about ONLY its single next action.
    await runStream({
      llm: this.llm,
      messages: [...messages, { role: 'user', content: thinkNudge }],
      label: llmTitle('Thinking'),
      kind: 'thinking',
      mode: 'think',
      cb,
      trace: this.trace,
      traceStep: 'thinking',
    });

    // ③ DECISION — structured tool call (schema-validated, retried).
    const decideMsgs: ChatMsg[] = [
      ...messages,
      { role: 'user', content: decideInstruction(stepIndex, MAX_STEPS) },
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
      const step = makeStep(stepIndex, 'Thinking + Decide', {
        panels: [contextPanel, inputPanel, panel],
        guardrail: 'retry',
      });
      this.history.push(step);
      // Bail out of the run rather than spin.
      return { step, done: true };
    }

    // ─── STALL GUARD ──────────────────────────────────────────────────────────
    // Honesty stance: a tiny greedy model can lock onto re-issuing the SAME tool
    // call forever (the user watched search_corpus repeat n1…n36, never advancing).
    // We detect that by canonical signature, give the model ONE corrective nudge to
    // re-decide within this step, and if it STILL repeats we HALT and say so. We
    // never fabricate a mark_done to make a stuck run look finished.
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
          // Reuse the SAME decision box (id + label) so the corrective re-decide
          // updates one box in place — we never want a second 'Decision' box. There
          // is exactly ONE LLM decision box per step.
          label: llmTitle('Decision (raw output)'),
          streamId: decisionStreamId,
        });
        const reDecision = reRes.decision;
        // (b) Did the nudge produce something genuinely new?
        const sig2 = toolCallSignature(reDecision);
        if (!this.priorSignatures.includes(sig2)) {
          // Recovered — proceed with the new decision as if it were the first.
          decision = reDecision;
          this.consecutiveStalls = 0;
          guardrail = 'loop_retry';
          recovered = true;
        }
      } catch {
        // A thrown re-decide is itself a hard stall — fall through to (c).
      }

      // (c) Still duplicate (or the re-decide threw): HARD STALL. Halt honestly —
      //     no tool executed this step, no mark_done fabricated.
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
        const step = makeStep(stepIndex, 'Thinking + Decide', {
          panels: [contextPanel, inputPanel, repeatedDecisionPanel, stalledPanel],
          guardrail: 'loop_stalled',
        });
        this.history.push(step);
        // Terminate WITHOUT executing the duplicate tool and WITHOUT mark_done.
        return { step, done: true };
      }
    } else {
      // Fresh action — clear any prior stall streak.
      this.consecutiveStalls = 0;
    }

    // Record the executed signature BEFORE running the tool (normal/recovered path).
    this.priorSignatures.push(toolCallSignature(decision));

    const decisionPanel = makePanel(
      'decision',
      codeTitle('Parsed tool call'),
      `${decision.tool}(${JSON.stringify(decision.args)})`,
      'tool',
    );
    // ACT — a concrete tool call was chosen; carry its name so the rail can highlight
    // the tool the agent is about to run.
    cb.onPhase?.({ phase: 'act', tool: decision.tool });

    // ④ EXECUTE the tool → OBSERVATION.
    const result = this.tools.call(decision);
    const okTag = result.ok ? 'ok' : 'REFUSED';
    // A refused off-whitelist action is the injection/guardrail teaching beat.
    if (!result.ok && decision.tool === 'propose_action') guardrail = 'whitelist_blocked';
    const observationBody = `[${okTag}] ${result.message}` + summarizeData(result.data);
    const observationPanel = makePanel('observation', codeTitle('Observation'), observationBody, 'observe');
    // OBSERVE — the tool ran and its result is now the agent's new evidence.
    cb.onPhase?.({ phase: 'observe', tool: decision.tool });
    this.trace.step(
      'tool_call',
      { tool: decision.tool, ok: result.ok, message: result.message },
      JSON.stringify(result.data ?? {}, null, 2),
    );

    this.trace.spanClose({ tool: decision.tool, ok: result.ok });

    // Terminal predicate: mark_done or hitting the step cap.
    const done = this.tools.isDone() || stepIndex + 1 >= MAX_STEPS;

    // When the loop ENDS, don't leave a dangling tool call — write the FINAL answer.
    // A research/incident agent must conclude with a stated ROOT CAUSE + REMEDIATION
    // grounded in the transcript, not stop on whatever tool happened to be last (the
    // user's "应该给个 root cause 不是么?"). This mirrors 04_search's final synthesis,
    // so every agent scenario ends the same way: a conclusion, not a dangling action.
    const panels = [contextPanel, inputPanel, decisionPanel, observationPanel];
    let title = 'Thinking + Decide';
    if (done) {
      const conclusion = await this.concludeAnswer(context, observationBody, decision, cb);
      panels.push(makePanel('conclusion', llmTitle('Conclusion — root cause & remediation'), conclusion, 'decide'));
      title = this.tools.isDone() ? 'Conclude (model marked done)' : 'Conclude (budget reached)';
    }

    const step = makeStep(stepIndex, title, { panels, guardrail });
    this.history.push(step);
    return { step, done };
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
    // The transcript = the running context (incident + prior tool→observation pairs)
    // plus THIS step's last action+observation, which aren't in history yet.
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
    // Only prepend the title if the body doesn't already start with it (these docs
    // are markdown that usually opens with `# <title>`) — avoids the doubled header.
    const title =
      typeof rec.title === 'string' && !body.startsWith('#') ? `# ${rec.title}\n` : '';
    return `\n${title}${body}`;
  }

  // get_doc_summary → title + summary + tags shown cleanly (the old code dumped
  // truncated JSON that cut off mid-field, e.g. `...tags":["shard`).
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
