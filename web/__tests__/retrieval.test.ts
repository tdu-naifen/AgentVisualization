// retrieval.test.ts — the BM25 lexical retriever + its tokenizer.
//
// The teaching property of folder 01/03: lexical retrieval wins on exact/rare
// identifiers (an error code like E1342) precisely because the tokenizer keeps
// such identifiers intact rather than splitting `e1342` into `e` + `1342`.

import { describe, it, expect } from 'vitest';
import { rankDocs, tokenize } from '@/lib/retrieval';
import type { Doc } from '@/types';

/** A tiny corpus: only `shard_restart_e1342` carries the rare token E1342. */
const DOCS: Doc[] = [
  {
    id: 'shard_restart_e1342',
    title: 'Shard restart loop',
    summary: 'Shards restart repeatedly after an unclean WAL tail.',
    type: 'runbook',
    tags: ['storage', 'shard'],
    body:
      'When a shard hits error E1342 it cannot replay its write-ahead log and ' +
      'enters a restart loop that pegs the CPU; quarantine the shard and truncate the WAL.',
  },
  {
    id: 'cpu_cooler_guide',
    title: 'Best CPU coolers buying guide',
    summary: 'How to pick an aftermarket CPU cooler for a quiet build.',
    type: 'article',
    tags: ['hardware'],
    body: 'A good CPU cooler keeps temperatures low. Compare airflow and noise.',
  },
  {
    id: 'tls_cert_rotation',
    title: 'Rotating TLS certificates',
    summary: 'Reissue and deploy an expiring TLS certificate before it lapses.',
    type: 'runbook',
    tags: ['security'],
    body: 'Rotate the certificate, deploy it to the edge, and verify the chain.',
  },
];

describe('tokenize', () => {
  it('keeps a rare identifier like E1342 intact as one lowercased token', () => {
    const toks = tokenize('error E1342');
    expect(toks).toContain('e1342');
    // it must NOT be split into letter+digits
    expect(toks).not.toContain('e');
    expect(toks).not.toContain('1342');
    expect(toks).toEqual(['error', 'e1342']);
  });

  it('keeps other hyphenated/numeric identifiers whole (shard-7, p99, 5xx)', () => {
    // "with" is a stopword and is dropped; the identifiers survive intact.
    expect(tokenize('shard-7 p99 with 5xx')).toEqual(['shard-7', 'p99', '5xx']);
  });

  it('drops stopwords so conversational query words do not dominate', () => {
    // "why is my" are all stopwords; only the content tokens survive.
    expect(tokenize('why is my service')).toEqual(['service']);
  });
});

describe('rankDocs', () => {
  it('ranks the doc whose body contains E1342 first for an E1342 query', () => {
    const hits = rankDocs(DOCS, 'E1342', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('shard_restart_e1342');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('drops docs that match no query term (rare token absent elsewhere)', () => {
    // Only one doc contains e1342, so only one hit comes back.
    const hits = rankDocs(DOCS, 'E1342', 5);
    expect(hits).toHaveLength(1);
    expect(hits.map((h) => h.id)).not.toContain('cpu_cooler_guide');
  });

  it('respects k and returns nothing for a term absent from the corpus', () => {
    // 'cpu' now appears in two docs; k caps the result list.
    expect(rankDocs(DOCS, 'cpu', 5)).toHaveLength(2);
    expect(rankDocs(DOCS, 'cpu', 1)).toHaveLength(1); // capped at k
    expect(rankDocs(DOCS, 'kubernetes', 5)).toHaveLength(0); // no match
    expect(rankDocs([], 'anything', 5)).toHaveLength(0); // empty corpus
  });
});
