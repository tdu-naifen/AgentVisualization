'use client';

// InfoHover — a small ⓘ marker that reveals TEACHING prose on hover/focus. This is
// the ONLY place explanatory text lives (§8): data panels show data, the explanation
// is here. CSS group-hover (no JS state) keeps it cheap. Accessible via tabIndex+focus.

export default function InfoHover({ text, className }: { text: string; className?: string }) {
  return (
    <span className={`group relative inline-flex ${className ?? ''}`}>
      <span
        tabIndex={0}
        role="note"
        aria-label={text}
        className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-line text-[10px] text-ink-dim hover:border-ctx hover:text-ctx focus:border-ctx focus:text-ctx focus:outline-none"
      >
        ⓘ
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-5 z-20 hidden w-72 rounded-lg border border-ctx/40 bg-bg-card/95 p-3 text-[11px] leading-relaxed text-ink-dim shadow-neon backdrop-blur-sm group-hover:block group-focus-within:block"
      >
        {text}
      </span>
    </span>
  );
}
