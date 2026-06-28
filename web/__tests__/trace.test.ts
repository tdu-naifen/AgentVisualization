// trace.test.ts — TraceBuilder: the hierarchical in-memory trace.
//
// Verifies the contract the UI's trace panel depends on: a leading `trace_start`,
// span nesting that drives `depth`, a numeric `durS` on `span_close`, a strictly
// increasing `n`, a terminal `trace_end`, and that an unbalanced `spanClose` is a
// safe no-op (tracing is best-effort and must never throw mid-run).

import { describe, it, expect } from 'vitest';
import { TraceBuilder } from '@/lib/trace';
import type { TraceLine } from '@/types';

/** Build a small but representative trace: start → span(step) → close → step → end. */
function buildSampleTrace(): TraceLine[] {
  const tr = new TraceBuilder('rag_demo', { query: 'why is my service pegging CPU' });
  tr.spanOpen('retrieve', { k: 5 });
  tr.step('retrieval', { ids: ['a', 'b'], k: 5 });
  tr.spanClose({ hits: 2 });
  tr.step('output', { answer: 'grounded' }, 'raw model response');
  tr.end({ passed: true });
  return tr.lines();
}

describe('TraceBuilder', () => {
  it('emits trace_start first at n=1, depth=0, carrying name + meta', () => {
    const lines = buildSampleTrace();
    const first = lines[0];
    expect(first.event).toBe('trace_start');
    expect(first.n).toBe(1);
    expect(first.depth).toBe(0);
    expect(first.step).toBe('rag_demo');
    expect(first.data).toEqual({ query: 'why is my service pegging CPU' });
  });

  it('nests a step logged inside an open span one level deeper (depth 1)', () => {
    const lines = buildSampleTrace();
    const open = lines.find((l) => l.event === 'span_open');
    const nestedStep = lines.find((l) => l.event === 'step' && l.step === 'retrieval');
    expect(open?.depth).toBe(0);
    expect(nestedStep?.depth).toBe(1);
  });

  it('logs a step outside any span back at depth 0 and carries rawResponse', () => {
    const lines = buildSampleTrace();
    const outputStep = lines.find((l) => l.event === 'step' && l.step === 'output');
    expect(outputStep?.depth).toBe(0);
    expect(outputStep?.rawResponse).toBe('raw model response');
  });

  it('closes the span at its outer depth with a numeric durS', () => {
    const lines = buildSampleTrace();
    const close = lines.find((l) => l.event === 'span_close');
    expect(close).toBeDefined();
    expect(close?.step).toBe('retrieve');
    expect(close?.depth).toBe(0); // back at the depth span_open was emitted on
    expect(typeof close?.durS).toBe('number');
    expect(Number.isFinite(close?.durS)).toBe(true);
    expect(close?.durS).toBeGreaterThanOrEqual(0);
  });

  it('assigns a strictly increasing 1-based n across every line', () => {
    const lines = buildSampleTrace();
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].n).toBe(1);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].n).toBeGreaterThan(lines[i - 1].n);
    }
    // contiguous as well as increasing
    expect(lines.map((l) => l.n)).toEqual(lines.map((_, i) => i + 1));
  });

  it('ends with trace_end (depth 0, numeric durS) as the last line', () => {
    const lines = buildSampleTrace();
    const last = lines[lines.length - 1];
    expect(last.event).toBe('trace_end');
    expect(last.depth).toBe(0);
    expect(typeof last.durS).toBe('number');
    // trace_end appears exactly once
    expect(lines.filter((l) => l.event === 'trace_end')).toHaveLength(1);
  });

  it('treats spanClose with no open span as a safe no-op (no throw, no line)', () => {
    const tr = new TraceBuilder('empty');
    const before = tr.lines().length; // just the trace_start
    expect(() => tr.spanClose()).not.toThrow();
    expect(tr.lines().length).toBe(before);
  });

  it('is idempotent on end() and ignores work after end()', () => {
    const tr = new TraceBuilder('once');
    tr.end({ a: 1 });
    const afterFirstEnd = tr.lines().length;
    tr.end({ b: 2 }); // second end is a no-op
    tr.step('late', { ignored: true }); // post-end work is dropped
    tr.spanOpen('late-span');
    expect(tr.lines().length).toBe(afterFirstEnd);
    expect(tr.lines().filter((l) => l.event === 'trace_end')).toHaveLength(1);
  });
});
