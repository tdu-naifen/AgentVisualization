// traceView.test.ts — humanizing trace step names + summarizing data payloads.
//
// These power the trace panel's readability (the "step/whitelist — what is this?"
// fix). The invariants we lock: known machine names map to human labels, unknown
// names degrade to title-case (never raw snake), and the data summary reflects the
// recorded payload faithfully and stays within its length budget.

import { describe, it, expect } from 'vitest';
import { humanizeTraceStep, summarizeTraceData, fullTraceData } from '@/lib/traceView';

describe('humanizeTraceStep', () => {
  it('maps known machine names to human-readable labels', () => {
    expect(humanizeTraceStep('whitelist')).toBe('Tool-whitelist backstop');
    expect(humanizeTraceStep('terminal_check')).toBe('Terminal predicate check');
    expect(humanizeTraceStep('redact')).toBe('Redact PII');
    expect(humanizeTraceStep('judge_verdict')).toBe('Judge verdict');
  });

  it('title-cases unknown names instead of showing raw snake_case', () => {
    expect(humanizeTraceStep('some_new_step')).toBe('Some New Step');
    expect(humanizeTraceStep('foo')).toBe('Foo');
  });

  it('falls back to a safe label for empty/undefined', () => {
    expect(humanizeTraceStep(undefined)).toBe('step');
    expect(humanizeTraceStep('')).toBe('step');
  });
});

describe('summarizeTraceData', () => {
  it('renders booleans as yes/no and keeps integers exact', () => {
    expect(summarizeTraceData({ passed: true, errors: 0 })).toBe('passed=yes · errors=0');
  });

  it('shows short scalar arrays inline, collapses long ones to a count', () => {
    expect(summarizeTraceData({ ids: ['a', 'b'] })).toBe('ids=[a, b]');
    expect(summarizeTraceData({ ids: ['a', 'b', 'c', 'd'] })).toBe('ids=4 items');
  });

  it('caps the number of fields with a "+N more" suffix', () => {
    const s = summarizeTraceData({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }, 4);
    expect(s).toContain('+2 more');
  });

  it('respects the overall length budget', () => {
    const s = summarizeTraceData({ note: 'x'.repeat(200) }, 4, 40);
    expect(s.length).toBeLessThanOrEqual(40);
  });

  it('returns empty string for empty/undefined payloads', () => {
    expect(summarizeTraceData(undefined)).toBe('');
    expect(summarizeTraceData({})).toBe('');
  });
});

describe('fullTraceData', () => {
  it('pretty-prints a payload as JSON', () => {
    expect(fullTraceData({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
  it('is empty for nothing to show', () => {
    expect(fullTraceData(undefined)).toBe('');
    expect(fullTraceData({})).toBe('');
  });
});
