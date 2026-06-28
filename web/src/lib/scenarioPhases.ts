// scenarioPhases.ts — the LoopRail's source of truth for WHICH phases each scenario
// lights and whether it loops back. Honest mapping: agents (02/04) run the full
// input→think→generate→act loop; workflows light nodes with their REAL stage names
// colored by state-kind (model stage = generate, tool/retrieval stages = act). This
// is metadata only — the live rail is driven by real onPhase events during a run;
// this just declares the static skeleton + the agent/workflow shape.

import type { ScenarioId, LoopPhaseName } from '@/types';
export interface RailNode { kind: LoopPhaseName; label: string; }
interface RailSpec { kind: 'agent' | 'workflow'; nodes: RailNode[]; }
const AGENT: RailNode[] = [
  { kind: 'input', label: 'INPUT' }, { kind: 'think', label: 'THINK' },
  { kind: 'generate', label: 'GENERATE' }, { kind: 'act', label: 'ACT' },
];
const SPECS: Record<ScenarioId, RailSpec> = {
  '02_agent': { kind: 'agent', nodes: AGENT },
  '04_search': { kind: 'agent', nodes: AGENT },
  '01_rag': { kind: 'workflow', nodes: [{kind:'act',label:'Retrieve'},{kind:'generate',label:'Reason'},{kind:'act',label:'Answer'}] },
  '03_eval': { kind: 'workflow', nodes: [{kind:'act',label:'L1'},{kind:'act',label:'L2'},{kind:'generate',label:'L3'},{kind:'act',label:'L4'}] },
  '05_validation': { kind: 'workflow', nodes: [{kind:'act',label:'Schema'},{kind:'act',label:'Lint'},{kind:'act',label:'Replay'},{kind:'generate',label:'Judge'},{kind:'act',label:'Human'}] },
  '07_safety': { kind: 'workflow', nodes: [{kind:'act',label:'PII'},{kind:'generate',label:'Injection'},{kind:'act',label:'Cost'},{kind:'act',label:'Flywheel'}] },
};
export function railFor(id: ScenarioId): RailSpec { return SPECS[id]; }
export const AGENT_NODES = AGENT;
