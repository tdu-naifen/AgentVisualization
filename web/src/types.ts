// types.ts — THE CONTRACT. Every module depends on these. Field names are fixed;
// implementers must not rename them (parallel modules wire against this file).
//
// Scope (PLAN §2): a unified step-driven framework for all 7 scenarios (01–07).
// The old fixed four-block StepView (context/thinking/decision/observation) is now
// a *special case* of 02 — expressed via `streams[]` + `panels[]` below.

// ─── Tools (corpus + action tools for in-process, browser-side tool use) ───────
// These are executed as plain function calls in the same JS runtime (see
// lib/tools.ts) — NOT over MCP. The tool shapes mirror the Python reference's tool
// definitions, but there is no protocol/server: the model emits a JSON tool call
// and the harness runs it directly.

export type ToolName =
  | 'search_corpus'
  | 'get_doc_summary'
  | 'get_doc'
  | 'propose_action'
  | 'apply_action_dry_run'
  | 'mark_done';

export const TOOL_NAMES: ToolName[] = [
  'search_corpus',
  'get_doc_summary',
  'get_doc',
  'propose_action',
  'apply_action_dry_run',
  'mark_done',
];

export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  message: string;
}

export interface Doc {
  id: string;
  title: string;
  summary: string;
  type: string;
  tags: string[];
  body: string;
}

// ─── Scenario abstraction: one framework, 7 implementations ───────────────────

export type ScenarioId =
  | '01_rag'
  | '02_agent'
  | '03_eval'
  | '04_search'
  | '05_validation'
  | '06_compare'
  | '07_safety';

export const SCENARIO_IDS: ScenarioId[] = [
  '01_rag',
  '02_agent',
  '03_eval',
  '04_search',
  '05_validation',
  '06_compare',
  '07_safety',
];

export interface ScenarioMeta {
  id: ScenarioId;
  title: string;
  subtitle: string;
}

// ─── A single LLM streaming box within a step (requirement ①) ─────────────────
// A step may have 0..N of these (e.g. a pure-retrieval step has 0; an
// agent step has Thinking + Decision; 06 has two columns each streaming).

export type LlmStreamKind = 'thinking' | 'decision' | 'generation' | 'judge' | 'other';

export interface LlmStream {
  id: string;
  /** e.g. "Thinking", "Decision", "Judge score" */
  label: string;
  kind: LlmStreamKind;
  /** accumulated streamed text */
  text: string;
  done: boolean;
}

// ─── Hierarchical trace line (requirement ③; mirrors shared/trace.py) ─────────

export type TraceEvent =
  | 'trace_start'
  | 'span_open'
  | 'step'
  | 'span_close'
  | 'trace_end';

export interface TraceLine {
  n: number;
  event: TraceEvent;
  /** drives indentation in TracePanel */
  depth: number;
  step?: string;
  data?: Record<string, unknown>;
  /** raw output of an LLM call (expandable in the panel) */
  rawResponse?: string;
  /** duration on span_close / trace_end */
  durS?: number;
  /** which committed step (0-based index) this line belongs to. Stamped at commit
   *  time in page.tsx so clicking the line in the trace panel can jump to that
   *  step's blocks on the left. Optional: lines emitted outside a step have none. */
  stepIndex?: number;
}

// ─── A structured panel shown in a step (scenario-defined) ────────────────────

export interface Panel {
  key: string;
  label: string;
  /** optional accent token for color-coding (e.g. 'cyan' | 'green' | 'pink' | 'amber') */
  accent?: string;
  body: string;
}

// ─── A step's unified view (replaces the old fixed four-block StepView) ────────

export interface StepView {
  index: number;
  /** what this step is called in this scenario, e.g. "Retrieve" / "Thinking + Decide" / "Judge" */
  title: string;
  /** the step's LLM streaming boxes (may be empty, e.g. a pure-retrieval step) */
  streams: LlmStream[];
  /** the step's structured blocks (scenario-defined: context/decision/observation/metrics…) */
  panels: Panel[];
  /** if a guardrail fired this step: 'retry' | 'whitelist_blocked' | 'budget' | ... */
  guardrail?: string;
}

export type LoopPhase = 'idle' | 'running' | 'step_done' | 'finished' | 'error';

export interface LoopState {
  scenario: ScenarioId;
  phase: LoopPhase;
  steps: StepView[];
  current: StepView | null;
  /** → Next greys out, Reset appears (requirement ②) */
  finished: boolean;
  finalResult: string | null;
  error: string | null;
  /** accumulated hierarchical trace (requirement ③) */
  trace: TraceLine[];
}

// ─── Callbacks the framework passes into Scenario.next() ──────────────────────

export interface StepCallbacks {
  /** create/update one streaming box (call repeatedly as tokens arrive) */
  onStream: (s: LlmStream) => void;
  /** append one trace line */
  onTrace: (t: TraceLine) => void;
  /**
   * Emit/update one structured panel into the LIVE (in-progress) step, BEFORE the
   * step commits — so an INPUT panel (context / the prompt the model will read) can
   * appear FIRST, then the Thinking/Decision boxes stream in BELOW it. Without this,
   * panels only show at step-commit, so a step appeared to "open straight into
   * thinking" with no visible starting context. Optional: scenarios that don't need
   * live panels (and test stubs) may omit it; emitters call it as `cb.onPanel?.(p)`.
   * Panels are keyed; re-emitting the same key updates in place (no duplicate).
   */
  onPanel?: (p: Panel) => void;
}

/**
 * The unified scenario interface. The framework (UI + driver) depends ONLY on
 * this; each of the 7 scenarios implements one. They share the LLM / retrieval /
 * trace base but are otherwise decoupled → parallel-implementable.
 */
export interface Scenario {
  meta: ScenarioMeta;
  reset(): void;
  isFinished(): boolean;
  /** advance one step; stream text + trace lines to the UI in real time */
  next(cb: StepCallbacks): Promise<StepView>;
}

// ─── LLM facade (lib/llm.ts implements it; scenarios depend on the interface) ─

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * LLM interface. lib/llm.ts implements it against transformers.js + Gemma 4.
 * Scenarios depend ONLY on this interface, so tests can pass a fake LLM.
 */
export interface LLM {
  load(onProgress: (pct: number) => void): Promise<void>;
  ready(): boolean;
  /** raw streaming generation; onToken fires per chunk; resolves with full text */
  stream(messages: ChatMsg[], onToken: (t: string) => void): Promise<string>;
  /** stream thinking (parses Gemma <|channel>thought…<channel|>); resolves thinking text */
  think(messages: ChatMsg[], onToken: (t: string) => void): Promise<string>;
  /** force a schema-valid structured decision; onToken (optional) streams the raw decision text live */
  decide(messages: ChatMsg[], schemaHint: string, onToken?: (t: string) => void): Promise<ToolCall>;
}

/** Tools API the agent scenarios call. lib/tools.ts implements it over corpus.json. */
export interface ToolsApi {
  call(tc: ToolCall): ToolResult;
  /** true once mark_done has been called */
  isDone(): boolean;
  /** result payload passed to mark_done, if any */
  doneResult(): unknown;
}
