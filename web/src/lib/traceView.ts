// traceView.ts — pure presentation helpers for the hierarchical trace.
//
// The trace is recorded with terse machine identifiers (span/step names like
// `whitelist`, `terminal_check`, `redact`) plus a structured `data` payload. The
// raw names read like internal jargon ("step/whitelist — what is this?"), and the
// data was never surfaced at all, so a finished span told you almost nothing.
//
// These helpers turn the recorded names into HUMAN-READABLE labels and render the
// data payload as a compact one-line summary, WITHOUT inventing anything: every
// value shown comes straight from the recorded trace. Pure + deterministic (no DOM,
// no model) so they are unit-testable and safe to import anywhere.

/**
 * Human-readable labels for span/step identifiers used across all scenarios.
 * Keep keys in sync with the names passed to TraceBuilder.spanOpen()/step() and the
 * `traceStep` option of runStream/runDecide. An unmapped name falls back to a
 * title-cased version of the identifier, so a new step is never shown as raw snake.
 */
const TRACE_LABELS: Record<string, string> = {
  // ── spans ──
  action: 'Agent action',
  agent_step: 'Agent step',
  agent_turn: 'Agent turn',
  compare_step: 'Compare step',
  comparison: 'Compare pipeline vs agent',
  guardrail: 'Guardrail',
  ingest: 'Ingest corpus',
  level: 'Evaluation level',
  reason: 'Reason (grounded answer)',
  retrieve: 'Retrieve (BM25)',
  rung: 'Validation rung',
  validate: 'Validate',
  // ── steps ──
  agent_think: 'Thinking',
  budget: 'Cost-ceiling check',
  chunk: 'Chunk corpus',
  cohens_kappa: "Cohen's κ (human calibration)",
  context: 'Build context',
  decision: 'Tool decision',
  decision_retry: 'Decision retry (parse failed)',
  defended_fallback: 'Defended summary (model unavailable)',
  defended_summary: 'Defended summary (model)',
  enroll: 'Enroll regression case',
  error: 'Error',
  fix: 'Apply learned fix',
  gate: 'Citation gate',
  generate: 'Generate answer (model)',
  input: 'Input prompt (to the model)',
  judge: 'LLM judge (rubric)',
  judge_fallback: 'Judge (model unavailable)',
  judge_verdict: 'Judge verdict',
  lint: 'Lint (domain sanity)',
  lint_repair: 'Lint repair (errors fed back)',
  naive: 'Naive prompt (simulated)',
  outcome: 'Outcome',
  reasoning: 'Reasoning',
  redact: 'Redact PII',
  replay: 'Replay / dry-run',
  rescan: 'Re-scan for residual PII',
  retrieval: 'Retrieval',
  retrieval_bakeoff: 'Retrieval bake-off',
  scan: 'Injection scan',
  schema: 'Schema check (structural)',
  suite_after: 'Regression suite — after fix',
  suite_before: 'Regression suite — before fix',
  synthesize: 'Synthesize answer (model)',
  terminal_check: 'Terminal predicate check',
  thinking: 'Thinking',
  tool_call: 'Tool call',
  verdict: 'Verdict',
  whitelist: 'Tool-whitelist backstop',
};

/** Title-case a snake/kebab identifier as a last-resort label. */
function titleize(id: string): string {
  return id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Human-readable label for a span/step name (falls back to title-case). */
export function humanizeTraceStep(name: string | undefined): string {
  if (!name) return 'step';
  return TRACE_LABELS[name] ?? titleize(name);
}

/** Format one scalar/array/object value compactly for the inline summary. */
function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'string') return v.length > 36 ? `${v.slice(0, 36)}…` : v;
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    // Show up to 3 short scalar items, else just the count.
    const scalars = v.every((x) => typeof x === 'string' || typeof x === 'number');
    if (scalars && v.length <= 3) return `[${v.map((x) => formatValue(x)).join(', ')}]`;
    return `${v.length} items`;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    return keys.length === 0 ? '{}' : `{${keys.length} fields}`;
  }
  return String(v);
}

/**
 * Render a trace line's `data` payload as a compact, readable one-liner such as
 * `passed=yes · errors=0 · ids=[a, b]`. Returns '' when there is nothing to show.
 * Caps the number of fields and the overall length so a long payload never blows
 * out the narrow trace column (the rest stays available via the raw payload toggle).
 */
export function summarizeTraceData(data: Record<string, unknown> | undefined, maxFields = 4, maxLen = 96): string {
  if (!data) return '';
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  const parts: string[] = [];
  for (const [k, v] of entries.slice(0, maxFields)) {
    parts.push(`${k}=${formatValue(v)}`);
  }
  if (entries.length > maxFields) parts.push(`+${entries.length - maxFields} more`);
  let out = parts.join(' · ');
  if (out.length > maxLen) out = `${out.slice(0, maxLen - 1)}…`;
  return out;
}

/** Pretty-print the full data payload (for the expandable raw view). */
export function fullTraceData(data: Record<string, unknown> | undefined): string {
  if (!data || Object.keys(data).length === 0) return '';
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}
