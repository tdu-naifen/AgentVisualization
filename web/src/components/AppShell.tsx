'use client';

// AppShell — overall layout + scenario switcher.
//
// Top bar: gradient app title, a horizontal row of scenario pill tabs (active =
// teal filled, inactive = outlined), and the `modelLoader` node pinned
// top-right. Below: a content area that renders `children` (the step view +
// trace panel). AppShell just frames it — `children` decides the inner layout.

import { motion } from 'framer-motion';
import type { ScenarioMeta, ScenarioId } from '@/types';

interface AppShellProps {
  scenarios: ScenarioMeta[];
  activeId: ScenarioId;
  onSelect: (id: ScenarioId) => void;
  modelLoader: React.ReactNode;
  children: React.ReactNode;
}

export default function AppShell({
  scenarios,
  activeId,
  onSelect,
  modelLoader,
  children,
}: AppShellProps) {
  const active = scenarios.find((s) => s.id === activeId);

  return (
    <div className="min-h-screen bg-app text-ink-base">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 px-5 py-6">
        {/* ── top bar ───────────────────────────────────────────────────── */}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <h1 className="bg-accent bg-clip-text text-2xl font-bold tracking-tight text-transparent">
              Agent Loop Explainer 🧠
            </h1>
            {active && <p className="text-[12px] text-ink-dim">{active.subtitle}</p>}
            {/* Honest framing, always visible: the model runs in YOUR browser and
                tools are called in-process (a function call, not MCP / no server). */}
            <div className="mt-1 flex flex-wrap gap-1.5">
              <span className="rounded-full border border-line bg-bg-card/40 px-2 py-0.5 text-[10px] text-ink-faint">
                Gemma 4 in-browser · WebGPU
              </span>
              <span className="rounded-full border border-line bg-bg-card/40 px-2 py-0.5 text-[10px] text-ink-faint">
                in-process tool use · no server
              </span>
              <span className="rounded-full border border-decide/30 bg-decide/10 px-2 py-0.5 text-[10px] text-decide">
                the model really decides
              </span>
            </div>
          </div>
          <div className="shrink-0">{modelLoader}</div>
        </header>

        {/* ── scenario pill tabs ────────────────────────────────────────── */}
        <nav className="flex flex-wrap gap-2">
          {scenarios.map((s) => {
            const isActive = s.id === activeId;
            return (
              <motion.button
                key={s.id}
                type="button"
                onClick={() => onSelect(s.id)}
                whileTap={{ scale: 0.95 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                aria-pressed={isActive}
                title={s.subtitle}
                className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors ${
                  isActive
                    ? 'bg-decide text-bg-base shadow-neon'
                    : 'border border-line text-ink-dim hover:text-ink-base'
                }`}
              >
                {s.title}
              </motion.button>
            );
          })}
        </nav>

        {/* ── content ───────────────────────────────────────────────────── */}
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
