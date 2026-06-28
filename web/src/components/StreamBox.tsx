'use client';

// StreamBox — renders ONE LlmStream as a small "chat box" with a typewriter feel.
// The streaming itself happens upstream; this component just displays whatever
// `text` it is handed, plus a blinking caret while the stream is not `done`.
// A `useTypewriter` hook is exported so a standalone preview can *simulate*
// streaming (char-by-char reveal) without the real engine.

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { LlmStream, LlmStreamKind } from '@/types';

// ─── kind → color tokens (static class strings so Tailwind keeps them) ─────────
const KIND: Record<
  LlmStreamKind,
  { text: string; border: string; rgb: string }
> = {
  thinking: { text: 'text-think', border: 'border-think/30', rgb: '251,191,36' },
  decision: { text: 'text-decide', border: 'border-decide/30', rgb: '45,212,191' },
  judge: { text: 'text-observe', border: 'border-observe/30', rgb: '244,114,182' },
  generation: { text: 'text-ctx', border: 'border-ctx/30', rgb: '34,211,238' },
  other: { text: 'text-ctx', border: 'border-ctx/30', rgb: '34,211,238' },
};

/**
 * Progressively reveal `fullText` char-by-char (~22ms/char) while `on` is true,
 * so a mock preview can simulate token streaming. When `on` is false the full
 * text is shown immediately. Returns the currently-visible slice.
 */
export function useTypewriter(fullText: string, on: boolean, speed = 22): string {
  const [count, setCount] = useState(on ? 0 : fullText.length);

  useEffect(() => {
    if (!on) {
      setCount(fullText.length);
      return;
    }
    setCount(0);
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setCount(i);
      if (i >= fullText.length) clearInterval(id);
    }, Math.max(1, speed));
    return () => clearInterval(id);
  }, [fullText, on, speed]);

  return fullText.slice(0, count);
}

/** Amber block cursor that blinks on/off (mimics `@keyframes blink` steps(2)). */
function Caret() {
  return (
    <motion.span
      aria-hidden
      className="ml-0.5 inline-block h-[0.95em] w-[6px] translate-y-[1px] rounded-[1px] bg-think align-middle"
      animate={{ opacity: [1, 1, 0, 0] }}
      transition={{ duration: 1, repeat: Infinity, ease: 'linear', times: [0, 0.5, 0.5, 1] }}
    />
  );
}

export default function StreamBox({ stream }: { stream: LlmStream }) {
  const k = KIND[stream.kind] ?? KIND.other;

  const bodyRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  // While the user hasn't scrolled away, keep the newest tokens in view.
  useEffect(() => {
    const el = bodyRef.current;
    if (following && el) el.scrollTop = el.scrollHeight;
  }, [stream.text, following]);

  // Follow the tail only while the user is parked at (or near) the bottom.
  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
    setFollowing(atBottom);
  }

  function jumpToLatest() {
    setFollowing(true);
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  return (
    <div
      className={`relative rounded-lg border ${k.border} bg-bg-card/60 p-3 backdrop-blur-sm`}
      style={{ boxShadow: `0 0 16px rgba(${k.rgb},0.10)` }}
    >
      {/* header: colored dot + label */}
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${k.text}`}
          style={{ backgroundColor: `rgb(${k.rgb})`, boxShadow: `0 0 8px rgba(${k.rgb},0.7)` }}
        />
        <span className={`text-[11px] font-semibold uppercase tracking-wide ${k.text}`}>
          {stream.label}
        </span>
        {!stream.done ? (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-ink-faint">
            <motion.span
              className={`h-1 w-1 rounded-full ${k.text}`}
              style={{ backgroundColor: `rgb(${k.rgb})` }}
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
            />
            streaming
          </span>
        ) : (
          <span className="ml-auto text-[10px] text-ink-faint">done</span>
        )}
      </div>

      {/* body: accumulated text + caret while streaming.
          A FIXED height with internal scroll keeps the box from resizing the
          whole page on every token (the streaming "jitter"); it auto-follows
          the tail unless the user scrolls up to read earlier text. */}
      <div
        ref={bodyRef}
        onScroll={handleScroll}
        className="h-48 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-base"
      >
        {stream.text || (!stream.done ? <span className="text-ink-faint">…</span> : null)}
        {!stream.done && <Caret />}
      </div>

      {!following && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-2 right-2 rounded-full border border-line bg-bg-card/80 px-2 py-0.5 text-[10px] text-ink-dim backdrop-blur-sm hover:text-ink-base"
        >
          ↓ latest
        </button>
      )}
    </div>
  );
}
