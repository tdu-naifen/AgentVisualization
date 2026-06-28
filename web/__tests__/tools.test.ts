// tools.test.ts — CorpusTools: the 6 agent tools + their guardrails.
//
// The guardrails are the lesson: progressive disclosure (search/summary hide the
// body; get_doc pays for it), a closed action whitelist (off-list propose_action
// is refused), an explicit terminal predicate (mark_done), and a hard call budget
// (BudgetError once maxCalls is exceeded).

import { describe, it, expect } from 'vitest';
import { CorpusTools, ALLOWED_ACTIONS, BudgetError } from '@/lib/tools';
import type { Doc, ToolResult } from '@/types';

const DOCS: Doc[] = [
  {
    id: 'shard_restart_e1342',
    title: 'Shard restart loop (E1342)',
    summary: 'Unclean WAL tail blocks shard replay; quarantine + truncate.',
    type: 'runbook',
    tags: ['storage'],
    body: 'Full body: error E1342 means the write-ahead log tail is torn. Truncate to the last checkpoint.',
  },
  {
    id: 'cpu_saturation_runbook',
    title: 'CPU saturation runbook',
    summary: 'Triage a service pegging CPU.',
    type: 'runbook',
    tags: ['compute'],
    body: 'Full body: find the hot path, shed load, scale out if demand is legitimate.',
  },
  {
    id: 'tls_cert_rotation',
    title: 'TLS certificate rotation',
    summary: 'Reissue an expiring certificate.',
    type: 'runbook',
    tags: ['security'],
    body: 'Full body: rotate the cert, deploy to the edge, verify the chain.',
  },
];

/** Narrow a ToolResult's `data` to a record for ergonomic assertions. */
function data(res: ToolResult): Record<string, unknown> {
  expect(res.data).toBeTypeOf('object');
  return res.data as Record<string, unknown>;
}

describe('CorpusTools — progressive disclosure', () => {
  it('search_corpus (L1) returns id/title/summary/score but NO body field', () => {
    const tools = new CorpusTools(DOCS, { maxCalls: 12 });
    const res = tools.call({ tool: 'search_corpus', args: { query: 'E1342', k: 5 } });
    expect(res.ok).toBe(true);
    const results = data(res).results as Array<Record<string, unknown>>;
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top.id).toBe('shard_restart_e1342');
    expect(top).toHaveProperty('title');
    expect(top).toHaveProperty('summary');
    expect(top).toHaveProperty('score');
    // The whole point of L1: no body tokens are disclosed.
    expect(top).not.toHaveProperty('body');
  });

  it('get_doc (L3) discloses the full body', () => {
    const tools = new CorpusTools(DOCS, { maxCalls: 12 });
    const res = tools.call({ tool: 'get_doc', args: { doc_id: 'shard_restart_e1342' } });
    expect(res.ok).toBe(true);
    const body = data(res).body;
    expect(typeof body).toBe('string');
    expect(body as string).toContain('E1342');
  });

  it('get_doc_summary (L2) stays cheap: tags + a cost hint, still no body', () => {
    const tools = new CorpusTools(DOCS, { maxCalls: 12 });
    const res = tools.call({ tool: 'get_doc_summary', args: { doc_id: 'cpu_saturation_runbook' } });
    expect(res.ok).toBe(true);
    const d = data(res);
    expect(d).toHaveProperty('tags');
    expect(d).toHaveProperty('body_tokens_estimate');
    expect(d).not.toHaveProperty('body');
  });
});

describe('CorpusTools — action whitelist', () => {
  it('propose_action with a whitelisted kind returns ok + an action_id', () => {
    const tools = new CorpusTools(DOCS, { maxCalls: 12 });
    expect(ALLOWED_ACTIONS).toHaveProperty('truncate_wal'); // sanity: it really is whitelisted
    const res = tools.call({
      tool: 'propose_action',
      args: { kind: 'truncate_wal', target: 'shard-7' },
    });
    expect(res.ok).toBe(true);
    expect(data(res).action_id).toBe('act-1');
    expect(data(res).kind).toBe('truncate_wal');
  });

  it('propose_action with an off-list kind is refused (ok:false) before any dry-run', () => {
    const tools = new CorpusTools(DOCS, { maxCalls: 12 });
    expect(ALLOWED_ACTIONS).not.toHaveProperty('delete_routing_table');
    const res = tools.call({
      tool: 'propose_action',
      args: { kind: 'delete_routing_table', target: 'prod-routing' },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/whitelist/i);
  });
});

describe('CorpusTools — terminal predicate', () => {
  it('starts not-done and latches done after mark_done, capturing the result', () => {
    const tools = new CorpusTools(DOCS, { maxCalls: 12 });
    expect(tools.isDone()).toBe(false);
    const payload = { root_cause: 'torn WAL tail', remediation: 'truncate + restart' };
    const res = tools.call({ tool: 'mark_done', args: { result: payload } });
    expect(res.ok).toBe(true);
    expect(tools.isDone()).toBe(true);
    expect(tools.doneResult()).toEqual(payload);
  });
});

describe('CorpusTools — call budget', () => {
  it('throws BudgetError once the maxCalls cap is exceeded', () => {
    const tools = new CorpusTools(DOCS, { maxCalls: 1 });
    // First call is within budget.
    expect(() => tools.call({ tool: 'search_corpus', args: { query: 'E1342' } })).not.toThrow();
    expect(tools.callCount()).toBe(1);
    // Second call exceeds maxCalls:1 → BudgetError.
    let caught: unknown = null;
    try {
      tools.call({ tool: 'search_corpus', args: { query: 'cpu' } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetError);
    expect((caught as Error).message).toMatch(/budget/i);
  });
});
