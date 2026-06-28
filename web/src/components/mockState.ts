'use client';

// mockState — standalone preview fixtures. NO real engine/LLM/scenario logic;
// these just let the presentational components be previewed in isolation.

import type {
  ScenarioMeta,
  ScenarioId,
  LoopState,
  StepView,
  LlmStream,
  Panel,
  TraceLine,
} from '@/types';

// ─── scenario metadata (all 6, plausible English titles/subtitles) ────────────
export function mockScenarioMetas(): ScenarioMeta[] {
  return [
    { id: '01_rag', title: 'RAG Pipeline', subtitle: 'fixed retrieve → reason → validate — a pipeline, not an agent', kind: 'workflow', teaches: 'Retrieve documents, put them in the model’s context, and let it answer — grounded and cited.' },
    { id: '02_agent', title: 'Tool-Using Agent', subtitle: 'the agent loop: gather context, think, decide a tool, observe', kind: 'agent', teaches: 'An agent picks ONE tool at a time and loops — think, act, observe — until it can answer.' },
    { id: '03_eval', title: 'Evaluating Agents', subtitle: 'the eval pyramid: metrics → LLM-as-judge → human calibration', kind: 'workflow', teaches: 'Climb the evaluation pyramid only as far as the task forces you: cheap metrics first, judge last.' },
    { id: '04_search', title: 'Autonomous Search', subtitle: 'act until a terminal state — bounded by an explicit budget', kind: 'agent', teaches: 'An autonomous agent acts until a terminal predicate is met — or an explicit step budget stops it.' },
    { id: '05_validation', title: 'Trusting Output', subtitle: 'the validation ladder: schema → lint → replay → judge → human', kind: 'workflow', teaches: 'Climb a validation ladder, cheapest check first, and fail closed when a rung doesn’t pass.' },
    { id: '07_safety', title: 'Agent Safety', subtitle: 'PII redaction · prompt-injection · cost ceiling · safety flywheel', kind: 'workflow', teaches: 'Safety is a design dimension: redact PII, fence untrusted text, cap cost, and grow a regression set.' },
  ];
}

// ─── a realistic 02_agent step ────────────────────────────────────────────────
function mockStreams(): LlmStream[] {
  return [
    {
      id: 'thinking-1',
      label: 'Thinking',
      kind: 'thinking',
      text:
        "I've confirmed it's CPU saturation, but I haven't read the root-cause doc yet. " +
        'I should search the corpus, then open the runbook.',
      done: true,
    },
    {
      id: 'decision-1',
      label: 'Decision',
      kind: 'decision',
      text: 'call search_corpus("cpu saturation runbook") → then get_doc_summary on the top hit.',
      done: true,
    },
  ];
}

function mockPanels(): Panel[] {
  return [
    {
      key: 'context',
      label: 'Context',
      accent: 'cyan',
      body: 'Question: "Why is service-A pegged at 100% CPU?"\nHistory: alert fired 12m ago; metrics show sustained CPU saturation.',
    },
    {
      key: 'decision',
      label: 'Decision',
      accent: 'teal',
      body: 'tool: search_corpus\nargs: { query: "cpu saturation runbook" }',
    },
    {
      key: 'observation',
      label: 'Observation',
      accent: 'pink',
      body: 'search_corpus → 3 hits. Top: cpu_saturation_runbook (score 0.91).\nNext step will read its summary.',
    },
  ];
}

// ─── a small hierarchical trace (mirrors the animation reference) ─────────────
function mockTrace(): TraceLine[] {
  return [
    { n: 1, event: 'trace_start', depth: 0, step: 'agent_run' },
    { n: 2, event: 'span_open', depth: 0, step: 'agent_loop' },
    {
      n: 3,
      event: 'step',
      depth: 1,
      step: 'tool_call search_corpus',
      data: { query: 'cpu saturation runbook' },
    },
    {
      n: 4,
      event: 'step',
      depth: 1,
      step: 'tool_call get_doc_summary',
      data: { doc: 'cpu_saturation_runbook' },
    },
    {
      n: 5,
      event: 'step',
      depth: 1,
      step: 'llm_call think+decide',
      rawResponse:
        '<|channel>thought\n' +
        "It's CPU saturation. I haven't read the runbook yet — search first, then open it.\n" +
        'channel|>\n' +
        '{ "tool": "search_corpus", "args": { "query": "cpu saturation runbook" } }',
    },
    { n: 6, event: 'span_close', depth: 0, step: 'agent_loop', durS: 2.3 },
    { n: 7, event: 'trace_end', depth: 0, step: 'agent_run', durS: 2.4 },
  ];
}

function mockStep(): StepView {
  return {
    index: 1,
    title: 'Thinking + Decide',
    streams: mockStreams(),
    panels: mockPanels(),
  };
}

/**
 * A realistic LoopState for previewing the components without the engine.
 * Defaults to the 02_agent scenario; pass another id to relabel it.
 */
export function mockLoopState(scenario: ScenarioId = '02_agent'): LoopState {
  const step = mockStep();
  return {
    scenario,
    phase: 'step_done',
    steps: [step],
    current: step,
    finished: false,
    finalResult: null,
    error: null,
    trace: mockTrace(),
  };
}
