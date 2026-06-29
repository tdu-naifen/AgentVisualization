'use client';

// ThemeToggle — three named themes matching the Modal glossary chrome:
// Terminal (default) · Light green · Light. A compact dropdown (not three exposed
// labels) so the top bar stays calm. Writes data-theme on <html> + localStorage.

import { useEffect, useRef, useState } from 'react';

const THEMES = ['terminal', 'light-green', 'light'] as const;
type Theme = (typeof THEMES)[number];
const LABEL: Record<Theme, string> = { terminal: 'Terminal', 'light-green': 'Light green', light: 'Light' };

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('terminal');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = (localStorage.getItem('theme') as Theme) || 'terminal';
    setTheme(saved);
    document.documentElement.dataset.theme = saved;
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (t: Theme) => {
    setTheme(t);
    document.documentElement.dataset.theme = t;
    localStorage.setItem('theme', t);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-ink-dim transition-colors hover:border-decide/50 hover:text-ink-base"
      >
        <span className="text-decide">{LABEL[theme]}</span>
        <span className="text-ink-faint">{open ? '^' : 'v'}</span>
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-32 overflow-hidden rounded-md border border-line bg-bg-panel shadow-neon">
          {THEMES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => pick(t)}
              className={`block w-full px-2 py-1.5 text-left transition-colors hover:bg-bg-card ${theme === t ? 'text-decide' : 'text-ink-dim'}`}
            >
              {LABEL[t]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
