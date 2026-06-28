'use client';

// TracePanel — the langsmith-style hierarchical trace (the showpiece).
//
// • Lines are indented by `depth`.
// • Each `span_open` is collapsible: clicking its ▶/▼ triangle hides/shows the
//   nested lines it contains (anything with greater depth, up to its matching
//   `span_close`). Nested spans collapse independently; an outer collapse hides
//   everything inside regardless of inner state.
// • The matching `span_close` is folded into its `span_open` header (its `durS`
//   is shown there, langsmith-style) rather than rendered as its own row.
// • Lines with a `rawResponse` get a pink "+raw" toggle that slides open a <pre>.
// • Color: span open/close → teal, step → ink-dim, trace_start/end → cyan.

import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { TraceLine, TraceEvent } from '@/types';
import { humanizeTraceStep, summarizeTraceData, fullTraceData } from '@/lib/traceView';

const INDENT = 16; // px per depth level

interface Row {
  line: TraceLine;
  index: number; // position in the trace array
  ancestors: number[]; // indices of enclosing span_open rows
  isSpanOpen: boolean;
  durS?: number; // duration (from this line or its matched span_close)
}

function eventColor(event: TraceEvent): string {
  switch (event) {
    case 'span_open':
    case 'span_close':
      return 'text-decide';
    case 'trace_start':
    case 'trace_end':
      return 'text-ctx';
    case 'step':
    default:
      return 'text-ink-dim';
  }
}

function fmtDur(d?: number): string | null {
  return d === undefined ? null : `(${d.toFixed(1)}s)`;
}

/** Map a trace step/span name to the panel key it corresponds to on the left, so
 *  clicking a trace line can glow the right block. Unmapped names jump to the step
 *  with no specific block highlight (still useful). Kept here (presentation) since
 *  it is purely a UI affordance over honestly-recorded names. */
const ANCHOR_FOR_STEP: Record<string, string> = {
  context: 'context',
  input: 'input',
  decision: 'decision',
  decision_retry: 'decision',
  tool_call: 'observation',
  loop_stalled: 'stalled',
  agent_step: 'context',
};
function anchorForStep(step?: string): string | undefined {
  return step ? ANCHOR_FOR_STEP[step] : undefined;
}

export default function TracePanel({
  trace,
  onJump,
}: {
  trace: TraceLine[];
  onJump?: (stepIndex: number, key?: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [rawOpen, setRawOpen] = useState<Set<number>>(new Set());

  // Build render rows: pair spans, fold span_close into span_open, and record
  // each row's ancestor span_open indices so we can hide collapsed subtrees.
  const { rows, hasChildren } = useMemo(() => {
    const pairStack: number[] = [];
    const durForOpen = new Map<number, number>();
    const foldedClose = new Set<number>();
    trace.forEach((ln, i) => {
      if (ln.event === 'span_open') pairStack.push(i);
      else if (ln.event === 'span_close') {
        const open = pairStack.pop();
        if (open !== undefined) {
          foldedClose.add(i);
          if (ln.durS !== undefined) durForOpen.set(open, ln.durS);
        }
      }
    });

    const stack: number[] = [];
    const out: Row[] = [];
    trace.forEach((ln, i) => {
      if (ln.event === 'span_close' && foldedClose.has(i)) {
        stack.pop();
        return; // folded into its span_open header
      }
      const ancestors = [...stack];
      if (ln.event === 'span_open') {
        out.push({
          line: ln,
          index: i,
          ancestors,
          isSpanOpen: true,
          durS: durForOpen.get(i) ?? ln.durS,
        });
        stack.push(i);
      } else {
        out.push({ line: ln, index: i, ancestors, isSpanOpen: false, durS: ln.durS });
      }
    });

    const kids = new Set<number>();
    out.forEach((r) => r.ancestors.forEach((a) => kids.add(a)));
    return { rows: out, hasChildren: kids };
  }, [trace]);

  const visibleRows = rows.filter((r) => !r.ancestors.some((a) => collapsed.has(a)));

  function toggleCollapse(i: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }
  function toggleRaw(i: number) {
    setRawOpen((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  return (
    <div className="rounded-xl border border-line bg-bg-panel/70 p-3 backdrop-blur-sm">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-decide">
          Trace
        </span>
        <span className="text-[10px] text-ink-faint">langsmith-style</span>
        <span className="ml-auto font-mono text-[10px] text-ink-faint">{trace.length} lines</span>
      </div>

      {trace.length === 0 ? (
        <div className="py-6 text-center font-mono text-[11px] text-ink-faint">No trace yet.</div>
      ) : (
        <div className="font-mono text-[11px] leading-relaxed">
          <AnimatePresence initial={false}>
            {visibleRows.map((r) => {
              const { line } = r;
              const color = eventColor(line.event);
              const collapsible = r.isSpanOpen && hasChildren.has(r.index);
              const isCollapsed = collapsed.has(r.index);
              const dur = fmtDur(r.durS);
              const showRaw = rawOpen.has(r.index);
              const dataSummary = summarizeTraceData(line.data);
              const dataFull = fullTraceData(line.data);
              // A row is expandable if it carries an LLM raw response OR a non-trivial
              // data payload worth seeing in full (more than the inline summary shows).
              const hasDetail = line.rawResponse !== undefined || dataFull.length > 0;
              // A line can jump to its committed step on the left (stamped at commit).
              const canJump = onJump !== undefined && typeof line.stepIndex === 'number';

              return (
                <motion.div
                  key={r.index}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                  style={{ overflow: 'hidden' }}
                >
                  <div
                    className={`flex items-baseline gap-1.5 py-[2px] ${
                      canJump ? 'cursor-pointer rounded hover:bg-decide/5' : ''
                    }`}
                    style={{ paddingLeft: line.depth * INDENT }}
                    title={canJump ? 'Jump to this step on the left' : undefined}
                    onClick={
                      canJump
                        ? () => onJump!(line.stepIndex as number, anchorForStep(line.step))
                        : undefined
                    }
                  >
                    {/* triangle / spacer — its OWN click target so collapsing a span
                        does not also trigger a jump. */}
                    <span
                      className={`w-3 shrink-0 text-[9px] ${color} ${
                        collapsible ? 'cursor-pointer select-none' : ''
                      }`}
                      onClick={
                        collapsible
                          ? (e) => {
                              e.stopPropagation();
                              toggleCollapse(r.index);
                            }
                          : undefined
                      }
                    >
                      {collapsible ? (isCollapsed ? '▶' : '▼') : ''}
                    </span>

                    {/* n counter */}
                    <span className="shrink-0 text-ink-faint">n{line.n}</span>

                    {/* event tag + step text (humanized, not raw machine names) */}
                    {r.isSpanOpen ? (
                      <span className={color}>
                        <span className="font-semibold">{humanizeTraceStep(line.step)}</span>
                      </span>
                    ) : line.event === 'trace_start' || line.event === 'trace_end' ? (
                      <span className={color}>
                        ● {line.event === 'trace_start' ? 'Trace start' : 'Trace end'}
                        {line.step ? `: ${humanizeTraceStep(line.step)}` : ''}
                      </span>
                    ) : (
                      <span className="text-ink-base">{humanizeTraceStep(line.step)}</span>
                    )}

                    {/* inline data summary — what this step actually did, from the
                        recorded payload (never fabricated). */}
                    {dataSummary && (
                      <span className="truncate text-ink-faint">— {dataSummary}</span>
                    )}

                    {/* duration */}
                    {dur && <span className="shrink-0 text-ink-faint">{dur}</span>}

                    {/* raw toggle — opens the full data payload and/or LLM raw output */}
                    {hasDetail && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleRaw(r.index);
                        }}
                        className="ml-1 shrink-0 text-[10px] text-observe transition-colors hover:text-observe/80"
                      >
                        {showRaw ? '−details' : '+details'}
                      </button>
                    )}
                  </div>

                  {/* expandable detail: full data payload + LLM raw response */}
                  <AnimatePresence initial={false}>
                    {hasDetail && showRaw && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.25, ease: 'easeOut' }}
                        style={{ overflow: 'hidden', paddingLeft: line.depth * INDENT + 18 }}
                      >
                        {dataFull && (
                          <pre className="my-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-decide/30 bg-decide/[0.06] p-2 text-[10px] leading-relaxed text-ink-base">
                            {dataFull}
                          </pre>
                        )}
                        {line.rawResponse !== undefined && (
                          <pre className="my-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-observe/30 bg-observe/[0.06] p-2 text-[10px] leading-relaxed text-ink-base">
                            {line.rawResponse || '(empty model output)'}
                          </pre>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
