// decision.test.ts — pins the decision PARSER against the exact stall the user hit.
//
// The bug (folder 02 agent looping forever): decide() was parsing prompt+completion
// (the pipeline return), not the streamed completion. So the prompt's shape example
// `{"doc_id": "<id from the latest hits>"}` and its OPERATING PROCEDURE (which names
// search_corpus FIRST) bled into the parse — a genuine `get_doc_summary` decision
// came out as `search_corpus({query, doc_id:"<id from the latest hits>"})`, which
// (a) is a malformed call (search takes no doc_id) and (b) collapsed two different
// steps to the SAME signature, tripping the stall guard before the agent advanced.
//
// These tests assert parseDecision recovers the RIGHT call from clean completion
// text and that the fuzzy fallback can NEVER re-introduce the corruption.

import { describe, it, expect } from 'vitest';
import { parseDecision, cleanModelText } from '@/lib/llm';

describe('parseDecision — clean completion (the normal path)', () => {
  it('parses a well-formed get_doc_summary call', () => {
    const raw = '{"tool": "get_doc_summary", "args": {"doc_id": "shard_restart_e1342"}}';
    expect(parseDecision(raw)).toEqual({
      tool: 'get_doc_summary',
      args: { doc_id: 'shard_restart_e1342' },
    });
  });

  it('parses a search_corpus call with query + k (no doc_id)', () => {
    const raw = '{"tool": "search_corpus", "args": {"query": "cpu pegging E1342", "k": 5}}';
    expect(parseDecision(raw)).toEqual({
      tool: 'search_corpus',
      args: { query: 'cpu pegging E1342', k: 5 },
    });
  });

  it('strips a trailing <turn|> control token before parsing (Bug D)', () => {
    const raw = '{"tool": "get_doc_summary", "args": {"doc_id": "shard_restart_e1342"}}<turn|>';
    // cleanModelText is applied in decide() before parseDecision; emulate that here.
    expect(parseDecision(cleanModelText(raw))).toEqual({
      tool: 'get_doc_summary',
      args: { doc_id: 'shard_restart_e1342' },
    });
  });
});

describe('fuzzyDecision (via parseDecision) — never re-introduce the corruption', () => {
  // These inputs have NO valid JSON object, forcing the fuzzy fallback. The fallback
  // must still refuse to (a) attach a doc_id to search_corpus, or (b) emit a value
  // carrying angle brackets (a leaked SHAPE placeholder).

  it('never attaches a doc_id to search_corpus', () => {
    // free text mentioning search + a doc_id (the exact corruption shape)
    const raw = 'I will call search_corpus query="E1342" doc_id="shard_restart_e1342"';
    const out = parseDecision(raw);
    expect(out.tool).toBe('search_corpus');
    expect(out.args).not.toHaveProperty('doc_id');
    expect(out.args.query).toBe('E1342');
  });

  it('rejects an angle-bracket placeholder value (the leaked prompt example)', () => {
    const raw = 'get_doc_summary with doc_id="<id from the latest hits>"';
    const out = parseDecision(raw);
    expect(out.tool).toBe('get_doc_summary');
    // the bogus placeholder must NOT survive as an argument
    expect(out.args.doc_id).toBeUndefined();
  });

  it('picks the tool that appears EARLIEST in the text, not first in the enum', () => {
    // get_doc_summary appears; search is only mentioned as past context. Earliest
    // real mention wins → get_doc_summary, not search_corpus.
    const raw = 'Next I will get_doc_summary on the top hit (after the earlier search).';
    expect(parseDecision(raw).tool).toBe('get_doc_summary');
  });
});
