'use client';

// Controls — the Next / Reset controls for the agent loop.
//
// • "Next ▸" is a glowing gradient button. It is DISABLED while `running`
//   (a step's LLM is streaming) or when `finished`.
// • When `finished`, a re-enabled "Reset ↺" button appears alongside.
// • A small "Step N" counter is shown.
// framer-motion gives a tap scale-down + subtle hover lift.

import { motion } from 'framer-motion';
import type { LoopPhase } from '@/types';

interface ControlsProps {
  phase: LoopPhase;
  finished: boolean;
  running: boolean;
  /** the model+corpus are loaded and the loop can actually run */
  modelReady: boolean;
  onNext: () => void;
  onReset: () => void;
  stepIndex?: number;
  /** auto-mode is currently running (the loop advances itself) */
  auto?: boolean;
  /** start auto-mode (model self-advances until finished / ceiling) */
  onAuto?: () => void;
  /** pause auto-mode */
  onPause?: () => void;
}

export default function Controls({
  phase,
  finished,
  running,
  modelReady,
  onNext,
  onReset,
  stepIndex,
  auto,
  onAuto,
  onPause,
}: ControlsProps) {
  // Next is blocked while a step streams, once finished, OR before the model is
  // ready (you cannot advance a loop with no model behind it).
  const nextDisabled = running || finished || !modelReady;
  // Auto can start only when a manual Next could also run, and isn't already going.
  const autoToggleDisabled = finished || !modelReady;

  return (
    <div className="flex items-center gap-3">
      {/* Next */}
      <motion.button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        whileHover={nextDisabled ? undefined : { y: -1 }}
        whileTap={nextDisabled ? undefined : { scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className={`relative rounded-lg bg-accent px-5 py-2 text-[13px] font-bold text-bg-base shadow-neon transition-opacity ${
          nextDisabled ? 'cursor-not-allowed opacity-40' : 'opacity-100'
        }`}
      >
        {running ? (
          <span className="flex items-center gap-2">
            <motion.span
              className="h-2 w-2 rounded-full bg-bg-base"
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
            />
            Streaming…
          </span>
        ) : (
          'Next ▸'
        )}
      </motion.button>

      {/* Auto / Pause — auto-mode advances the loop itself until the scenario
          finishes (or a hard ceiling trips). The model still decides every step;
          this only removes the manual click. */}
      {auto ? (
        <motion.button
          type="button"
          onClick={onPause}
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          className="flex items-center gap-2 rounded-lg border border-think/50 bg-think/10 px-4 py-2 text-[13px] font-semibold text-think transition-colors hover:bg-think/20"
        >
          <motion.span
            className="h-2 w-2 rounded-full bg-think"
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
          />
          Auto… ⏸ Pause
        </motion.button>
      ) : (
        <motion.button
          type="button"
          onClick={onAuto}
          disabled={autoToggleDisabled || !onAuto}
          whileHover={autoToggleDisabled ? undefined : { y: -1 }}
          whileTap={autoToggleDisabled ? undefined : { scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          title="Let the model advance the loop by itself until it finishes"
          className={`rounded-lg border border-decide/50 bg-decide/10 px-4 py-2 text-[13px] font-semibold text-decide transition-colors hover:bg-decide/20 ${
            autoToggleDisabled || !onAuto ? 'cursor-not-allowed opacity-40' : ''
          }`}
        >
          ▶▶ Auto
        </motion.button>
      )}

      {/* Reset — appears once finished */}
      {finished && (
        <motion.button
          type="button"
          onClick={onReset}
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          className="rounded-lg border border-decide/50 bg-decide/10 px-4 py-2 text-[13px] font-semibold text-decide transition-colors hover:bg-decide/20"
        >
          Reset ↺
        </motion.button>
      )}

      {/* step counter / status */}
      <div className="ml-1 flex items-center gap-2 text-[11px] text-ink-dim">
        {stepIndex !== undefined && (
          <span>
            Step <span className="font-semibold text-ink-base">{stepIndex + 1}</span>
          </span>
        )}
        {finished && (
          <span className="rounded-full border border-decide/40 bg-decide/10 px-2 py-0.5 text-[10px] font-medium text-decide">
            finished
          </span>
        )}
        {phase === 'error' && (
          <span className="rounded-full border border-observe/50 bg-observe/10 px-2 py-0.5 text-[10px] font-medium text-observe">
            error
          </span>
        )}
        {!modelReady && !finished && (
          <span className="text-[10px] text-ink-faint">load the model to enable Next →</span>
        )}
      </div>
    </div>
  );
}
