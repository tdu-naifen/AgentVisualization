'use client';

// ModelLoader — the top-right model-loader widget.
//
//   idle    → "⬇ Load Gemma 4 (WebGPU)" button + "~2.9 GB, downloads once" note
//   loading → progress bar (bg-accent fill) + "Downloading model… NN%"
//   ready   → teal "● Model ready" badge
//   error   → red message + a WebGPU-support hint
//
// Glass styling to sit in the top bar.

import { motion } from 'framer-motion';

interface ModelLoaderProps {
  onLoad: () => void;
  progress: number; // 0..100
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
}

export default function ModelLoader({ onLoad, progress, status, error }: ModelLoaderProps) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));

  return (
    <div className="min-w-[220px] rounded-xl border border-line bg-bg-panel/70 px-3 py-2 backdrop-blur-sm">
      {status === 'idle' && (
        <div className="flex flex-col gap-1">
          <motion.button
            type="button"
            onClick={onLoad}
            whileTap={{ scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className="group rounded-lg bg-accent px-3 py-1.5 text-[12px] font-bold text-bg-base shadow-neon"
          >
            <span className="neon-arrow">v</span> Load Gemma 4 (WebGPU)
          </motion.button>
          <span className="text-center text-[10px] text-ink-faint">
            ~3 GB, downloads once
          </span>
        </div>
      )}

      {status === 'loading' && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-ink-dim">Downloading model…</span>
            <span className="font-mono font-semibold text-ctx">{pct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-card">
            <motion.div
              className="h-full rounded-full bg-accent shadow-neon"
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            />
          </div>
        </div>
      )}

      {status === 'ready' && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex items-center justify-center gap-1.5 text-[12px] font-semibold text-decide"
        >
          <motion.span
            className="text-decide"
            animate={{ opacity: [1, 0.5, 1] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          >
            ●
          </motion.span>
          Model ready
        </motion.div>
      )}

      {status === 'error' && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-red-400">
            <span>⚠</span>
            <span className="break-words">{error ?? 'Failed to load model'}</span>
          </div>
          <span className="text-[10px] text-ink-faint">
            Requires a WebGPU-capable browser (Chrome/Edge 113+).
          </span>
          <motion.button
            type="button"
            onClick={onLoad}
            whileTap={{ scale: 0.97 }}
            className="mt-0.5 self-start rounded-md border border-line px-2 py-1 text-[11px] text-ink-dim transition-colors hover:text-ink-base"
          >
            Retry ↺
          </motion.button>
        </div>
      )}
    </div>
  );
}
