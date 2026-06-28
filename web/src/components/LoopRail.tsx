'use client';

// LoopRail — fixed-width column visualising the agent loop / pipeline.
// Nodes come from railFor(scenarioId).nodes (static skeleton); the active node
// is determined by real onPhase events. Highlight is PERSISTENT — stays lit
// until the next event fires (no pulse animation).

import type { PhaseEvent, ScenarioId, LoopPhaseName } from '@/types';
import { railFor } from '@/lib/scenarioPhases';

const ACCENT: Record<LoopPhaseName, { text: string; rgb: string }> = {
  input:    { text: 'text-ctx',    rgb: '34,211,238' },
  think:    { text: 'text-think',  rgb: '251,191,36' },
  generate: { text: 'text-decide', rgb: '45,212,191' },
  act:      { text: 'text-tool',   rgb: '167,139,250' },
};

export default function LoopRail({
  scenarioId,
  active,
  iteration,
}: {
  scenarioId: ScenarioId;
  active: PhaseEvent | null;
  iteration: number;
}) {
  const spec = railFor(scenarioId);

  return (
    <div className="flex w-[136px] shrink-0 flex-col gap-2">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-ink-dim">
        {spec.kind === 'agent' ? 'Agent loop' : 'Pipeline'}
      </div>

      {spec.nodes.map((node, index) => {
        const isActive =
          spec.kind === 'agent'
            ? active?.phase === node.kind
            : active?.stage === index;
        const a = ACCENT[node.kind];

        return (
          <div
            key={`${node.kind}-${index}`}
            className={`rounded-lg border px-2.5 py-2 text-[11px] font-semibold ${a.text} ${
              isActive ? 'border-current' : 'border-line'
            }`}
            style={
              isActive
                ? {
                    boxShadow: `0 0 14px rgba(${a.rgb},0.5)`,
                    backgroundColor: `rgba(${a.rgb},0.10)`,
                  }
                : { opacity: 0.55 }
            }
          >
            <span>{node.label}</span>
            {node.kind === 'act' && isActive && active?.tool && (
              <div className="mt-1 truncate text-[10px] font-normal text-tool">🔧 {active.tool}</div>
            )}
          </div>
        );
      })}

      {spec.kind === 'agent' && (
        <div className="mt-1 flex flex-col gap-0.5 text-[10px] text-decide">
          <div className="flex items-center gap-1">
            <span>↺ loop</span>
            <span className="font-bold">×{Math.max(1, iteration)}</span>
          </div>
          <div className="text-ink-dim">result → next input</div>
        </div>
      )}
    </div>
  );
}
