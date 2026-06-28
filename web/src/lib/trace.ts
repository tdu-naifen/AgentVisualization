// trace.ts — a tiny hierarchical, in-memory trace builder for one demo run.
//
// Browser-side mirror of reference/shared/trace.py: an append-only sequence of
// typed lines where spans open/close in pairs and nest (depth increases inside
// an open span). Unlike the Python version it writes nothing to disk — it just
// accumulates `TraceLine[]` for a langsmith-style trace panel to render.
//
// Conceptual model (matches trace.py):
//   trace_start            depth 0          — the run begins (carries name + meta)
//     span_open  agent     depth 0          — open a nested span
//       step     tool_call depth 1          — work logged inside the span nests
//     span_close agent     depth 0  durS    — close pairs with its open, has a duration
//   trace_end              depth 0  durS    — the run ends, carries total duration
//
// The `TraceLine` shape is fixed by @/types (the contract). Fields that exist in
// the Python writer but not in the contract are mapped onto allowed fields:
//   • trace_start: `name` -> step, `meta` -> data
//   • trace_end:   `summary` -> data, total duration -> durS
//   • span_*:      span label -> step
// Pure and deterministic: no React, no DOM mutation, no model/transformers imports.

import type { TraceEvent, TraceLine } from '@/types';

/** One open span on the depth stack: its label + the clock reading at open. */
interface SpanFrame {
  step: string;
  t0: number;
}

/** Round to 4 decimal places, mirroring trace.py's `round(x, 4)` for durations. */
function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/**
 * Read a monotonic-ish clock in milliseconds. Prefers `performance.now()` (high
 * resolution, monotonic) when available in the host, else falls back to
 * `Date.now()`. Both return milliseconds, so callers divide by 1000 for seconds.
 */
function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Builds a hierarchical trace as an append-only `TraceLine[]`.
 *
 * Usage:
 *   const tr = new TraceBuilder('rag_demo', { query });
 *   tr.spanOpen('retrieve');
 *   tr.step('retrieval', { ids, k: 5 });
 *   tr.spanClose();
 *   tr.step('output', { answer }, rawLlmResponse);
 *   tr.end({ passed: true });
 *   const trace = tr.lines();
 *
 * `n` is a 1-based monotonic counter across every emitted line; `depth` is driven
 * by the open-span stack so nested work indents correctly in the panel.
 */
export class TraceBuilder {
  private readonly all: TraceLine[] = [];
  private readonly stack: SpanFrame[] = [];
  private readonly t0: number = nowMs();
  private counter = 0;
  private ended = false;

  /** Open the trace, emitting `trace_start` (n=1, depth=0). */
  constructor(name: string, meta?: Record<string, unknown>) {
    this.push({ event: 'trace_start', depth: 0, step: name, data: meta ?? {} });
  }

  /**
   * Open a nested span. The `span_open` line sits at the current depth; every
   * line logged after it (until the matching `spanClose`) nests one level deeper.
   */
  spanOpen(step: string, data?: Record<string, unknown>): void {
    if (this.ended) return;
    this.push({ event: 'span_open', depth: this.stack.length, step, data: data ?? {} });
    this.stack.push({ step, t0: nowMs() });
  }

  /**
   * Close the most recently opened span, emitting `span_close` at the span's own
   * (outer) depth with its wall-clock duration in seconds. A `spanClose` with no
   * matching open span is a safe no-op (never throws), so unbalanced calls can't
   * break a run — tracing is best-effort, exactly as in trace.py.
   */
  spanClose(data?: Record<string, unknown>): void {
    if (this.ended) return;
    const frame = this.stack.pop();
    if (frame === undefined) return; // no open span — safe no-op
    this.push({
      event: 'span_close',
      depth: this.stack.length, // back at the depth the span_open was emitted on
      step: frame.step,
      data: data ?? {},
      durS: round4((nowMs() - frame.t0) / 1000),
    });
  }

  /**
   * Log one step at the current open depth. `data` holds the step's salient
   * structured values; `rawResponse`, when given, is the verbatim LLM output for
   * this step (expandable in the panel).
   */
  step(step: string, data?: Record<string, unknown>, rawResponse?: string): void {
    if (this.ended) return;
    const line: Omit<TraceLine, 'n'> = {
      event: 'step',
      depth: this.stack.length,
      step,
      data: data ?? {},
    };
    if (rawResponse !== undefined) line.rawResponse = rawResponse;
    this.push(line);
  }

  /**
   * Emit the terminal `trace_end` line (depth 0) with the total run duration in
   * seconds and an optional summary. Idempotent: calling `end` more than once, or
   * any builder method after it, is a no-op so the trace stays well-formed.
   */
  end(summary?: Record<string, unknown>): void {
    if (this.ended) return;
    this.push({
      event: 'trace_end',
      depth: 0,
      data: summary ?? {},
      durS: round4((nowMs() - this.t0) / 1000),
    });
    this.ended = true;
  }

  /** A snapshot of the accumulated trace lines, in emission order. */
  lines(): TraceLine[] {
    return [...this.all];
  }

  /** Assign the running 1-based counter and append one line. */
  private push(line: Omit<TraceLine, 'n'>): void {
    this.all.push({ n: ++this.counter, ...line });
  }
}

// Re-export the event union for convenience so consumers can `import { TraceEvent }`
// from this module alongside the builder without reaching back into @/types.
export type { TraceEvent };
