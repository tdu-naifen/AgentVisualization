import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Doc, LLM, StepCallbacks, ToolCall, TraceLine } from '@/types';
import { CancelledError } from '@/lib/cancel';
import { makeAgentScenario } from '@/lib/scenarios/02_agent';
import { railFor, RAIL_NODES } from '@/lib/scenarioPhases';

const DOCS: Doc[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/corpus.json', import.meta.url)), 'utf8'),
) as Doc[];

/** A fake LLM whose think()/stream() throw CancelledError mid-call (simulating a
 *  user pause), so we can assert the scenario surfaces a cancel, not a red error. */
class CancellingLLM implements LLM {
  async load(): Promise<void> {}
  ready(): boolean { return true; }
  async stream(): Promise<string> { throw new CancelledError(); }
  async think(): Promise<string> { throw new CancelledError(); }
  async decide(): Promise<ToolCall> { throw new CancelledError(); }
  cancel(): void {}
}

describe('cancellation surfaces as a clean terminal (not an error)', () => {
  it('02 agent: a cancelled think() rejects with CancelledError and finishes the run', async () => {
    const scenario = makeAgentScenario(new CancellingLLM(), DOCS);
    // Capture the trace lines so we can prove WHICH terminal the cancel produced —
    // not just that next() rejected (the old catch block rejected + finished too).
    const traceLines: TraceLine[] = [];
    const cb: StepCallbacks = { onStream: () => {}, onTrace: (l) => traceLines.push(l) };
    await expect(scenario.next(cb)).rejects.toBeInstanceOf(CancelledError);
    // After a cancel, the scenario is finished (the loop won't spin) and produced no
    // committed step the caller must show.
    expect(scenario.isFinished()).toBe(true);
    // Prove the NEW cancel branch, not the pre-existing rethrow: a cancel must NOT
    // record an `error` step line, and the trace must end cleanly as { cancelled: true }.
    // The OLD catch emitted a 'step'/'error' line and ended { error: true }, so BOTH of
    // these assertions fail on the pre-Task-4 source — that's what gives them teeth.
    expect(traceLines.some((l) => l.event === 'step' && l.step === 'error')).toBe(false);
    expect(traceLines.at(-1)).toMatchObject({ event: 'trace_end', data: { cancelled: true } });
  });
});

describe('scenarioPhases metadata', () => {
  it('agents loop, workflows do not', () => {
    expect(railFor('02_agent').kind).toBe('agent');
    expect(railFor('04_search').kind).toBe('agent');
    expect(railFor('01_rag').kind).toBe('workflow');
    expect(railFor('03_eval').kind).toBe('workflow');
    expect(railFor('05_validation').kind).toBe('workflow');
    expect(railFor('07_safety').kind).toBe('workflow');
  });

  it('agents light all four loop nodes', () => {
    const nodes = railFor('02_agent').nodes;
    expect(nodes).toEqual(['receive', 'think', 'act', 'observe']);
  });

  it('RAIL_NODES is the canonical ordering', () => {
    expect(RAIL_NODES.map((n) => n.phase)).toEqual(['receive', 'think', 'act', 'observe']);
  });
});
