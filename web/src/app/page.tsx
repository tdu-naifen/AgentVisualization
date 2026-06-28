'use client';

// page.tsx — integration. Wires the unified framework:
//   • pill tabs select a ScenarioId
//   • ModelLoader downloads Gemma (WebGPU) — or shows a fallback
//   • Next drives scenario.next({onStream,onTrace}); gated while a step streams
//   • finished → Next greys out, Reset appears
//   • StepView renders the current step's streams + panels; TracePanel shows the
//     accumulated hierarchical trace.

import { useCallback, useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import ModelLoader from '@/components/ModelLoader';
import StepViewPanel from '@/components/StepView';
import Controls from '@/components/Controls';
import TracePanel from '@/components/TracePanel';
import { mockScenarioMetas } from '@/components/mockState';
import { GemmaLLM } from '@/lib/llm';
import { loadCorpus } from '@/lib/corpus';
import { makeRagScenario } from '@/lib/scenarios/01_rag';
import { makeAgentScenario } from '@/lib/scenarios/02_agent';
import { makeEvalScenario } from '@/lib/scenarios/03_eval';
import { makeSearchScenario } from '@/lib/scenarios/04_search';
import { makeValidationScenario } from '@/lib/scenarios/05_validation';
import { makeSafetyScenario } from '@/lib/scenarios/07_safety';
import type {
  Doc,
  LlmStream,
  LoopState,
  Panel,
  Scenario,
  ScenarioId,
  StepView,
  TraceLine,
} from '@/types';

type ModelStatus = 'idle' | 'loading' | 'ready' | 'error';

const SCENARIOS = mockScenarioMetas();

function emptyState(scenario: ScenarioId): LoopState {
  return {
    scenario,
    phase: 'idle',
    steps: [],
    current: null,
    finished: false,
    finalResult: null,
    error: null,
    trace: [],
  };
}

export default function Home() {
  const [activeId, setActiveId] = useState<ScenarioId>('02_agent');
  const [state, setState] = useState<LoopState>(() => emptyState('02_agent'));
  const [running, setRunning] = useState(false);
  // Auto-mode: the loop advances itself until the scenario finishes (or errors, or
  // hits a hard ceiling). A ref mirrors the state so the async runner sees the
  // latest value without stale closures.
  const [auto, setAuto] = useState(false);
  const autoRef = useRef(false);
  // Trace→step jump: a transient highlight (which committed step + which block to
  // flash) that the trace panel sets when a line is clicked. The left column is an
  // append-only chronological timeline; clicking SCROLLS to the step's box.
  const [highlight, setHighlight] = useState<{ stepIndex: number; key?: string; nonce: number } | null>(null);
  // The scrollable timeline container + per-step DOM nodes (for scroll-into-view).
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const stepNodes = useRef<Map<number, HTMLDivElement>>(new Map());
  // Whether the timeline should auto-stick to the newest step as it streams. Turns
  // off when the user scrolls up to read earlier boxes; back on at the bottom.
  const followRef = useRef(true);
  const [following, setFollowing] = useState(true);

  // Model loading
  const [modelStatus, setModelStatus] = useState<ModelStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [modelError, setModelError] = useState<string | undefined>(undefined);

  // Long-lived singletons (created lazily, kept across renders).
  const llmRef = useRef<GemmaLLM | null>(null);
  const docsRef = useRef<Doc[] | null>(null);
  const scenarioRef = useRef<Scenario | null>(null);

  const ensureLlm = useCallback(() => {
    if (!llmRef.current) llmRef.current = new GemmaLLM();
    return llmRef.current;
  }, []);

  const buildScenario = useCallback((id: ScenarioId, docs: Doc[]): Scenario | null => {
    if (!llmRef.current) llmRef.current = new GemmaLLM();
    const llm = llmRef.current;
    switch (id) {
      case '01_rag':
        return makeRagScenario(llm, docs);
      case '02_agent':
        return makeAgentScenario(llm, docs);
      case '03_eval':
        return makeEvalScenario(llm, docs);
      case '04_search':
        return makeSearchScenario(llm, docs);
      case '05_validation':
        return makeValidationScenario(llm, docs);
      case '07_safety':
        return makeSafetyScenario(llm, docs);
      default:
        return null;
    }
  }, []);

  const onLoad = useCallback(async () => {
    setModelStatus('loading');
    setModelError(undefined);
    try {
      // Corpus first (fast) — fetched from public/corpus.json.
      if (!docsRef.current) docsRef.current = await loadCorpus();
      const llm = ensureLlm();
      await llm.load((pct) => setProgress(Math.round(pct)));
      setModelStatus('ready');
    } catch (err) {
      setModelStatus('error');
      setModelError(err instanceof Error ? err.message : String(err));
    }
  }, [ensureLlm]);

  const selectScenario = useCallback((id: ScenarioId) => {
    autoRef.current = false;
    setAuto(false);
    setActiveId(id);
    scenarioRef.current = null;
    setState(emptyState(id));
    setRunning(false);
    setHighlight(null);
    stepNodes.current.clear();
    followRef.current = true;
    setFollowing(true);
  }, []);

  const onNext = useCallback(async (): Promise<{ finished: boolean; ok: boolean }> => {
    if (running || state.finished) return { finished: state.finished, ok: false };
    const docs = docsRef.current;
    if (!docs) {
      setState((s) => ({ ...s, error: 'Load the model first (it also loads the corpus).' }));
      return { finished: false, ok: false };
    }
    // Lazily build the scenario for the active tab.
    if (!scenarioRef.current) {
      const built = buildScenario(activeId, docs);
      if (!built) {
        setState((s) => ({ ...s, error: `Scenario ${activeId} is not wired yet.` }));
        return { finished: false, ok: false };
      }
      scenarioRef.current = built;
    }
    const scenario = scenarioRef.current;

    setRunning(true);
    setState((s) => ({ ...s, phase: 'running', error: null }));
    // A new step is starting — stick to the newest step at the bottom again.
    followRef.current = true;
    setFollowing(true);

    // Stream boxes update live (you watch the model think/decide in real time).
    // Trace lines are BUFFERED and only committed when the step fully completes —
    // the trace you see is always a complete, real record of finished work, never
    // a half-built in-progress view. (Honesty: show the whole span or none of it.)
    const pendingTrace: TraceLine[] = [];
    const cb = {
      onStream: (stream: LlmStream) => {
        setState((s) => updateCurrentStream(s, stream));
      },
      onPanel: (panel: Panel) => {
        setState((s) => updateCurrentPanel(s, panel));
      },
      onTrace: (line: TraceLine) => {
        pendingTrace.push(line);
      },
    };

    try {
      const step: StepView = await scenario.next(cb);
      const finished = scenario.isFinished();
      // Stamp every trace line from THIS step with the committed step index, so a
      // click in the trace panel can jump to this step's blocks on the left. We
      // stamp at commit time (not in the builder) because the step index is the
      // UI's notion of "which committed step", owned here.
      const stamped = pendingTrace.map((l) => ({ ...l, stepIndex: step.index }));
      setState((s) => {
        // Framework-level guarantee: every LLM box that STREAMED live this step is
        // preserved in the committed step. The live `current` accumulated each box
        // via onStream; without this merge, a scenario that doesn't re-list its
        // streams in makeStep() would drop them on commit and the Thinking/Decision/
        // Answer boxes would VANISH the instant the step settled. We dedupe by id so
        // a scenario that DID list its streams isn't double-counted. (Honesty: show
        // the real model output you already streamed — don't make it disappear.)
        const live = s.current && s.current.index === step.index ? s.current.streams : [];
        const seen = new Set(step.streams.map((x) => x.id));
        const mergedStreams = [...step.streams, ...live.filter((x) => !seen.has(x.id))];
        // Same guarantee for PANELS emitted live via cb.onPanel (e.g. the input/
        // context block shown at step start): keep any live panel the committed step
        // didn't re-list, so it doesn't vanish on commit. The committed panel WINS for
        // a shared key (it's the final version); live-only keys are appended in front
        // so an input panel keeps its "shown first" position. (Honesty: don't drop a
        // block the user already saw.)
        const livePanels = s.current && s.current.index === step.index ? s.current.panels : [];
        const committedKeys = new Set(step.panels.map((p) => p.key));
        const extraPanels = livePanels.filter((p) => !committedKeys.has(p.key));
        const mergedPanels = extraPanels.length > 0 ? [...extraPanels, ...step.panels] : step.panels;
        const committedStep =
          mergedStreams.length === step.streams.length && mergedPanels === step.panels
            ? step
            : { ...step, streams: mergedStreams, panels: mergedPanels };
        return {
          ...s,
          steps: [...s.steps, committedStep],
          current: committedStep,
          phase: finished ? 'finished' : 'step_done',
          finished,
          // commit this step's trace lines atomically, now that the step is done
          trace: [...s.trace, ...stamped],
        };
      });
      return { finished, ok: true };
    } catch (err) {
      // Even on failure, commit whatever real trace lines were produced — we do
      // not hide a failed run; we show exactly what happened up to the error.
      const stamped = pendingTrace.map((l) => ({ ...l, stepIndex: state.steps.length }));
      setState((s) => ({
        ...s,
        phase: 'error',
        error: err instanceof Error ? err.message : String(err),
        trace: [...s.trace, ...stamped],
      }));
      return { finished: false, ok: false };
    } finally {
      setRunning(false);
    }
  }, [running, state.finished, state.steps.length, activeId, buildScenario]);

  // Auto-mode runner: keep pressing Next until the scenario finishes, errors, or a
  // hard ceiling trips (a backstop independent of any scenario's own step cap, so a
  // misbehaving loop can't run forever even if its internal guard regressed). The
  // model still decides every step — auto-mode only removes the manual click.
  const AUTO_MAX_STEPS = 12;
  const runAuto = useCallback(async () => {
    if (autoRef.current) return; // already running
    autoRef.current = true;
    setAuto(true);
    try {
      let guard = 0;
      // Loop while the user hasn't paused and we haven't hit the ceiling.
      while (autoRef.current && guard < AUTO_MAX_STEPS) {
        guard += 1;
        const { finished, ok } = await onNext();
        if (!ok || finished) break; // halt on finish, error, or a no-op press
      }
    } finally {
      autoRef.current = false;
      setAuto(false);
    }
  }, [onNext]);

  const pauseAuto = useCallback(() => {
    autoRef.current = false;
    setAuto(false);
  }, []);

  // Trace→step jump: scroll the timeline to the clicked line's committed step box
  // and flash its block. The bump nonce re-triggers the flash even if the same
  // step/key is clicked twice in a row.
  const onJump = useCallback(
    (stepIndex: number, key?: string) => {
      if (stepIndex < 0 || stepIndex >= state.steps.length) return;
      // Clicking a past step means the user is navigating — stop auto-follow so the
      // timeline doesn't yank them back to the bottom.
      followRef.current = false;
      setFollowing(false);
      const node = stepNodes.current.get(stepIndex);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlight((h) => ({ stepIndex, key, nonce: (h?.nonce ?? 0) + 1 }));
    },
    [state.steps.length],
  );

  const onReset = useCallback(() => {
    autoRef.current = false;
    setAuto(false);
    scenarioRef.current?.reset();
    scenarioRef.current = null;
    setState(emptyState(activeId));
    setRunning(false);
    setHighlight(null);
    stepNodes.current.clear();
    followRef.current = true;
    setFollowing(true);
  }, [activeId]);

  // Auto-stick the timeline to the newest content while `following` is on (a new
  // step arrived or the in-progress step streamed). The user scrolling up turns
  // following off (see onTimelineScroll); returning to the bottom turns it back on.
  useEffect(() => {
    if (!followRef.current) return;
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.steps.length, state.current]);

  const onTimelineScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 40;
    followRef.current = atBottom;
    setFollowing(atBottom);
  }, []);

  const modelLoader = (
    <ModelLoader onLoad={onLoad} progress={progress} status={modelStatus} error={modelError} />
  );

  const current = state.current;
  // The append-only timeline: every committed step, in chronological order. While a
  // step streams, `current` is newer than the last committed step (its index === the
  // committed count) — show it live at the bottom until it commits.
  const committed = state.steps;
  const liveStep =
    current && (committed.length === 0 || current.index >= committed.length) ? current : null;

  return (
    <AppShell
      scenarios={SCENARIOS}
      activeId={activeId}
      onSelect={selectScenario}
      modelLoader={modelLoader}
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_minmax(320px,420px)]">
        {/* main: controls + the chronological, scrollable step timeline */}
        <section className="flex min-h-0 min-w-0 flex-col gap-4">
          <Controls
            phase={state.phase}
            finished={state.finished}
            running={running}
            modelReady={modelStatus === 'ready'}
            onNext={onNext}
            onReset={onReset}
            stepIndex={state.steps.length}
            auto={auto}
            onAuto={runAuto}
            onPause={pauseAuto}
          />
          {state.error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {state.error}
            </div>
          )}

          {committed.length === 0 && !liveStep ? (
            <EmptyHint ready={modelStatus === 'ready'} />
          ) : (
            <div className="relative min-h-0">
              {/* The timeline scrolls INDEPENDENTLY so a long run never pushes the
                  controls/trace off-screen — you scroll back to any earlier step. */}
              <div
                ref={timelineRef}
                onScroll={onTimelineScroll}
                className="flex min-w-0 max-h-[calc(100vh-12rem)] flex-col gap-4 overflow-y-auto pr-1"
              >
                {/* ONE list, committed + live, every card keyed by its step.index.
                    The live step's index is ALWAYS the committed count, so when it
                    commits the SAME key persists — React reuses the DOM node instead
                    of unmounting it, so the entry animation does NOT replay. That is
                    what makes a finished step APPEND in place instead of "refreshing"
                    (the box just loses its "● running…" banner). */}
                {(liveStep ? [...committed, liveStep] : committed).map((step) => (
                  <StepCard
                    key={step.index}
                    step={step}
                    highlight={highlight}
                    live={liveStep != null && step.index === liveStep.index}
                    register={(node) => registerStepNode(stepNodes, step.index, node)}
                  />
                ))}
              </div>
              {!following && (
                <button
                  type="button"
                  onClick={() => {
                    followRef.current = true;
                    setFollowing(true);
                    const el = timelineRef.current;
                    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                  }}
                  className="absolute bottom-2 right-3 rounded-full border border-decide/50 bg-bg-card/90 px-3 py-1 text-[11px] text-decide shadow-neon backdrop-blur-sm hover:bg-decide/20"
                >
                  ↓ latest step
                </button>
              )}
            </div>
          )}
        </section>

        {/* side: hierarchical trace */}
        <aside className="min-w-0">
          <TracePanel trace={state.trace} onJump={onJump} />
        </aside>
      </div>
    </AppShell>
  );
}

/** One step's box in the timeline: a numbered separator + the StepView, wired for
 *  scroll-into-view (register) and a transient flash when jumped to from the trace. */
function StepCard({
  step,
  highlight,
  register,
  live,
}: {
  step: StepView;
  highlight: { stepIndex: number; key?: string; nonce: number } | null;
  register: (node: HTMLDivElement | null) => void;
  live?: boolean;
}) {
  const isTarget = highlight?.stepIndex === step.index;
  const activeKey = isTarget ? highlight?.key : undefined;
  const [flash, setFlash] = useState(false);
  // Flash the whole card briefly when it becomes the jump target (nonce changes).
  useEffect(() => {
    if (!isTarget) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1100);
    return () => clearTimeout(t);
  }, [isTarget, highlight?.nonce]);

  return (
    <div
      ref={register}
      className={`scroll-mt-4 rounded-xl border p-1 transition-colors duration-500 ${
        flash ? 'border-decide/70 bg-decide/[0.04]' : 'border-transparent'
      }`}
    >
      {live && (
        <div className="mb-1 px-2 pt-1 text-[10px] font-medium uppercase tracking-wider text-think">
          ● running…
        </div>
      )}
      <StepViewPanel step={step} highlightKey={activeKey} />
    </div>
  );
}

/** Track each step's DOM node so the trace panel can scroll it into view. */
function registerStepNode(
  ref: React.MutableRefObject<Map<number, HTMLDivElement>>,
  index: number,
  node: HTMLDivElement | null,
) {
  if (node) ref.current.set(index, node);
  else ref.current.delete(index);
}

function EmptyHint({ ready }: { ready: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-ink-dim">
      {ready ? (
        <>Press <span className="font-semibold text-decide">Next ▸</span> to advance the agent one step.</>
      ) : (
        <>Load Gemma 4 (top-right) to begin. The model runs entirely in your browser via WebGPU.</>
      )}
    </div>
  );
}

/** Merge a streaming box update into the in-progress step (create it if absent).
 *  The live step's index is ALWAYS the committed count, so the timeline shows it as
 *  a new box at the bottom rather than mutating the last committed step. */
function updateCurrentStream(s: LoopState, stream: LlmStream): LoopState {
  const liveIndex = s.steps.length;
  const base: StepView =
    s.current && s.current.index === liveIndex
      ? s.current
      : { index: liveIndex, title: 'Running…', streams: [], panels: [] };
  const idx = base.streams.findIndex((x) => x.id === stream.id);
  const streams =
    idx === -1 ? [...base.streams, stream] : base.streams.map((x) => (x.id === stream.id ? stream : x));
  return { ...s, current: { ...base, streams } };
}

/** Merge a panel emitted DURING the live step (via cb.onPanel) into the in-progress
 *  step, keyed by panel.key so re-emitting the same key updates in place. This is
 *  what lets an INPUT panel (context / the prompt) appear at step START — before any
 *  Thinking box streams — so the first thing a user sees in a fresh step is the
 *  starting block, not thinking. On commit, page.tsx merges these live panels into
 *  the committed step (see onNext) so they persist even if the scenario lists them. */
function updateCurrentPanel(s: LoopState, panel: Panel): LoopState {
  const liveIndex = s.steps.length;
  const base: StepView =
    s.current && s.current.index === liveIndex
      ? s.current
      : { index: liveIndex, title: 'Running…', streams: [], panels: [] };
  const idx = base.panels.findIndex((p) => p.key === panel.key);
  const panels =
    idx === -1 ? [...base.panels, panel] : base.panels.map((p) => (p.key === panel.key ? panel : p));
  return { ...s, current: { ...base, panels } };
}
