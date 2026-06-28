// panelBody.test.ts — the panel rich-text highlighter.
//
// The ONE invariant that matters for honesty: highlighting is PRESENTATION ONLY.
// It may wrap characters in <span>s but must never add, drop, reorder, or alter a
// single character. If segmentLine(line) ever changed the text, the UI would be
// showing something the scenario didn't produce — exactly the "hiding something"
// failure mode we are designing against. We assert reconstruction === input on a
// representative set of the real panel strings (PII, tables, scores, tags, config).

import { describe, it, expect } from 'vitest';
import { segmentLine } from '@/components/PanelBody';

/** Re-join a line's segments back into the original string. */
function reconstruct(line: string): string {
  return segmentLine(line)
    .map((s) => s.text)
    .join('');
}

const SAMPLES = [
  'Reporter alice@example.com filed this from host 10.2.3.4.',
  'Callback +1-202-555-0143; auth header carries api_key=sk-ABCD1234efgh5678ijkl which must never ship.',
  'removed: 1×EMAIL, 1×IP, 1×PHONE, 1×SECRET   (total 4)',
  're-scan: zero residual ✓   findPii(redacted) → {} (clean)',
  '★ Rubric score: 4/5   [LLM]',
  'rung 1b · lint — FAIL   [Code]',
  '  known-BAD  [95, 96, 98, 97, 99]  avg=97.0 > 90 → FIRES ✓ (caught)',
  'The runbook explains the saturation. [cpu_saturation_runbook]',
  "  threshold = 130   on metric 'system.cpu.user' (a 0..100 % metric)",
  '#1  [cpu_cooler_buying_guide]  6.30   <- ⚠ lexical distractor',
  '',
  '   ',
  'no markup here at all, just prose about agents and tools.',
];

describe('segmentLine — honesty invariant (presentation only)', () => {
  for (const line of SAMPLES) {
    it(`preserves every character of: ${JSON.stringify(line.slice(0, 40))}`, () => {
      expect(reconstruct(line)).toBe(line);
    });
  }

  it('preserves a long multi-feature line exactly', () => {
    const line =
      'PII alice@example.com 10.2.3.4 +1-202-555-0143 → [REDACTED_EMAIL] PASS ✓ score 5/5 [LLM] `code`';
    expect(reconstruct(line)).toBe(line);
  });
});

describe('segmentLine — source chips (consistent LLM/Code vocabulary)', () => {
  it('tags an [LLM] source chip teal (model-generated)', () => {
    const seg = segmentLine('LLM · Answer [LLM]').find((s) => s.text === '[LLM]');
    expect(seg?.cls).toContain('text-decide');
  });
  it('tags a [Code] source chip grey (deterministic)', () => {
    const seg = segmentLine('Code · Retrieved [Code]').find((s) => s.text === '[Code]');
    expect(seg?.cls).toContain('text-ink-dim');
  });
});

describe('segmentLine — actually classifies meaningful tokens', () => {
  it('tags an email as a danger (leak) span', () => {
    const segs = segmentLine('contact alice@example.com now');
    const email = segs.find((s) => s.text === 'alice@example.com');
    expect(email?.cls).toBeTruthy();
    expect(email?.cls).toContain('text-danger');
  });

  it('tags a redaction placeholder as a safe (decide) span', () => {
    const segs = segmentLine('field → [REDACTED_EMAIL] done');
    const red = segs.find((s) => s.text === '[REDACTED_EMAIL]');
    expect(red?.cls).toContain('text-decide');
  });

  it('tags a rubric score', () => {
    const segs = segmentLine('SCORE: 4/5');
    const score = segs.find((s) => s.text.replace(/\s/g, '') === '4/5');
    expect(score?.cls).toContain('text-think');
  });

  it('tags FAIL red and PASS green', () => {
    expect(segmentLine('result FAIL').find((s) => s.text === 'FAIL')?.cls).toContain('text-danger');
    expect(segmentLine('result PASS').find((s) => s.text === 'PASS')?.cls).toContain('text-decide');
  });

  it('leaves plain prose untouched (single plain segment)', () => {
    const segs = segmentLine('just some ordinary words');
    expect(segs).toHaveLength(1);
    expect(segs[0].cls).toBeUndefined();
  });
});
