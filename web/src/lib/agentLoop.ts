// agentLoop.ts — STUB retained for reference. The 02 agent is now implemented as a
// Scenario (lib/scenarios/02_agent.ts) over the unified framework. This legacy class
// is kept compiling against the new contract but is not used by the framework.
import type { LLM, ToolsApi, LoopState } from '@/types';

export interface AgentLoopOpts {
  llm: LLM;
  tools: ToolsApi;
  question: string;
  maxSteps: number;
}

export class AgentLoop {
  constructor(_opts: AgentLoopOpts) {}
  getState(): LoopState {
    return {
      scenario: '02_agent',
      phase: 'idle',
      steps: [],
      current: null,
      finished: false,
      finalResult: null,
      error: null,
      trace: [],
    };
  }
  async next(): Promise<void> {
    throw new Error('not implemented');
  }
}
