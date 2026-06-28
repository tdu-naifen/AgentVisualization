// llm.ts — GemmaLLM: browser-only LLM over transformers.js + WebGPU.
//
// Model: onnx-community/gemma-4-E4B-it-ONNX (architecture gemma4 / gemma4_text).
//
// DTYPE: we use 'q8'. In transformers.js, DATA_TYPES maps 'q8' → the "_quantized"
// ONNX file suffix (DEFAULT_DTYPE_SUFFIX_MAPPING), i.e. decoder_model_merged_quantized
// + embed_tokens_quantized — the SMALLEST text-gen download (~2.87GB) with full
// capability. Available dtypes in this repo are ONLY: fp32(base), fp16, q4, q4f16,
// quantized(=q8). DO NOT use 'q2f16' — that file DOES NOT EXIST in the HF repo
// (an earlier project doc referenced it erroneously). 'quantized' is also NOT a
// valid transformers.js DataType literal; the literal is 'q8'.
//
// THINKING: Gemma 4's chat template supports native thinking. Passing
// enable_thinking:true to apply_chat_template injects <|think|>; the model then
// emits its reasoning as `<|channel>thought\n …reasoning… \n<channel|>` BEFORE the
// final answer. We parse the thought-channel text out for the "Thinking" stream box.
//
// DECIDE: the model also has native tool-calling, but it uses Gemma-private
// delimiters (`<|tool_call>call:name{…}<tool_call|>`) that are awkward to parse and
// display. We instead use a prompt-JSON approach (ask for a single JSON object and
// validate it), which is easier to validate and render cleanly in the UI.
//
// All transformers.js imports are DYNAMIC (await import) inside methods, so this
// module is import-safe under SSR / type-check and only pulls WebGPU code in the
// browser at call time.

import type { LLM, ChatMsg, ToolCall, ToolName } from '@/types';
import { TOOL_NAMES } from '@/types';
import { CancelledError } from '@/lib/cancel';

// Markers emitted by the Gemma 4 chat template when thinking is enabled.
const THOUGHT_OPEN = '<|channel>thought';
const THOUGHT_CLOSE = '<channel|>';

// Per-call output caps (max_new_tokens). Small on purpose: a tiny model rambles,
// and these are short, bounded tasks. Thinking is the longest; a tool decision is
// the shortest. Capping here is the cheap, reliable lever for "limit output".
const MAX_TOKENS_THINK = 256;
const MAX_TOKENS_STREAM = 320;
const MAX_TOKENS_DECIDE = 200;

// Gemma control/special tokens that must NEVER reach the UI as visible text. The
// chat template + skip_special_tokens:false (needed to PARSE the thought channel)
// can leak these into the stream (the user saw a stray `<turn|>`), so we strip a
// known set from any text we display or return. Kept as a regex of explicit tokens
// so we never accidentally eat legitimate prose like `<your-host>`.
const SPECIAL_TOKEN_RE =
  /<\|?(?:start_of_turn|end_of_turn|turn|bos|eos|pad|unk|mask)\|?>|<\|channel>(?:thought)?|<channel\|>|<end_of_turn>|<start_of_turn>|<\|tool_call>|<tool_call\|>|<\|tool_response>|<tool_response\|>|<\|tool>|<tool\|>/gi;

/** Strip Gemma control tokens + trim, so displayed/returned text is clean prose. */
export function cleanModelText(text: string): string {
  return text.replace(SPECIAL_TOKEN_RE, '').trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPipe = any;

/** A selectable model build. dtype maps to an ONNX file suffix in transformers.js. */
export interface ModelChoice {
  id: string;
  dtype: 'q8' | 'q4' | 'q4f16' | 'fp16';
  /** rough total download, for the UI note. */
  sizeNote: string;
  /** the largest single weight file, in bytes — the figure that governs whether
   *  `new ArrayBuffer(...)` can succeed on a given machine. */
  maxBufferBytes: number;
}

// DEFAULT = E2B q4f16. Why not E4B q8: E4B's decoder is a single ~2.1GB ONNX file,
// and some machines/browsers can't allocate one contiguous 2GB+ ArrayBuffer
// ("Array buffer allocation failed"). E2B q4f16 splits into ≤~1.6GB buffers and is
// far more likely to load, while keeping Gemma-4 native thinking + tool-calling.
export const MODELS: Record<string, ModelChoice> = {
  'e2b-q4f16': {
    id: 'onnx-community/gemma-4-E2B-it-ONNX',
    dtype: 'q4f16',
    sizeNote: '~3.1 GB',
    maxBufferBytes: 1_600_000_000,
  },
  'e2b-q8': {
    id: 'onnx-community/gemma-4-E2B-it-ONNX',
    dtype: 'q8',
    sizeNote: '~2.6 GB',
    maxBufferBytes: 2_100_000_000,
  },
  'e4b-q8': {
    id: 'onnx-community/gemma-4-E4B-it-ONNX',
    dtype: 'q8',
    sizeNote: '~2.9 GB',
    maxBufferBytes: 2_100_000_000,
  },
};

export const DEFAULT_MODEL_KEY = 'e2b-q4f16';

export class GemmaLLM implements LLM {
  private pipe: AnyPipe | null = null;
  private loading = false;
  private modelKey: string;

  // The interrupt handle for the CURRENT generation. transformers.js checks it
  // between tokens; interrupt() halts decode within ~one token. Recreated per
  // generate() so a stale interrupt can't poison the next call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stopper: any = null;
  private cancelRequested = false;

  constructor(modelKey: string = DEFAULT_MODEL_KEY) {
    this.modelKey = MODELS[modelKey] ? modelKey : DEFAULT_MODEL_KEY;
  }

  ready(): boolean {
    return this.pipe !== null;
  }

  /** Interrupt any in-flight generation. The decode loop stops within ~one token and
   *  generate() throws CancelledError so the await chain unwinds and the partial step
   *  is dropped. Safe to call when idle. */
  cancel(): void {
    this.cancelRequested = true;
    if (this.stopper && typeof this.stopper.interrupt === 'function') {
      this.stopper.interrupt();
    }
  }

  async load(onProgress: (pct: number) => void): Promise<void> {
    if (this.pipe || this.loading) return;
    // WebGPU guard — fail fast BEFORE attempting a multi-GB download so the UI can
    // show a graceful fallback (Safari without WebGPU, no-GPU devices, etc.).
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      throw new Error(
        'WebGPU not available in this browser. This demo needs a WebGPU-capable browser ' +
          '(recent Chrome/Edge 113+, or Safari Technology Preview) to run Gemma locally.',
      );
    }
    const model = MODELS[this.modelKey];
    this.loading = true;

    // Aggregate progress ACROSS all files so the bar never jumps backward. The
    // callback fires per-file with its own {loaded,total}; summing gives one
    // smooth 0→100% over the whole download instead of each file resetting to 0.
    const fileTotals = new Map<string, number>();
    const fileLoaded = new Map<string, number>();
    const reportAggregate = () => {
      let total = 0;
      let loaded = 0;
      for (const v of fileTotals.values()) total += v;
      for (const v of fileLoaded.values()) loaded += v;
      if (total > 0) onProgress(Math.max(0, Math.min(99, Math.round((loaded / total) * 100))));
    };

    try {
      const { pipeline } = await import('@huggingface/transformers');
      this.pipe = await pipeline('text-generation', model.id, {
        device: 'webgpu',
        dtype: model.dtype,
        // transformers.js fires {status,name,file,progress?,loaded?,total?} repeatedly.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        progress_callback: (p: any) => {
          if (!p) return;
          const key = `${p.name ?? ''}/${p.file ?? ''}`;
          if (typeof p.total === 'number' && p.total > 0) fileTotals.set(key, p.total);
          if (typeof p.loaded === 'number') fileLoaded.set(key, p.loaded);
          if (fileTotals.size > 0) reportAggregate();
          else if (typeof p.progress === 'number') {
            // fallback: a single coarse progress number
            onProgress(Math.max(0, Math.min(99, Math.round(p.progress))));
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      onProgress(100);
      this.cancelRequested = false;
    } catch (err) {
      // The classic OOM on a too-large contiguous weight buffer. Make it actionable.
      const msg = err instanceof Error ? err.message : String(err);
      if (/array buffer allocation failed|out of memory|allocation failed/i.test(msg)) {
        throw new Error(
          `Could not allocate memory for the model (${model.id}, ${model.sizeNote}). ` +
            'Your device/browser could not allocate a large enough buffer. Try a smaller ' +
            'model build, close other tabs, or use a machine with more GPU memory.',
        );
      }
      throw err;
    } finally {
      this.loading = false;
    }
  }

  /** Render messages to a prompt string via the model's chat template. */
  private async render(messages: ChatMsg[], enableThinking: boolean): Promise<string> {
    if (!this.pipe) throw new Error('LLM not loaded');
    const tok = this.pipe.tokenizer;
    // apply_chat_template returns a string when tokenize:false. enable_thinking is a
    // custom Gemma template kwarg unknown to the TS types → cast at this boundary.
    const text = tok.apply_chat_template(messages, {
      tokenize: false,
      add_generation_prompt: true,
      enable_thinking: enableThinking,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as string;
    return text;
  }

  /** Raw streaming generation (thinking OFF). Resolves with the full generated text. */
  async stream(messages: ChatMsg[], onToken: (t: string) => void): Promise<string> {
    if (!this.ready()) throw new Error('LLM not loaded');
    const prompt = await this.render(messages, false);
    let raw = '';
    let shownLen = 0; // chars of cleaned text already forwarded to onToken
    const text = await this.generate(
      prompt,
      (chunk) => {
        raw += chunk;
        // Clean the FULL accumulation each tick (a special token can split across
        // chunks), then forward only the newly-revealed clean suffix. This keeps
        // the displayed stream free of <turn|>-style control tokens.
        const cleaned = cleanModelText(raw);
        if (cleaned.length > shownLen) {
          onToken(cleaned.slice(shownLen));
          shownLen = cleaned.length;
        }
      },
      MAX_TOKENS_STREAM,
    );
    return cleanModelText(text || raw);
  }

  /**
   * Streaming thinking (thinking ON). Forwards ONLY the thought-channel text to
   * onToken, and resolves with the full thinking text. Incremental parser: track
   * whether we're inside <|channel>thought … <channel|>.
   */
  async think(messages: ChatMsg[], onToken: (t: string) => void): Promise<string> {
    if (!this.ready()) throw new Error('LLM not loaded');
    const prompt = await this.render(messages, true);
    let acc = ''; // full raw generation so far
    let inThought = false;
    let closed = false;
    let thinking = '';
    let forwarded = 0; // chars of CLEANED `thinking` already sent to onToken

    await this.generate(
      prompt,
      (chunk) => {
        acc += chunk;
        if (closed) return;
        if (!inThought) {
          const openIdx = acc.indexOf(THOUGHT_OPEN);
          if (openIdx === -1) return;
          inThought = true;
          // start reading right after the open marker
          const after = acc.slice(openIdx + THOUGHT_OPEN.length);
          thinking = stripLeadingNewline(after);
        } else {
          // recompute thinking region from acc each time (cheap; generations are short)
          const openIdx = acc.indexOf(THOUGHT_OPEN);
          thinking = stripLeadingNewline(acc.slice(openIdx + THOUGHT_OPEN.length));
        }
        const closeIdx = thinking.indexOf(THOUGHT_CLOSE);
        if (closeIdx !== -1) {
          thinking = thinking.slice(0, closeIdx);
          closed = true;
        }
        // Clean the FULL thought accumulation each tick (a special token can split
        // across chunks), then forward only the newly-revealed clean suffix.
        const cleaned = cleanModelText(thinking);
        if (cleaned.length > forwarded) {
          onToken(cleaned.slice(forwarded));
          forwarded = cleaned.length;
        }
      },
      MAX_TOKENS_THINK,
    );

    // Final reconciliation in case the close marker arrived in the last chunk.
    const openIdx = acc.indexOf(THOUGHT_OPEN);
    if (openIdx !== -1) {
      let t = stripLeadingNewline(acc.slice(openIdx + THOUGHT_OPEN.length));
      const closeIdx = t.indexOf(THOUGHT_CLOSE);
      if (closeIdx !== -1) t = t.slice(0, closeIdx);
      const cleaned = cleanModelText(t);
      if (cleaned.length > forwarded) onToken(cleaned.slice(forwarded));
      thinking = t;
    }
    return cleanModelText(thinking);
  }

  /**
   * Force a schema-valid structured decision. Streams tokens (so the UI decision
   * box fills live), then extracts + validates a single JSON object. THROWS on
   * failure so the scenario layer can retry. `onToken` is optional (stream the
   * raw decision text); the resolved ToolCall is the parsed result.
   */
  async decide(
    messages: ChatMsg[],
    schemaHint: string,
    onToken?: (t: string) => void,
  ): Promise<ToolCall> {
    if (!this.ready()) throw new Error('LLM not loaded');
    const augmented: ChatMsg[] = [
      ...messages,
      {
        role: 'user',
        content:
          'Reply with ONE JSON object — your next tool call — and NOTHING else. ' +
          'No prose, no explanation, no markdown fences. Schema:\n' +
          schemaHint +
          // The examples teach ONLY the JSON SHAPE — they use angle-bracket
          // placeholders, never real values, so a tiny model can't copy them as an
          // answer. (A concrete example here was being parroted verbatim every step,
          // which made the agent loop on the same call forever.) We deliberately
          // show the FORWARD tools (open a doc / finish), not search, so the model
          // is nudged to advance rather than re-search.
          '\n\nShape examples (copy the SHAPE, never these placeholder values):\n' +
          '  {"tool": "get_doc_summary", "args": {"doc_id": "<id from the latest hits>"}}\n' +
          '  {"tool": "get_doc", "args": {"doc_id": "<the one id worth opening in full>"}}\n' +
          '  {"tool": "mark_done", "args": {"result": {"root_cause": "<...>", "remediation": "<...>"}}}\n' +
          'Choose the tool that makes NEW progress from the MOST RECENT observation ' +
          'above. Do NOT repeat a call already present in the loop.\n' +
          'Now output the single JSON object for your next tool call:',
      },
    ];
    // Decisions should be short; cap tokens so a chatty model can't ramble past
    // the JSON. enable_thinking is OFF here — we want the JSON, not reasoning.
    const prompt = await this.render(augmented, false);
    // CRITICAL: parse the STREAMED completion (TextStreamer skip_prompt:true → the
    // callback emits ONLY the model's new tokens), NOT generate()'s return. The
    // pipeline returns prompt+completion, and our prefix-strip in
    // extractGeneratedText fails whenever the decoded text doesn't byte-match the
    // literal prompt (a special-token mismatch is enough). When that happened we
    // parsed the WHOLE prompt — so the prompt's schema hint + shape examples bled
    // into the parsed call (e.g. doc_id:"<id from the latest hits>"), making two
    // genuinely different decisions parse to the SAME signature and tripping the
    // stall guard. Accumulating the completion-only tokens fixes that at the root.
    let completion = '';
    const fallback = await this.generate(
      prompt,
      (t) => {
        completion += t;
        onToken?.(t);
      },
      MAX_TOKENS_DECIDE,
    );
    // Strip control tokens (<turn|> etc.) before parsing — enable_thinking is OFF so
    // there is no thought channel to preserve. Prefer the streamed completion; fall
    // back to generate()'s (already prefix-stripped) text only if nothing streamed.
    const raw = cleanModelText(completion.length > 0 ? completion : fallback);
    return parseDecision(raw);
  }

  /**
   * Low-level generation. If onToken is given, streams via TextStreamer. Returns
   * the decoded assistant text. Boundary-casts around transformers.js types.
   */
  private async generate(
    prompt: string,
    onToken?: (t: string) => void,
    maxNewTokens = 512,
  ): Promise<string> {
    if (!this.pipe) throw new Error('LLM not loaded');
    const { TextStreamer, InterruptableStoppingCriteria } = await import('@huggingface/transformers');
    // Fresh interrupt handle per call; clear any stale cancel request.
    this.cancelRequested = false;
    const stopper = new InterruptableStoppingCriteria();
    this.stopper = stopper;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = {
      max_new_tokens: maxNewTokens,
      do_sample: false,
      stopping_criteria: stopper,
    };
    if (onToken) {
      opts.streamer = new TextStreamer(this.pipe.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: false, // we need <|channel> markers for thinking parse
        callback_function: (t: string) => onToken(t),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }
    try {
      const out = await this.pipe(prompt, opts);
      // If the user interrupted, the model stopped early — treat as a cancellation
      // rather than returning a truncated answer the caller would commit.
      if (this.cancelRequested) throw new CancelledError();
      return extractGeneratedText(out, prompt);
    } finally {
      if (this.stopper === stopper) this.stopper = null;
    }
  }
}

// ─── helpers (pure, testable) ─────────────────────────────────────────────────

function stripLeadingNewline(s: string): string {
  return s.startsWith('\n') ? s.slice(1) : s;
}

/** transformers.js text-generation returns [{ generated_text }]; normalize it. */
function extractGeneratedText(out: unknown, prompt: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const first: any = Array.isArray(out) ? out[0] : out;
  const gen = first?.generated_text;
  if (typeof gen === 'string') {
    // pipeline returns prompt+completion; strip the prompt prefix when present.
    return gen.startsWith(prompt) ? gen.slice(prompt.length) : gen;
  }
  // chat-style return: generated_text may be a message array.
  if (Array.isArray(gen)) {
    const last = gen[gen.length - 1];
    if (last && typeof last.content === 'string') return last.content;
  }
  return typeof first === 'string' ? first : '';
}

/**
 * Extract the first balanced {...} JSON object from arbitrary model text.
 * Robust to: a leading thinking channel, ``` fences, and prose around the object.
 */
export function extractJsonObject(text: string): string {
  let s = text;
  // If the model emitted a thinking channel before the answer, drop it.
  const closeThought = s.lastIndexOf(THOUGHT_CLOSE);
  if (closeThought !== -1) s = s.slice(closeThought + THOUGHT_CLOSE.length);
  s = s.trim();
  // strip ``` fences if present
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = s.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in model output');
  let depth = 0;
  let inStr = false;
  let strCh = '"';
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === strCh) inStr = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
    } else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  // Unbalanced (model truncated): return from the first { to the end so repair can try.
  return s.slice(start);
}

/** Best-effort repair of near-JSON small-model output into parseable JSON. */
function repairJson(json: string): string {
  let s = json;
  // single-quoted strings/keys → double-quoted (naive but effective for flat objects)
  s = s.replace(/'/g, '"');
  // quote bare keys:  {tool: ...}  →  {"tool": ...}
  s = s.replace(/([{,]\s*)([A-Za-z_][\w-]*)(\s*:)/g, '$1"$2"$3');
  // remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  // close one unbalanced trailing brace if the model was truncated
  const opens = (s.match(/{/g) ?? []).length;
  const closes = (s.match(/}/g) ?? []).length;
  if (opens > closes) s += '}'.repeat(opens - closes);
  return s;
}

/**
 * Parse + lightly validate a decision into a ToolCall. Tries strict JSON, then a
 * repaired version, then a last-ditch fuzzy extraction (find a known tool name +
 * a "query"/"doc_id"/"result" value). Throws only if nothing usable is found.
 */
export function parseDecision(raw: string): ToolCall {
  let json: string | null = null;
  try {
    json = extractJsonObject(raw);
  } catch {
    json = null; // no JSON object at all → fall through to fuzzy extraction
  }
  if (json) {
    const obj: unknown = tryParse(json) ?? tryParse(repairJson(json));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const rec = obj as Record<string, unknown>;
      const tool = rec.tool;
      if (typeof tool === 'string' && TOOL_NAMES.includes(tool as ToolName)) {
        const args =
          rec.args && typeof rec.args === 'object' && !Array.isArray(rec.args)
            ? (rec.args as Record<string, unknown>)
            : {};
        return { tool: tool as ToolName, args };
      }
    }
  }

  // Last resort: the JSON was unsalvageable but a tool name may still be in the text.
  const fuzzy = fuzzyDecision(raw);
  if (fuzzy) return fuzzy;

  throw new Error('decision JSON failed to parse');
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Find a known tool name in free text and pull out an obvious argument. */
function fuzzyDecision(raw: string): ToolCall | null {
  const lower = raw.toLowerCase();
  // Pick the tool whose name appears EARLIEST in the text — not the first in
  // TOOL_NAMES order. The old "find()" grabbed whichever tool came first in the
  // array (search_corpus), so a `get_doc_summary` completion that merely mentioned
  // "search" anywhere mis-parsed as search_corpus. Earliest-in-text matches intent.
  let tool: ToolName | null = null;
  let bestIdx = Infinity;
  for (const t of TOOL_NAMES) {
    const i = lower.indexOf(t);
    if (i !== -1 && i < bestIdx) {
      bestIdx = i;
      tool = t;
    }
  }
  if (!tool) return null;
  const args: Record<string, unknown> = {};
  // Reject obviously-bogus captures: a value carrying angle brackets is a leaked
  // SHAPE placeholder (e.g. "<id from the latest hits>"), never a real argument.
  const clean = (v: string | undefined): string | null =>
    v && !v.includes('<') && !v.includes('>') ? v : null;
  const q = clean(raw.match(/"?query"?\s*[:=]\s*"([^"]+)"/i)?.[1]);
  if (q) args.query = q;
  const d = clean(raw.match(/"?doc_id"?\s*[:=]\s*"([^"]+)"/i)?.[1]);
  // search_corpus takes ONLY {query, k} — never a doc_id. Attaching one here is the
  // exact corruption that made step-1 (search) and step-2 (open a doc) collapse to
  // the same signature and trip the stall guard. Drop doc_id for search_corpus.
  if (d && tool !== 'search_corpus') args.doc_id = d;
  return { tool, args };
}
