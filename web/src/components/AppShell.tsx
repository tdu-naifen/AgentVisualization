'use client';

// AppShell — the overall page frame: app title (block cursor, no emoji), the theme
// toggle (Terminal · Light green · Light) + the `modelLoader` pinned top-right, then
// the content area. Scenario selection lives in the content; AppShell just frames.

import ThemeToggle from './ThemeToggle';

interface AppShellProps {
  /** optional one-line subtitle under the title (e.g. the active scenario's, shown in run view) */
  subtitle?: string;
  modelLoader: React.ReactNode;
  children: React.ReactNode;
}

export default function AppShell({ subtitle, modelLoader, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-app text-ink-base">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 px-5 py-6">
        {/* ── top bar ───────────────────────────────────────────────────── */}
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4">
          <div className="flex flex-col gap-0.5">
            <h1 className="font-display text-3xl tracking-[0.08em] text-ink-base">
              Agent vs Workflow Explainer<span className="cursor" />
            </h1>
            {subtitle && <p className="text-[12px] text-ink-dim">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-5">
            <ThemeToggle />
            <div className="shrink-0">{modelLoader}</div>
          </div>
        </header>

        {/* ── content ───────────────────────────────────────────────────── */}
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
