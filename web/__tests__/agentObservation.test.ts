// agentObservation.test.ts — pins the agent's WORKING MEMORY against the stall the
// user hit even AFTER the parser was fixed: the model read a doc with get_doc, but
// the observation recorded only "body: 833 chars" and discarded the content — so the
// model never saw the runbook, couldn't state a root cause, and looped re-opening
// docs until the stall guard fired ("multiturn 最后还是不 summarize").
//
// The fix: summarizeData() now puts the FULL body (get_doc) and a clean title+summary
// (get_doc_summary) into the observation, which buildContext copies into the next
// step's context. These tests assert the content actually survives into memory.

import { describe, it, expect } from 'vitest';
import { summarizeData } from '@/lib/scenarios/02_agent';
import { buildContext } from '@/lib/prompts';
import { CorpusTools } from '@/lib/tools';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Doc, StepView } from '@/types';

const CORPUS_PATH = fileURLToPath(new URL('../public/corpus.json', import.meta.url));
const DOCS: Doc[] = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Doc[];

describe('summarizeData — the agent remembers what it read', () => {
  it('get_doc surfaces the FULL body, not just a char count (the stall fix)', () => {
    const tools = new CorpusTools(DOCS, { maxCalls: 12 });
    const res = tools.call({ tool: 'get_doc', args: { doc_id: 'shard_restart_e1342' } });
    const obs = summarizeData(res.data);
    // The OLD behavior was `\nbody: 833 chars` — the content thrown away. Assert the
    // actual runbook text (the fix the model needs to conclude) is now present.
    expect(obs).not.toMatch(/body:\s*\d+\s*chars/);
    expect(obs).toContain('write-ahead log');
    expect(obs).toContain('truncate');
    // The whole body should be there (small corpus docs are included whole).
    const doc = DOCS.find((d) => d.id === 'shard_restart_e1342')!;
    expect(obs).toContain(doc.body);
  });

  it('get_doc_summary shows a clean title+summary, not truncated JSON', () => {
    const tools = new CorpusTools(DOCS, { maxCalls: 12 });
    const res = tools.call({ tool: 'get_doc_summary', args: { doc_id: 'shard_restart_e1342' } });
    const obs = summarizeData(res.data);
    expect(obs).toContain('Resolve error code E1342');
    // The old code dumped raw JSON that cut off mid-field (`...tags":["shard`).
    expect(obs).not.toContain('"tags":["');
  });

  it('search_corpus lists hits WITH titles so the model can triage by name', () => {
    const tools = new CorpusTools(DOCS, { maxCalls: 12 });
    const res = tools.call({ tool: 'search_corpus', args: { query: 'E1342 shard restart', k: 5 } });
    const obs = summarizeData(res.data);
    expect(obs).toContain('shard_restart_e1342');
    expect(obs).toMatch(/—/); // "id — title" rows
  });

  it('the read body flows into the NEXT step context via buildContext (end-to-end)', () => {
    // Simulate a committed step whose observation is a real get_doc result, exactly
    // as 02_agent builds it, then confirm buildContext carries it into working memory.
    const tools = new CorpusTools(DOCS, { maxCalls: 12 });
    const res = tools.call({ tool: 'get_doc', args: { doc_id: 'shard_restart_e1342' } });
    const observationBody = `[ok] ${res.message}` + summarizeData(res.data);
    const priorStep: StepView = {
      index: 0,
      title: 'Thinking + Decide',
      streams: [],
      panels: [
        { key: 'decision', label: 'tool', body: 'get_doc({"doc_id":"shard_restart_e1342"})' },
        { key: 'observation', label: 'obs', body: observationBody },
      ],
    };
    const context = buildContext('incident?', [priorStep]);
    // The model's next prompt now CONTAINS the runbook fix — so it can conclude.
    expect(context).toContain('truncate');
    expect(context).toContain('write-ahead log');
  });
});
