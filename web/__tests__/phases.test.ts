import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ChatMsg, Doc, LLM, StepCallbacks, ToolCall } from '@/types';
import { CancelledError } from '@/lib/cancel';
import { makeAgentScenario } from '@/lib/scenarios/02_agent';

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
    const cb: StepCallbacks = { onStream: () => {}, onTrace: () => {} };
    await expect(scenario.next(cb)).rejects.toBeInstanceOf(CancelledError);
    // After a cancel, the scenario is finished (the loop won't spin) and produced no
    // committed step the caller must show.
    expect(scenario.isFinished()).toBe(true);
  });
});
