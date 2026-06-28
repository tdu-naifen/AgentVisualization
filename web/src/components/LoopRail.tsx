'use client';

// LoopRail — a fixed-width column visualizing the agent loop. Four nodes
// (RECEIVE→THINK→ACT→OBSERVE); the active phase pulses, completed are solid, pending
// dim. For AGENTS a ↺ loop-back connector + iteration count makes the loop visible;
// for WORKFLOWS the same nodes render straight (no loop-back) and a model-free node
// (one not in the scenario's node set) is greyed. Driven by REAL onPhase events.

import { motion } from 'framer-motion';
import type { PhaseEvent, ScenarioId, LoopPhaseName } from '@/types';
import { RAIL_NODES, railFor } from '@/lib/scenarioPhases';

const ACCENT: Record<LoopPhaseName, { text: string; rgb: string }> = {
  receive: { text: 'text-ctx', rgb: '34,211,238' },
  think: { text: 'text-think', rgb: '251,191,36' },
  act: { text: 'text-tool', rgb: '167,139,250' },
  observe: { text: 'text-observe', rgb: '244,114,182' },
  conclude: { text: 'text-decide', rgb: '45,212,191' },
};

export default function LoopRail({
  scenarioId,
  active,
  iteration,
  running,
}: {
  scenarioId: ScenarioId;
  active: PhaseEvent | null;
  iteration: number;
  running: boolean;
}) {
  const spec = railFor(scenarioId);
  const lit = new Set(spec.nodes);
  const activePhase = active?.phase ?? null;

  return (
    <div className="flex w-[136px] shrink-0 flex-col gap-2">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-dim">
        {spec.kind === 'agent' ? 'Agent loop' : 'Pipeline'}
      </div>
      {RAIL_NODES.map((node) => {
        const inUse = lit.has(node.phase);
        const isActive = activePhase === node.phase && running;
        const a = ACCENT[node.phase];
        return (
          <motion.div
            key={node.phase}
            className={`rounded-lg border px-2.5 py-2 text-[11px] font-semibold ${
              inUse ? a.text : 'text-ink-faint'
            } ${isActive ? 'border-current' : 'border-line'}`}
            style={
              isActive
                ? { boxShadow: `0 0 14px rgba(${a.rgb},0.5)`, backgroundColor: `rgba(${a.rgb},0.10)` }
                : undefined
            }
            animate={isActive ? { opacity: [1, 0.55, 1] } : { opacity: inUse ? 1 : 0.4 }}
            transition={isActive ? { duration: 1, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
          >
            <div className="flex items-center justify-between gap-1">
              <span>{node.label}</span>
              {!inUse && <span className="text-[8px] uppercase text-ink-faint">model-free</span>}
            </div>
            {node.phase === 'act' && active?.phase === 'act' && active.tool && (
              <div className="mt-1 truncate text-[10px] font-normal text-tool">🔧 {active.tool}</div>
            )}
          </motion.div>
        );
      })}
      {spec.kind === 'agent' && (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-decide">
          <span>↺ loop</span>
          <span className="font-bold">×{Math.max(1, iteration)}</span>
        </div>
      )}
    </div>
  );
}
