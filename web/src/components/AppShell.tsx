'use client';

// AppShell — the overall page frame: app title (+ an optional one-line subtitle)
// and the `modelLoader` pinned top-right, then the content area below. Scenario
// SELECTION lives in the content itself (the Learn landing's grouped cards); the
// old pill-tab row was removed because it duplicated those cards on the Learn page.
// AppShell just frames — `children` decides the inner layout.

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
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <h1 className="bg-accent bg-clip-text text-2xl font-bold tracking-tight text-transparent">
              Agent Loop Explainer 🧠
            </h1>
            {subtitle && <p className="text-[12px] text-ink-dim">{subtitle}</p>}
          </div>
          <div className="shrink-0">{modelLoader}</div>
        </header>

        {/* ── content ───────────────────────────────────────────────────── */}
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
