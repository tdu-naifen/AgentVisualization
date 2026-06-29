'use client';

// LearnView — the concept landing. Teaches the loop once (what input/think/generate/
// act mean; tool/trace/guardrail), then lists scenarios as cards in two groups:
// Agents (loop) vs Workflows (pipeline). Clicking a card opens its live run.

import { motion } from 'framer-motion';
import type { ScenarioMeta, ScenarioId } from '@/types';

export default function LearnView({
  scenarios,
  onOpen,
}: {
  scenarios: ScenarioMeta[];
  onOpen: (id: ScenarioId) => void;
}) {
  const agents = scenarios.filter((s) => s.kind === 'agent');
  const workflows = scenarios.filter((s) => s.kind === 'workflow');

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <section className="rounded-xl border border-line bg-bg-panel/60 p-5">
        <h2 className="mb-2 font-display text-lg tracking-wide text-ink-base">What is an agent loop?</h2>
        <p className="mb-3 text-[13px] leading-relaxed text-ink-dim">
          An agent solves a task by looping: it reads its <b className="text-ctx">input</b>,{' '}
          <b className="text-think">thinks</b>, <b className="text-decide">generates</b> a tool call,
          and the harness <b className="text-tool">acts</b> — the result becomes the next input, and it
          loops until done. A <b>tool</b> is a function the model may call. A <b>trace</b> is the recorded
          log of every step. A <b>guardrail</b> stops an unsafe or runaway action.
        </p>
        <div className="flex flex-wrap gap-2">
          {['INPUT', 'THINK', 'GENERATE', 'ACT'].map((label, i, arr) => (
            <span key={label} className="flex items-center gap-2">
              <span className="rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-ink-base">
                {label}
              </span>
              {i < arr.length - 1 && <span className="text-ink-faint">→</span>}
            </span>
          ))}
          <span className="text-decide">↺ result → next input</span>
        </div>
      </section>

      <CardGroup title="Agents — they loop until done" subtitle="the model decides the next move each turn" items={agents} onOpen={onOpen} />

      <section className="rounded-xl border border-line bg-bg-panel/60 p-5">
        <h2 className="mb-2 font-display text-lg tracking-wide text-ink-base">What is a workflow?</h2>
        <p className="mb-3 text-[13px] leading-relaxed text-ink-dim">
          A workflow is a <b>fixed pipeline</b>: the stages and their order are decided by code, not the
          model. Each stage either runs deterministic logic or calls the model exactly once, then hands
          off to the next. No looping, no tool choice — the model fills <b>one slot</b> and the harness
          drives the rest. Predictable and cheap; the trade-off is no autonomy.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {['CODE', 'CODE', 'MODEL', 'CODE'].map((label, i, arr) => (
            <span key={i} className="flex items-center gap-2">
              <span className={`rounded-md border border-line px-2 py-1 text-[11px] font-semibold ${label === 'MODEL' ? 'text-decide' : 'text-ink-dim'}`}>
                {label}
              </span>
              {i < arr.length - 1 && <span className="text-ink-faint">→</span>}
            </span>
          ))}
          <span className="text-ink-faint">one fixed pass, no loop</span>
        </div>
      </section>

      <CardGroup title="Workflows — fixed pipelines" subtitle="deterministic stages; the model fills one slot" items={workflows} onOpen={onOpen} />
    </div>
  );
}

function CardGroup({
  title,
  subtitle,
  items,
  onOpen,
}: {
  title: string;
  subtitle: string;
  items: ScenarioMeta[];
  onOpen: (id: ScenarioId) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h3 className="font-display text-base tracking-wide text-ink-base">{title}</h3>
        <p className="text-[11px] text-ink-faint">{subtitle}</p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {items.map((s) => (
          <motion.button
            key={s.id}
            type="button"
            onClick={() => onOpen(s.id)}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.98 }}
            className="rounded-lg border border-line bg-bg-card/50 p-3 text-left transition-colors hover:border-decide/50"
          >
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-ink-base">{s.title}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${s.kind === 'agent' ? 'bg-decide/15 text-decide' : 'bg-ctx/15 text-ctx'}`}>
                {s.kind}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-ink-dim">{s.teaches}</p>
          </motion.button>
        ))}
      </div>
    </section>
  );
}
