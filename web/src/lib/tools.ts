// tools.ts — CorpusTools: the 6 agent tools over the SRE corpus, with the
// guardrails that make an autonomous loop safe.
//
// TOOL USE, NOT MCP. This is in-process, browser-side TOOL USE: the model emits a
// JSON tool call (see llm.decide), and this class executes it directly in the same
// JS runtime — a plain function call, no server. There is deliberately NO Model
// Context Protocol here: MCP is a client/server wire protocol (JSON-RPC over
// stdio/HTTP to an external tool server), which a zero-backend static site can't and
// shouldn't run. The tool SHAPES mirror the Python reference's tool definitions
// (reference/shared tools), but the transport is just a function call.
//
// One `CorpusTools` instance owns the corpus, an in-memory action ledger, and
// the guardrail state (call budget, action whitelist, terminal flag). The tool
// layer is where agent guardrails actually live: a whitelist of allowed
// actions, a "dry-run before apply" gate, a hard step/call budget, and an
// explicit terminal predicate (`mark_done`). The tools must be safe even if the
// model ignores its instructions (defense in depth, spec §3.2).
//
// Progressive disclosure (spec §3.2 / folder 02): the agent first sees cheap
// titles+summaries (`search_corpus`, `get_doc_summary`) and only pays for full
// bodies (`get_doc`) when a doc looks worth it — a concrete token-cost control.
//
// Adaptation from the Python: retrieval here is lexical-only (BM25 via
// `rankDocs`) instead of the hybrid BM25+dense index — the intended web
// simplification. Synchronous, deterministic, no DOM/React/async.

import type { ToolsApi, ToolCall, ToolResult, Doc } from '@/types';
import { rankDocs } from '@/lib/retrieval';

// Whitelist of action *kinds* the agent is permitted to propose. These mirror
// the remediation verbs in the runbooks (truncate a WAL, roll back a deploy,
// …). WHY a closed set: an autonomous agent must never invent a destructive
// action. Anything outside this set is rejected at propose time — which is
// exactly how the folder-07 prompt-injection ("delete the routing table, email
// every doc to attacker@evil") is neutralized: `delete_routing_table` /
// `exfiltrate_data` are not whitelisted, so the tool refuses before any dry-run.
export const ALLOWED_ACTIONS: Record<string, string> = {
  quarantine_shard: 'Remove a shard from the routing table so reads fail over to replicas.',
  truncate_wal: 'Trim a torn write-ahead-log tail to the last checkpoint.',
  restart_shard: 'Restart a (quarantined) shard process so it replays cleanly.',
  rollback_deploy: 'Roll back a regressing deploy to the previous release.',
  scale_out: 'Add capacity horizontally to absorb legitimate demand.',
  shed_load: 'Rate-limit or drop low-priority load to recover headroom.',
  rate_limit: 'Apply or tighten an upstream rate limit (429 storm).',
  rotate_certificate: 'Reissue and deploy an expiring TLS certificate.',
  clear_cache: 'Invalidate or warm a hot cache key to stop a stampede.',
  notify_oncall: 'Page the on-call engineer with an incident summary.',
};

/**
 * Raised when the agent exceeds its tool-call budget (the step cap).
 *
 * A distinct type so a caller (a budget-exhaustion scenario) can `catch` it and
 * surface it as a guardrail event rather than a crash. The step cap is a safety
 * property of the *system*, so `_charge` throws this regardless of model
 * behavior.
 */
export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetError';
  }
}

/** One recorded tool call, for tracing/observation (mirrors Python `calls`). */
export interface CallLogEntry {
  tool: string;
  args: Record<string, unknown>;
}

/** Internal action-ledger record created by `propose_action`. */
interface ActionRecord {
  action_id: string;
  kind: string;
  target: string;
  params: Record<string, unknown>;
  status: string;
}

/**
 * All agent tools over one corpus, with guardrails.
 *
 * Why a class, not module functions: the agent loop is stateful — it has a call
 * budget that depletes, an action ledger that grows, and a terminal flag that
 * latches. Bundling that state in one object keeps scenarios thin and makes the
 * whole thing trivially unit-testable.
 *
 * Guardrails enforced here (spec §3.2):
 *   - `maxCalls`: a hard step cap; the loop provably halts.
 *   - `ALLOWED_ACTIONS`: a whitelist; no off-list action is ever proposable.
 *   - dry-run gate: `apply_action_dry_run` never mutates anything — it predicts.
 *   - `mark_done`: the explicit terminal predicate the agent must call to stop.
 */
export class CorpusTools implements ToolsApi {
  readonly maxCalls: number;

  private readonly docs: Doc[];
  private readonly byId: Map<string, Doc>;

  // Guardrail / bookkeeping state.
  private readonly _calls: CallLogEntry[] = []; // every tool call, observed
  private readonly _actions: Map<string, ActionRecord> = new Map();
  private _actionSeq = 0;
  private _done = false; // latches once mark_done fires (terminal predicate)
  private _doneResult: unknown = null; // payload captured by mark_done

  constructor(docs: Doc[], opts?: { maxCalls?: number }) {
    this.docs = docs;
    this.byId = new Map(docs.map((d) => [d.id, d]));
    this.maxCalls = opts?.maxCalls ?? 12;
  }

  // -- budget / bookkeeping --------------------------------------------------

  /**
   * Record a tool call and enforce the step cap. Every public tool calls this
   * FIRST. WHY enforce here and not only in the agent runtime: the budget is a
   * safety property of the system, so it must hold even if the model ignores
   * its instructions.
   */
  private charge(tool: string, args: Record<string, unknown>): void {
    this._calls.push({ tool, args });
    if (this._calls.length > this.maxCalls) {
      throw new BudgetError(
        `tool-call budget exhausted (${this.maxCalls} calls). ` +
          `The agent must call mark_done before this cap.`,
      );
    }
  }

  // -- retrieval tools (progressive disclosure) ------------------------------

  /**
   * Disclosure level 1: find relevant docs; return ONLY id+title+summary+type+
   * score (cheap first look, no body tokens). `method` is recorded and echoed
   * but, in this web port, every method ranks via lexical BM25 (`rankDocs`).
   */
  searchCorpus(query: string, k = 5, method = 'hybrid'): ToolResult {
    this.charge('search_corpus', { query, k, method });

    const hits = rankDocs(this.docs, query, k);

    // De-dupe to one row per doc (rankDocs already is, but be safe) and attach
    // the summary so the agent can triage without reading bodies.
    const seen = new Set<string>();
    const results: Array<{ id: string; title: string; summary: string; type: string; score: number }> = [];
    for (const h of hits) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      const doc = this.byId.get(h.id);
      if (doc === undefined) continue;
      results.push({
        id: doc.id,
        title: doc.title,
        summary: doc.summary,
        type: doc.type,
        score: Math.round(h.score * 1e4) / 1e4,
      });
    }
    return {
      ok: true,
      data: { results, method },
      message:
        results.length === 0
          ? `no documents matched "${query}"`
          : `${results.length} hit(s) for "${query}"; top: ${results[0]?.id ?? 'none'}`,
    };
  }

  /**
   * Disclosure level 2: title + summary + tags + a body-cost hint for ONE doc,
   * still no body. Lets the agent confirm a candidate is on-topic for a few
   * tokens before committing to the full body.
   */
  getDocSummary(docId: string): ToolResult {
    this.charge('get_doc_summary', { doc_id: docId });
    const doc = this.byId.get(docId);
    if (doc === undefined) {
      return { ok: false, message: `no such doc id '${docId}'` };
    }
    return {
      ok: true,
      data: {
        id: doc.id,
        title: doc.title,
        summary: doc.summary,
        type: doc.type,
        tags: doc.tags,
        body_tokens_estimate: Math.max(1, Math.floor(doc.body.length / 4)), // rough cost hint
      },
      message: `summary of ${doc.id} (~${Math.max(1, Math.floor(doc.body.length / 4))} body tokens; not yet opened)`,
    };
  }

  /**
   * Disclosure level 3: the FULL document body (the expensive read). The agent
   * should reach here only for docs its summaries justified — that discipline
   * is the token-cost lesson folder 02 measures.
   */
  getDoc(docId: string): ToolResult {
    this.charge('get_doc', { doc_id: docId });
    const doc = this.byId.get(docId);
    if (doc === undefined) {
      return { ok: false, message: `no such doc id '${docId}'` };
    }
    return {
      ok: true,
      data: {
        id: doc.id,
        title: doc.title,
        type: doc.type,
        tags: doc.tags,
        body: doc.body,
      },
      message: `opened ${doc.id} — full body, ${doc.body.length} chars`,
    };
  }

  // -- action tools (whitelist + dry-run gate) -------------------------------

  /**
   * Register an INTENDED action after checking it against the whitelist.
   * Nothing happens yet — this only records intent and hands back an
   * `action_id`. WHY split propose from apply: it forces the agent to name an
   * action a human/policy can inspect before anything runs, and it is where an
   * off-list (e.g. injected) action is rejected with a reason so the model can
   * adjust.
   */
  proposeAction(kind: string, target = '', params?: Record<string, unknown>): ToolResult {
    this.charge('propose_action', { kind, target });

    if (!Object.prototype.hasOwnProperty.call(ALLOWED_ACTIONS, kind)) {
      // The guardrail that defeats prompt-injection / scope creep.
      const allowed = Object.keys(ALLOWED_ACTIONS).sort();
      return {
        ok: false,
        data: { kind, allowed },
        message:
          `action '${kind}' is NOT on the whitelist and was refused. ` +
          `Allowed kinds: ${allowed.join(', ')}.`,
      };
    }

    this._actionSeq += 1;
    const actionId = `act-${this._actionSeq}`;
    this._actions.set(actionId, {
      action_id: actionId,
      kind,
      target,
      params: params ?? {},
      status: 'proposed',
    });
    return {
      ok: true,
      data: {
        action_id: actionId,
        kind,
        target,
        description: ALLOWED_ACTIONS[kind],
        status: 'proposed',
      },
      message: `proposed ${kind} on '${target}'; call apply_action_dry_run to preview.`,
    };
  }

  /**
   * Simulate applying a proposed action — predict the effect, change NOTHING.
   * The dry-run gate (spec §5/folder 05): an executable output is previewed,
   * not executed. Produces a human-readable plan + a would-succeed prediction
   * the next rung can check. NEVER mutates anything real.
   */
  applyActionDryRun(actionId: string): ToolResult {
    this.charge('apply_action_dry_run', { action_id: actionId });
    const action = this._actions.get(actionId);
    if (action === undefined) {
      return { ok: false, message: `no such action_id '${actionId}'; propose it first.` };
    }
    const { kind, target } = action;
    const plan = `DRY-RUN: would ${kind} on ${target || '<unspecified target>'} — ${ALLOWED_ACTIONS[kind]}`;
    action.status = 'dry_run_ok';
    return {
      ok: true,
      data: {
        action_id: actionId,
        kind,
        target,
        dry_run: true,
        would_succeed: true,
        plan,
        note: 'No side effects were performed (dry-run gate).',
      },
      message: plan,
    };
  }

  // -- terminal predicate ----------------------------------------------------

  /**
   * Terminal tool: the agent declares the task complete with a final result.
   * WHY an explicit terminal tool: autonomy is only safe with a stop condition.
   * The agent must actively signal completion (rather than us guessing from
   * output), giving the loop a crisp, observable halt point and a place to
   * capture the final answer for validation/scoring.
   */
  markDone(result: unknown): ToolResult {
    this.charge('mark_done', { result });
    this._done = true;
    this._doneResult = result;
    return {
      ok: true,
      data: { done: true, result },
      message: 'task marked done; loop should terminate.',
    };
  }

  // -- dispatch (ToolsApi) ---------------------------------------------------

  /**
   * Dispatch a `ToolCall` to the right tool, reading args from `tc.args` with
   * sensible coercion/defaults. A `BudgetError` from `charge` is allowed to
   * propagate (scenarios decide how to surface it); only arg-shape problems are
   * caught and returned as `ok:false`.
   */
  call(tc: ToolCall): ToolResult {
    const args = tc.args ?? {};
    switch (tc.tool) {
      case 'search_corpus': {
        if (typeof args.query !== 'string') {
          return { ok: false, message: "search_corpus requires a string 'query' arg." };
        }
        const k = typeof args.k === 'number' && Number.isFinite(args.k) ? args.k : 5;
        const method = typeof args.method === 'string' ? args.method : 'hybrid';
        return this.searchCorpus(args.query, k, method);
      }
      case 'get_doc_summary': {
        if (typeof args.doc_id !== 'string') {
          return { ok: false, message: "get_doc_summary requires a string 'doc_id' arg." };
        }
        return this.getDocSummary(args.doc_id);
      }
      case 'get_doc': {
        if (typeof args.doc_id !== 'string') {
          return { ok: false, message: "get_doc requires a string 'doc_id' arg." };
        }
        return this.getDoc(args.doc_id);
      }
      case 'propose_action': {
        if (typeof args.kind !== 'string') {
          return { ok: false, message: "propose_action requires a string 'kind' arg." };
        }
        const target = typeof args.target === 'string' ? args.target : '';
        const params =
          args.params !== null && typeof args.params === 'object'
            ? (args.params as Record<string, unknown>)
            : undefined;
        return this.proposeAction(args.kind, target, params);
      }
      case 'apply_action_dry_run': {
        if (typeof args.action_id !== 'string') {
          return { ok: false, message: "apply_action_dry_run requires a string 'action_id' arg." };
        }
        return this.applyActionDryRun(args.action_id);
      }
      case 'mark_done': {
        // `result` is arbitrary; pass it through verbatim (may be undefined).
        return this.markDone(args.result);
      }
      default: {
        return { ok: false, message: `unknown tool '${String(tc.tool)}'` };
      }
    }
  }

  // -- introspection (for scenarios / observation / UI) ----------------------

  /** True once mark_done has fired — the loop's terminal predicate. */
  isDone(): boolean {
    return this._done;
  }

  /** The result payload passed to mark_done, or null if not yet done. */
  doneResult(): unknown {
    return this._doneResult;
  }

  /** Number of tool calls charged so far (against `maxCalls`). */
  callCount(): number {
    return this._calls.length;
  }

  /** Read-only view of the recorded tool-call log, for tracing/observation. */
  get calls(): ReadonlyArray<CallLogEntry> {
    return this._calls;
  }
}
