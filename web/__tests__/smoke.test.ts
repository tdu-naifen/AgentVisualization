// smoke.test.ts — drive ALL 7 scenarios to completion with a fake LLM.
//
// This is the runtime safety net the project relied on during development (the
// real Gemma model never loads in a test/dev context). It instantiates every
// scenario through its factory, then presses "Next" (scenario.next) in a loop
// until isFinished(), exactly as page.tsx does — asserting the loop always
// halts, produces steps, and commits a trace. It does NOT assert model-quality
// (a fake LLM can't), only that the framework + each scenario's control flow is
// sound: no throw, bounded steps, a non-empty trace, atomic-per-step commit.
//
// The fake LLM implements the LLM interface deterministically and, for decide(),
// walks a sensible 6-tool sequence so the 02 agent reaches mark_done instead of
// tripping the stall guard — while a SECOND test forces a stalling fake to prove
// the stall guard halts the loop honestly (no infinite spin, no fabricated done).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ChatMsg, Doc, LLM, Scenario, StepCallbacks, ToolCall, ToolName, TraceLine } from '@/types';
import { makeRagScenario } from '@/lib/scenarios/01_rag';
import { makeAgentScenario } from '@/lib/scenarios/02_agent';
import { makeEvalScenario } from '@/lib/scenarios/03_eval';
import { makeSearchScenario } from '@/lib/scenarios/04_search';
import { makeValidationScenario } from '@/lib/scenarios/05_validation';
import { makeCompareScenario } from '@/lib/scenarios/06_compare';
import { makeSafetyScenario } from '@/lib/scenarios/07_safety';

const CORPUS_PATH = fileURLToPath(new URL('../public/corpus.json', import.meta.url));
const DOCS: Doc[] = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Doc[];

// A hard ceiling so a runaway scenario fails the test loudly instead of hanging.
const MAX_DRIVE_STEPS = 40;

/**
 * A deterministic fake LLM. think()/stream() emit a short canned text (streamed
 * char-by-char through onToken so the streaming path is exercised). decide()
 * walks a realistic tool sequence keyed off how many calls it has already made,
 * so the agent loop genuinely progresses to mark_done.
 */
class FakeLLM implements LLM {
  private decideCalls = 0;
  constructor(private readonly script?: (n: number) => ToolCall) {}

  async load(): Promise<void> {}
  ready(): boolean {
    return true;
  }

  private async emit(text: string, onToken: (t: string) => void): Promise<string> {
    for (const ch of text) onToken(ch);
    return text;
  }

  async stream(_messages: ChatMsg[], onToken: (t: string) => void): Promise<string> {
    return this.emit('Fake answer grounded in [cpu_saturation_runbook]. SCORE: 4/5', onToken);
  }
  async think(_messages: ChatMsg[], onToken: (t: string) => void): Promise<string> {
    return this.emit('Fake reasoning: pick the single next action.', onToken);
  }
  async decide(_messages: ChatMsg[], _schemaHint: string, onToken?: (t: string) => void): Promise<ToolCall> {
    const n = this.decideCalls++;
    const tc = this.script ? this.script(n) : defaultToolSequence(n);
    if (onToken) onToken(JSON.stringify(tc));
    return tc;
  }
}

/** A sensible progressive-disclosure walk ending in mark_done (drives 02 to success). */
function defaultToolSequence(n: number): ToolCall {
  const mk = (tool: ToolName, args: Record<string, unknown>): ToolCall => ({ tool, args });
  switch (n) {
    case 0:
      return mk('search_corpus', { query: 'cpu saturation root cause', k: 5 });
    case 1:
      return mk('get_doc_summary', { doc_id: 'cpu_saturation_runbook' });
    case 2:
      return mk('get_doc', { doc_id: 'cpu_saturation_runbook' });
    case 3:
      return mk('propose_action', { kind: 'rollback_deploy', target: 'search-svc' });
    case 4:
      return mk('apply_action_dry_run', { action_id: 'act-1' });
    default:
      return mk('mark_done', { result: { root_cause: 'hot loop from deploy', remediation: 'rollback_deploy' } });
  }
}

/** Drive a scenario to completion, collecting steps + trace, with a hard ceiling. */
async function drive(scenario: Scenario): Promise<{ steps: number; trace: TraceLine[] }> {
  const trace: TraceLine[] = [];
  let steps = 0;
  const cb: StepCallbacks = {
    onStream: () => {},
    onTrace: (t) => trace.push(t),
  };
  while (!scenario.isFinished() && steps < MAX_DRIVE_STEPS) {
    const step = await scenario.next(cb);
    expect(step).toBeTruthy();
    expect(typeof step.index).toBe('number');
    steps += 1;
  }
  return { steps, trace };
}

const FACTORIES: Array<{ id: string; make: (llm: LLM, docs: Doc[]) => Scenario }> = [
  { id: '01_rag', make: makeRagScenario },
  { id: '02_agent', make: makeAgentScenario },
  { id: '03_eval', make: makeEvalScenario },
  { id: '04_search', make: makeSearchScenario },
  { id: '05_validation', make: makeValidationScenario },
  { id: '06_compare', make: makeCompareScenario },
  { id: '07_safety', make: makeSafetyScenario },
];

describe('smoke: every scenario runs to completion', () => {
  for (const { id, make } of FACTORIES) {
    it(`${id} drives to isFinished() within the ceiling, with steps + trace`, async () => {
      const scenario = make(new FakeLLM(), DOCS);
      const { steps, trace } = await drive(scenario);
      expect(scenario.isFinished()).toBe(true); // it actually halted (didn't hit the ceiling)
      expect(steps).toBeGreaterThan(0);
      expect(steps).toBeLessThan(MAX_DRIVE_STEPS);
      expect(trace.length).toBeGreaterThan(0); // a real trace was committed
    });
  }

  it('02 agent ENDS on a conclusion, not a dangling tool call (root cause + remediation)', async () => {
    // The user's report: the loop hit the step cap right after apply_action_dry_run
    // and stopped with NO answer ("应该给个 root cause 不是么?"). Every terminal run must
    // now carry a 'conclusion' panel — whether it ended via mark_done or the budget.
    const scenario = makeAgentScenario(new FakeLLM(), DOCS);
    const steps: import('@/types').StepView[] = [];
    const cb: StepCallbacks = { onStream: () => {}, onTrace: () => {} };
    while (!scenario.isFinished() && steps.length < MAX_DRIVE_STEPS) {
      steps.push(await scenario.next(cb));
    }
    expect(scenario.isFinished()).toBe(true);
    const last = steps[steps.length - 1];
    const conclusion = last.panels.find((p) => p.key === 'conclusion');
    expect(conclusion, 'terminal step has a conclusion panel').toBeTruthy();
    expect(conclusion!.body.length).toBeGreaterThan(0);
    // The conclusion is LLM-sourced (so it's labeled honestly), not a code block.
    expect(conclusion!.label).toContain('LLM');
    // Only the FINAL step concludes — earlier steps don't carry a conclusion panel.
    const concludingSteps = steps.filter((s) => s.panels.some((p) => p.key === 'conclusion'));
    expect(concludingSteps.length).toBe(1);
  });

  it('02 agent budget-capped run STILL concludes (no dangling action)', async () => {
    // Force a non-terminating model that never calls mark_done: it only ever opens
    // doc summaries for DISTINCT ids, so it advances every step (no stall) until the
    // MAX_STEPS budget halts it. Even then, the last step must conclude.
    const ids = ['shard_restart_e1342', 'postmortem_shard_e1342', 'oncall_runbook_index',
      'vendor_escalation', 'shard_rebalance_runbook', 'cpu_saturation_runbook'];
    const walker = new FakeLLM((n) =>
      n === 0
        ? { tool: 'search_corpus', args: { query: 'E1342', k: 5 } }
        : { tool: 'get_doc_summary', args: { doc_id: ids[n % ids.length] } },
    );
    const scenario = makeAgentScenario(walker, DOCS);
    let last: import('@/types').StepView | null = null;
    const cb: StepCallbacks = { onStream: () => {}, onTrace: () => {} };
    let steps = 0;
    while (!scenario.isFinished() && steps < MAX_DRIVE_STEPS) {
      last = await scenario.next(cb);
      steps += 1;
    }
    expect(scenario.isFinished()).toBe(true);
    // It halted on the BUDGET (never marked done) — and still produced a conclusion.
    expect(last?.panels.some((p) => p.key === 'conclusion')).toBe(true);
  });

  it('reset() lets a scenario run again cleanly', async () => {
    const scenario = makeAgentScenario(new FakeLLM(), DOCS);
    await drive(scenario);
    scenario.reset();
    expect(scenario.isFinished()).toBe(false);
    const { steps } = await drive(scenario);
    expect(steps).toBeGreaterThan(0);
    expect(scenario.isFinished()).toBe(true);
  });

  it('02 agent every step carries an input-prompt panel (A4: see the prompt)', async () => {
    const scenario = makeAgentScenario(new FakeLLM(), DOCS);
    const steps: import('@/types').StepView[] = [];
    const cb: StepCallbacks = { onStream: () => {}, onTrace: () => {} };
    while (!scenario.isFinished() && steps.length < MAX_DRIVE_STEPS) {
      steps.push(await scenario.next(cb));
    }
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      const input = step.panels.find((p) => p.key === 'input');
      expect(input, `step ${step.index} has an input panel`).toBeTruthy();
      // The input panel must actually contain the prompt text (system + context).
      expect(input!.body).toContain('SYSTEM:');
    }
  });

  it('02 agent stamps trace lines so the trace can jump to a step (A8)', async () => {
    const scenario = makeAgentScenario(new FakeLLM(), DOCS);
    // Mimic page.tsx commit-time stamping: every line from a step gets step.index.
    const stampedStepIndexes = new Set<number>();
    const cb: StepCallbacks = { onStream: () => {}, onTrace: () => {} };
    let steps = 0;
    while (!scenario.isFinished() && steps < MAX_DRIVE_STEPS) {
      const pending: TraceLine[] = [];
      const stepCb: StepCallbacks = { onStream: () => {}, onTrace: (t) => pending.push(t) };
      const step = await scenario.next(stepCb);
      // page.tsx stamps each pending line with step.index — assert there ARE lines
      // to stamp and the index is a valid committed step.
      expect(pending.length).toBeGreaterThan(0);
      stampedStepIndexes.add(step.index);
      steps += 1;
      void cb;
    }
    expect(stampedStepIndexes.size).toBe(steps); // one distinct step index per step
  });

  it('streamed LLM boxes survive commit (the framework merge keeps them visible)', async () => {
    // The core bug: scenarios stream Thinking/Decision/Answer boxes live but commit
    // only `panels`, so the boxes vanished on commit. page.tsx now MERGES every box
    // seen via onStream into the committed step. We reproduce that merge here and
    // assert the agent's streamed boxes are present in the committed step — so the
    // user's "thinking 突然消失" / "agent 的输出没有 append" can't regress.
    const scenario = makeAgentScenario(new FakeLLM(), DOCS);
    let committedStreamCount = 0;
    let sawThinking = false;
    let sawDecision = false;
    let steps = 0;
    while (!scenario.isFinished() && steps < MAX_DRIVE_STEPS) {
      const liveStreams = new Map<string, import('@/types').LlmStream>();
      const cb: StepCallbacks = {
        onStream: (s) => liveStreams.set(s.id, s), // page.tsx accumulates live boxes
        onTrace: () => {},
      };
      const step = await scenario.next(cb);
      // The page.tsx merge: union of step.streams + every live-streamed box (by id).
      const seen = new Set(step.streams.map((x) => x.id));
      const merged = [...step.streams, ...[...liveStreams.values()].filter((x) => !seen.has(x.id))];
      committedStreamCount += merged.length;
      for (const s of merged) {
        if (s.kind === 'thinking') sawThinking = true;
        if (s.kind === 'decision') sawDecision = true;
      }
      steps += 1;
    }
    // The agent streams a Thinking AND a Decision box every step — both must persist.
    expect(committedStreamCount).toBeGreaterThan(0);
    expect(sawThinking).toBe(true);
    expect(sawDecision).toBe(true);
  });

  it('01 rag is a 3-stage pipeline (Ingest dropped): retrieve → reason → validate', async () => {
    const scenario = makeRagScenario(new FakeLLM(), DOCS);
    const titles: string[] = [];
    const cb: StepCallbacks = { onStream: () => {}, onTrace: () => {} };
    while (!scenario.isFinished() && titles.length < MAX_DRIVE_STEPS) {
      titles.push((await scenario.next(cb)).title);
    }
    expect(titles).toEqual(['Retrieve', 'Reason', 'Validate']); // no 'Ingest'
  });
});

describe('smoke: 02 agent stall guard halts an infinitely-repeating model', () => {
  it('a model that always repeats the SAME search halts via the GUARD, not the step cap', async () => {
    // The pathological case the user hit: identical search_corpus forever.
    const stalling = new FakeLLM(() => ({ tool: 'search_corpus', args: { query: 'cpu saturation root cause', k: 5 } }));
    const scenario = makeAgentScenario(stalling, DOCS);

    // Capture the final committed step so we can assert HOW it ended.
    let lastStep: import('@/types').StepView | null = null;
    const cb: StepCallbacks = { onStream: () => {}, onTrace: () => {} };
    let steps = 0;
    while (!scenario.isFinished() && steps < MAX_DRIVE_STEPS) {
      lastStep = await scenario.next(cb);
      steps += 1;
    }

    expect(scenario.isFinished()).toBe(true);
    // The GUARD fires on the FIRST repeat (step 2) — strictly before the MAX_STEPS=6
    // cap. If this ever needs all 6 steps, the guard regressed and the cap caught it.
    expect(steps).toBeLessThanOrEqual(2);
    // It halted HONESTLY: a visible stall guardrail, and NO fabricated mark_done.
    expect(lastStep?.guardrail).toBe('loop_stalled');
    expect(lastStep?.panels.some((p) => p.key === 'stalled')).toBe(true);
    // The stall path returns before executing any tool, so there is no observation
    // panel and no mark_done was ever called — the run did not pretend to finish.
    expect(lastStep?.panels.some((p) => p.key === 'observation')).toBe(false);
  });
});
