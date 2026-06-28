'use client';

// StepView — renders the CURRENT StepView: a title header, the step's LLM
// streaming boxes (via StreamBox), then its structured panels as color-coded
// blocks. A panel whose key is `observation` (or accent pink/observe) shows the
// teaching cue "↓ feeds into next step ▸" — the result of this step flows into
// the next step's context. Entry is animated with a gentle fade + slide-up
// stagger so a step feels like it "arrives".

import { motion } from 'framer-motion';
import type { StepView as StepViewModel, Panel } from '@/types';
import StreamBox from './StreamBox';
import PanelBody from './PanelBody';
import InfoHover from './InfoHover';

// ─── accent token mapping (flexible: scenario authors may use either name) ─────
type AccentTokens = { text: string; border: string; chip: string; rgb: string | null };

function accentTokens(accent?: string): AccentTokens {
  switch ((accent ?? '').toLowerCase()) {
    case 'cyan':
    case 'ctx':
      return { text: 'text-ctx', border: 'border-ctx/40', chip: 'bg-ctx/10', rgb: '34,211,238' };
    case 'amber':
    case 'think':
      return { text: 'text-think', border: 'border-think/40', chip: 'bg-think/10', rgb: '251,191,36' };
    case 'teal':
    case 'green':
    case 'decide':
      return { text: 'text-decide', border: 'border-decide/40', chip: 'bg-decide/10', rgb: '45,212,191' };
    case 'pink':
    case 'observe':
      return { text: 'text-observe', border: 'border-observe/40', chip: 'bg-observe/10', rgb: '244,114,182' };
    case 'violet':
    case 'tool':
      return { text: 'text-tool', border: 'border-tool/40', chip: 'bg-tool/10', rgb: '167,139,250' };
    default:
      return { text: 'text-ink-dim', border: 'border-line', chip: 'bg-bg-card/40', rgb: null };
  }
}

function isObservation(p: Panel): boolean {
  const a = (p.accent ?? '').toLowerCase();
  return p.key.toLowerCase() === 'observation' || a === 'pink' || a === 'observe';
}

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.04 } },
};
const item = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: 'easeOut' as const } },
};

/** Panel keys that are INPUT to the model (shown ABOVE the streaming boxes, since
 *  they are what the model reacts to). Everything else renders below the streams. */
const INPUT_KEYS = new Set(['context', 'input']);

/** Per-panel body height cap (with internal scroll). A step can stack several dense
 *  panels (the input prompt + the full-body observation repeat EVERY agent turn), so
 *  an unbounded body made each step grow taller than the viewport and the page lost
 *  its single-screen shape. Bounding each body keeps a step a predictable size and
 *  lets you scroll WITHIN a panel — the page stays an SPA, the panel scrolls. Input/
 *  reference panels (which repeat verbatim each step) get the tightest cap. */
function bodyMaxHeight(panelKey: string): string {
  if (INPUT_KEYS.has(panelKey)) return 'max-h-40'; // 10rem — repetitive reference text
  return 'max-h-72'; // 18rem — observations/answers/metrics
}

function PanelBlock({ panel, highlighted }: { panel: Panel; highlighted?: boolean }) {
  const t = accentTokens(panel.accent);
  const feeds = isObservation(panel);
  return (
    <motion.div variants={item} layout id={`panel-${panel.key}`}>
      <div
        className={`rounded-lg border ${t.border} ${t.chip} p-3 transition-shadow ${
          highlighted ? 'ring-2 ring-decide ring-offset-2 ring-offset-bg-base' : ''
        }`}
        style={
          highlighted
            ? { boxShadow: '0 0 22px rgba(45,212,191,0.45)' }
            : t.rgb
              ? { boxShadow: `0 0 14px rgba(${t.rgb},0.10)` }
              : undefined
        }
      >
        <div className={`mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider ${t.text}`}>
          <span>{panel.label}</span>
          {panel.hint && <InfoHover text={panel.hint} />}
        </div>
        {/* Bounded, internally-scrollable body — keeps a tall panel (input prompt /
            full doc body) from stretching the whole step past the viewport. */}
        <div className={`${bodyMaxHeight(panel.key)} overflow-y-auto overflow-x-auto pr-1`}>
          <PanelBody body={panel.body} />
        </div>
      </div>
      {feeds && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.25, duration: 0.5 }}
          className="mt-1 text-center text-[11px] text-observe"
        >
          ↓ feeds into next step ▸
        </motion.div>
      )}
    </motion.div>
  );
}

export default function StepView({
  step,
  highlightKey,
}: {
  step: StepViewModel;
  highlightKey?: string;
}) {
  const inputPanels = step.panels.filter((p) => INPUT_KEYS.has(p.key));
  const outputPanels = step.panels.filter((p) => !INPUT_KEYS.has(p.key));
  return (
    <motion.section
      key={step.index}
      variants={container}
      initial="hidden"
      animate="show"
      className="flex flex-col gap-3"
    >
      {/* header */}
      <motion.div variants={item} className="flex items-center gap-3">
        <span className="flex h-6 min-w-6 items-center justify-center rounded-md border border-decide/40 bg-decide/10 px-1.5 text-[11px] font-bold text-decide">
          {step.index + 1}
        </span>
        <h2 className="text-sm font-semibold text-ink-base">{step.title}</h2>
        {step.hint && <InfoHover text={step.hint} />}
        {step.guardrail && (
          <motion.span
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="ml-auto rounded-full border border-think/50 bg-think/10 px-2.5 py-0.5 text-[10px] font-medium text-think shadow-thinkglow"
          >
            ⚠ guardrail: {step.guardrail}
          </motion.span>
        )}
      </motion.div>

      {/* INPUT panels (context / input prompt) — what the model reads, shown first */}
      {inputPanels.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {inputPanels.map((p) => (
            <PanelBlock key={p.key} panel={p} highlighted={p.key === highlightKey} />
          ))}
        </div>
      )}

      {/* LLM streaming boxes */}
      {step.streams.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {step.streams.map((s) => (
            <motion.div key={s.id} variants={item} layout>
              <StreamBox stream={s} />
            </motion.div>
          ))}
        </div>
      )}

      {/* output / structured panels */}
      {outputPanels.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {outputPanels.map((p) => (
            <PanelBlock key={p.key} panel={p} highlighted={p.key === highlightKey} />
          ))}
        </div>
      )}
    </motion.section>
  );
}
