// scenarioBase.ts — shared helpers every Scenario implementation reuses, so each
// scenario file (lib/scenarios/<id>.ts) stays thin.
//
// What lives here:
//   • id helpers + small builders for LlmStream / Panel / StepView
//   • runStream(): drive ONE llm.stream/think call while (a) emitting incremental
//     LlmStream updates to the UI via onStream and (b) recording a trace step with
//     the raw response. This is the "run an LLM box and trace it at once" utility
//     PLAN §3.1 asks for.
//   • runDecide(): drive llm.decide() with retry, surfacing a decision stream +
//     trace, returning the validated ToolCall (or throwing after retries).
//   • BaseScenario: an abstract class that owns the step counter + finished flag so
//     concrete scenarios only implement step(stepIndex, cb) and meta/reset specifics.
//
// Pure framework glue: depends only on @/types, the LLM interface, and TraceBuilder.
// No transformers.js, no DOM.

import type {
  ChatMsg,
  LLM,
  LlmStream,
  LlmStreamKind,
  Panel,
  Scenario,
  ScenarioMeta,
  StepCallbacks,
  StepView,
  ToolCall,
} from '@/types';
import { TraceBuilder } from '@/lib/trace';
import { cleanModelText } from '@/lib/llm';
import { isCancelled } from '@/lib/cancel';

// ─── id + small builders ──────────────────────────────────────────────────────

let _seq = 0;
/** A process-unique id for streams/panels (stable per call order; no Math.random). */
export function uid(prefix = 'id'): string {
  _seq += 1;
  return `${prefix}-${_seq}`;
}

export function makeStream(
  label: string,
  kind: LlmStreamKind,
  opts?: { id?: string; text?: string; done?: boolean },
): LlmStream {
  return {
    id: opts?.id ?? uid(kind),
    label,
    kind,
    text: opts?.text ?? '',
    done: opts?.done ?? false,
  };
}

export function makePanel(
  key: string,
  label: string,
  body: string,
  accent?: string,
  hint?: string,
): Panel {
  const panel: Panel = { key, label, body };
  if (accent) panel.accent = accent;
  if (hint) panel.hint = hint;
  return panel;
}

export function makeStep(
  index: number,
  title: string,
  opts?: { streams?: LlmStream[]; panels?: Panel[]; guardrail?: string; hint?: string },
): StepView {
  const step: StepView = {
    index,
    title,
    streams: opts?.streams ?? [],
    panels: opts?.panels ?? [],
  };
  if (opts?.guardrail) step.guardrail = opts.guardrail;
  if (opts?.hint) step.hint = opts.hint;
  return step;
}

// ─── run one streaming LLM call, wired to UI + trace ──────────────────────────

export interface RunStreamOpts {
  llm: LLM;
  messages: ChatMsg[];
  label: string;
  kind: LlmStreamKind;
  /** 'think' parses the Gemma thought channel; 'stream' is raw generation. */
  mode: 'think' | 'stream';
  cb: StepCallbacks;
  trace: TraceBuilder;
  /** trace step name (defaults to `llm_call`). */
  traceStep?: string;
}

/**
 * Run a single llm.think()/llm.stream() call. Creates one LlmStream, forwards every
 * token to the UI (accumulating text), marks it done, and records a trace `step`
 * carrying the full text as `rawResponse`. Returns { stream, text }.
 */
export async function runStream(
  opts: RunStreamOpts,
): Promise<{ stream: LlmStream; text: string }> {
  const { llm, messages, label, kind, mode, cb, trace, traceStep } = opts;
  const stream = makeStream(label, kind);
  cb.onStream({ ...stream }); // initial empty box
  // A think() box opening IS the 'think' phase starting — emit it so the rail lights
  // the Think node as the real reasoning begins (additive; reflects real execution).
  if (mode === 'think') cb.onPhase?.({ phase: 'think' });

  const onToken = (t: string) => {
    stream.text += t;
    cb.onStream({ ...stream });
  };

  const full = mode === 'think'
    ? await llm.think(messages, onToken)
    : await llm.stream(messages, onToken);

  // Some implementations resolve the full text even if no tokens streamed.
  if (stream.text.length === 0 && full) stream.text = full;
  stream.done = true;
  cb.onStream({ ...stream });

  trace.step(traceStep ?? 'llm_call', { label, kind }, stream.text);
  return { stream, text: stream.text };
}

// ─── run a structured decision with retry ─────────────────────────────────────

export interface RunDecideOpts {
  llm: LLM;
  messages: ChatMsg[];
  schemaHint: string;
  cb: StepCallbacks;
  trace: TraceBuilder;
  label?: string;
  /** Reuse an existing stream box id instead of minting a new one. Used by the
   *  stall-guard re-decide so a corrective attempt UPDATES the one decision box in
   *  place rather than spawning a second box (we only ever want ONE LLM decision
   *  box per step). */
  streamId?: string;
  /** max attempts before giving up (default 3 → 1 try + 2 retries). */
  maxAttempts?: number;
}

export interface RunDecideResult {
  decision: ToolCall;
  stream: LlmStream;
  /** number of retries that were needed (0 = first attempt succeeded). */
  retries: number;
}

/**
 * Drive llm.decide() with retry. Surfaces a 'decision' stream box that fills with
 * the model's RAW output live (so you see the real tokens, not a tidied result),
 * traces each attempt with the raw response, and on failure feeds the parse error
 * back into the next attempt. Throws after maxAttempts.
 */
export async function runDecide(opts: RunDecideOpts): Promise<RunDecideResult> {
  const { llm, schemaHint, cb, trace } = opts;
  const maxAttempts = opts.maxAttempts ?? 3;
  const stream = makeStream(opts.label ?? 'Decision', 'decision', { id: opts.streamId });
  cb.onStream({ ...stream });

  let messages = opts.messages;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw = '';
    stream.text = '';
    stream.done = false;
    cb.onStream({ ...stream });
    try {
      const decision = await llm.decide(messages, schemaHint, (t) => {
        raw += t;
        // Clean the FULL accumulation each tick (a control token like <turn|> can
        // split across chunks), so the displayed decision box shows clean JSON with
        // no leaked Gemma delimiters. `raw` itself stays intact for the trace.
        stream.text = cleanModelText(raw);
        cb.onStream({ ...stream });
      });
      stream.done = true;
      cb.onStream({ ...stream });
      // Trace carries the model's RAW response (expandable via +raw in the panel).
      trace.step('decision', { tool: decision.tool, args: decision.args, attempt }, raw || stream.text);
      return { decision, stream, retries: attempt - 1 };
    } catch (err) {
      lastErr = err;
      const emsg = err instanceof Error ? err.message : String(err);
      trace.step('decision_retry', { attempt, error: emsg }, raw);
      // Feed the failure back so the model can self-correct on the next attempt.
      messages = [
        ...messages,
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: `That was not a single valid JSON tool call (${emsg}). Reply with ONLY the JSON object.`,
        },
      ];
    }
  }
  stream.text = `decision failed after ${maxAttempts} attempts`;
  stream.done = true;
  cb.onStream({ ...stream });
  throw lastErr instanceof Error ? lastErr : new Error('decision failed');
}

// ─── honesty helpers: one consistent "who produced this" vocabulary ───────────
//
// Every block is labeled by its SOURCE, the SAME way across all 7 scenarios:
//   • content the MODEL produced          → title "LLM · <name>"   (llmTitle)
//   • content deterministic CODE produced → title "Code · <name>"  (codeTitle)
// For an inline mid-sentence mark (e.g. "…REAL model output [LLM]") use the TAG_*
// chips, which PanelBody renders as small colored badges. Same two words, every
// time — no more ad-hoc "[model-driven]" vs "Answer" vs "Decision" drift.

/** Title prefix for a block whose content was GENERATED BY THE MODEL. */
export const SRC_LLM = 'LLM';
/** Title prefix for a block produced by deterministic code (NO model). */
export const SRC_CODE = 'Code';
/** Prefix a block label as model-generated, e.g. llmTitle('Answer') → "LLM · Answer". */
export function llmTitle(label: string): string {
  return `${SRC_LLM} · ${label}`;
}
/** Prefix a block label as code/deterministic, e.g. codeTitle('Retrieved') → "Code · Retrieved". */
export function codeTitle(label: string): string {
  return `${SRC_CODE} · ${label}`;
}

/** Inline chip: this value was produced by the MODEL (rendered teal by PanelBody). */
export const TAG_MODEL = '[LLM]';
/** Inline chip: this value is pure code — no model involved (rendered grey). */
export const TAG_DETERMINISTIC = '[Code]';

/**
 * Extract an integer rubric score in [1, max] from judge text. The judge is told
 * to end with a final "SCORE: <n>/5" line, so we scan for the LAST labeled score
 * (the verdict), then fall back to a trailing "n/5" form.
 *
 * Returns null when no score is present — callers MUST treat null honestly (report
 * that the model produced no parseable score) and NEVER fabricate a number. This is
 * the whole point of "let the agent decide": the score is the model's, or it is
 * absent, but it is never invented by the harness.
 */
export function extractRubricScore(text: string, max = 5): number | null {
  if (!text) return null;
  // Prefer an explicitly labeled score ("SCORE: 4", "score = 4/5"), LAST occurrence.
  const labeled = [...text.matchAll(/score\s*[:=]?\s*([0-9]+)\s*(?:\/\s*[0-9]+)?/gi)];
  for (let i = labeled.length - 1; i >= 0; i--) {
    const n = Number(labeled[i][1]);
    if (Number.isInteger(n) && n >= 1 && n <= max) return n;
  }
  // Fall back to a bare "n/5" form anywhere, LAST occurrence.
  const slash = [...text.matchAll(/\b([0-9]+)\s*\/\s*5\b/g)];
  for (let i = slash.length - 1; i >= 0; i--) {
    const n = Number(slash[i][1]);
    if (Number.isInteger(n) && n >= 1 && n <= max) return n;
  }
  return null;
}

// ─── BaseScenario: step-counter + finished bookkeeping ────────────────────────

/**
 * Common Scenario scaffolding. Concrete scenarios extend this and implement
 * `runStep(stepIndex, cb, trace)`; the base owns:
 *   • the monotonic step index
 *   • the finished flag (set when the concrete step returns done:true or throws)
 *   • a per-run TraceBuilder, replayed into cb.onTrace as lines are produced
 *   • reset()
 */
export abstract class BaseScenario implements Scenario {
  abstract readonly meta: ScenarioMeta;

  protected stepIndex = 0;
  protected finished = false;
  private _trace: TraceBuilder | null = null;
  private tracePushed = 0; // how many trace lines already forwarded to the UI

  // NOTE: the trace is created LAZILY on first access, never in the constructor.
  // Subclasses declare `meta` as a class FIELD, which (per ES class-field ordering)
  // is undefined while super() runs — so reading this.meta during construction
  // throws. Lazy creation defers newTrace() until the first runStep(), by which
  // point the subclass fields are initialized.
  protected get trace(): TraceBuilder {
    if (!this._trace) this._trace = this.newTrace();
    return this._trace;
  }

  /** Concrete scenarios override to seed the trace name/meta. */
  protected traceName(): string {
    return this.meta.id;
  }

  private newTrace(): TraceBuilder {
    return new TraceBuilder(this.traceName(), { scenario: this.meta.id });
  }

  isFinished(): boolean {
    return this.finished;
  }

  reset(): void {
    this.stepIndex = 0;
    this.finished = false;
    this.tracePushed = 0;
    this._trace = null; // recreated lazily on next trace access
  }

  /**
   * Advance one step. Wraps the concrete `runStep`, flushes any new trace lines to
   * cb.onTrace, and bumps the step counter. The concrete step signals termination
   * by returning `{ step, done: true }` (the base then ends the trace).
   */
  async next(cb: StepCallbacks): Promise<StepView> {
    if (this.finished) {
      // Nothing more to do; return a terminal placeholder step.
      return makeStep(this.stepIndex, 'Finished');
    }
    const index = this.stepIndex;
    let result: StepResult;
    try {
      result = await this.runStep(index, cb);
    } catch (err) {
      // A cancellation (user pause / scenario switch) is NOT a failure: don't record
      // an error line or a red banner. End the trace as cancelled and rethrow the
      // sentinel so the UI drops the partial step.
      if (isCancelled(err)) {
        this.finished = true;
        this.trace.end({ cancelled: true });
        this.flushTrace(cb);
        throw err;
      }
      this.trace.step('error', { message: err instanceof Error ? err.message : String(err) });
      this.flushTrace(cb);
      this.finished = true;
      this.trace.end({ error: true });
      this.flushTrace(cb);
      throw err;
    }
    this.stepIndex += 1;
    if (result.done) {
      this.finished = true;
      this.trace.end({ steps: this.stepIndex });
    }
    this.flushTrace(cb);
    return result.step;
  }

  /** Forward newly-appended trace lines to the UI (incremental). */
  protected flushTrace(cb: StepCallbacks): void {
    const lines = this.trace.lines();
    for (let i = this.tracePushed; i < lines.length; i++) {
      cb.onTrace(lines[i]);
    }
    this.tracePushed = lines.length;
  }

  /**
   * Implement the scenario's per-step logic. Receives the 0-based step index and
   * the UI callbacks; uses `this.trace` for spans/steps. Return the built StepView
   * and whether this was the terminal step.
   */
  protected abstract runStep(stepIndex: number, cb: StepCallbacks): Promise<StepResult>;
}

export interface StepResult {
  step: StepView;
  done: boolean;
}
