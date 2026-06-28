// scenarioPhases.ts — the LoopRail's source of truth for WHICH phases each scenario
// lights and whether it loops back. Honest mapping: agents (02/04) run the full
// receive→think→act→observe loop; workflows light the nodes they genuinely use and
// do NOT loop. This is metadata only — the live rail is driven by real onPhase events
// during a run; this just declares the static skeleton + the agent/workflow shape.

import type { ScenarioId, LoopPhaseName } from '@/types';

export interface RailNode {
  phase: LoopPhaseName;
  label: string;
}

/** The canonical four-node loop, top to bottom. */
export const RAIL_NODES: RailNode[] = [
  { phase: 'receive', label: 'RECEIVE' },
  { phase: 'think', label: 'THINK' },
  { phase: 'act', label: 'ACT' },
  { phase: 'observe', label: 'OBSERVE' },
];

interface RailSpec {
  kind: 'agent' | 'workflow';
  nodes: LoopPhaseName[];
}

// Workflows declare the nodes they honestly use. A model-free stage skips 'think'
// (the rail greys it), reinforcing "only one stage calls the model".
const SPECS: Record<ScenarioId, RailSpec> = {
  '02_agent': { kind: 'agent', nodes: ['receive', 'think', 'act', 'observe'] },
  '04_search': { kind: 'agent', nodes: ['receive', 'think', 'act', 'observe'] },
  '01_rag': { kind: 'workflow', nodes: ['receive', 'think', 'observe'] },
  '03_eval': { kind: 'workflow', nodes: ['receive', 'think', 'observe'] },
  '05_validation': { kind: 'workflow', nodes: ['receive', 'think', 'observe'] },
  '07_safety': { kind: 'workflow', nodes: ['receive', 'think', 'observe'] },
};

/** The rail spec for a scenario: its kind (loops or not) + which nodes it lights. */
export function railFor(id: ScenarioId): RailSpec {
  return SPECS[id];
}
