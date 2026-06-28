'use client';

// IntroBox — a per-tab scrollable intro card shown between the ← Concept button
// and the main grid. Pure presentation: title + a short scrollable intro blurb.

export default function IntroBox({ title, intro }: { title: string; intro: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-3 mb-3">
      <p className="text-sm font-semibold text-ink-base">{title}</p>
      <p className="mt-1 max-h-28 overflow-y-auto text-[12px] leading-relaxed text-ink-dim">
        {intro}
      </p>
    </div>
  );
}
