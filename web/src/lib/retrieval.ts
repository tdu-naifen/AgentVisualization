// retrieval.ts — BM25 lexical retriever (exact-token / rare-identifier match).
//
// A zero-dependency, pure-TypeScript port of the teaching retriever in
// reference/shared/retrieval/embed_light.py. BM25 ranks documents by exact term
// overlap with the query, weighting rare terms heavily (IDF) and saturating term
// frequency (k1) with document-length normalization (b). It is the right tool
// when a query hinges on a specific token a dense model would smear — a rare
// error code like `E1342`, a flag name, an IP.
//
// Teaching point (spec §3.3): *lexical retrieval wins on exact/rare identifiers
// and loses on intent.* The tokenizer choice below — keeping identifiers intact —
// is what makes "light wins on rare identifiers" actually work. The same
// mechanism also cheerfully matches a stray `cpu` token in an off-topic doc, which
// is the symmetric half of the lesson (retrieved context can be wrong while the
// metric looks fine).
//
// Deterministic, synchronous, no DOM/React. Each call ranks over the passed
// corpus from scratch (the SRE corpus is ~43 docs, so per-call stats are instant).

import type { Doc } from '@/types';

/** One retrieval result: which doc, and how strongly it scored (raw BM25). */
export interface RankHit {
  id: string;
  score: number;
}

// A small English stopword set, mirrored verbatim from embed_light.py.
//
// WHY filter stopwords in a lexical retriever: conversational query words ("why",
// "my", "is") are often RARE in a technical corpus, so BM25's IDF would weight
// them heavily and let an irrelevant doc that merely contains "my" outrank the
// on-topic one. Stripping them focuses lexical matching on content terms (e.g.
// the token "cpu"), which keeps the §3.3 collision a clean teaching example
// instead of an artifact of stopword noise.
const STOPWORDS: ReadonlySet<string> = new Set(
  `
  a an and are as at be but by for from has have how i in is it its my of on
  or that the their them then there these this to was what when where which
  who why will with you your do does did me we he she they
  `
    .split(/\s+/)
    .filter(Boolean),
);

// \b[\w-]+\b-style class that keeps hyphenated/numeric identifiers as one token.
// First char excludes `-` so a leading dash is skipped; subsequent chars allow
// `-` so `shard-7` stays whole. After lower-casing, `E1342` → `e1342`, `p99`,
// `5xx`, `shard-7` all survive as single tokens — the exact-match signal BM25
// exists to capture. Reused across calls: String.prototype.match with the global
// flag resets lastIndex internally, so the shared regex is stateless here.
const TOKEN_RE = /[A-Za-z0-9_][A-Za-z0-9_-]*/g;

/**
 * Lowercase word/identifier tokenizer tuned to keep error codes intact.
 *
 * Exported so tools/tests can tokenize queries with the exact same rules used to
 * build the index — any divergence would silently break exact-match retrieval.
 */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(TOKEN_RE);
  if (!raw) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (!STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

// BM25 hyperparameters (Okapi defaults; match embed_light.py / rank_bm25).
const K1 = 1.5; // term-frequency saturation: higher → tf matters more
const B = 0.75; // length normalization: 1 → full, 0 → none

// Light field boosting. The reference indexes a single text blob; our Doc has
// distinct fields, so a query term in the title is a stronger signal than one
// buried in the body. We weight by adding fractional term-frequency mass per
// field (title/summary count for a bit more than body). Kept gentle on purpose:
// a unique body identifier (e.g. `e1342`, weight 1.0) still carries the largest
// IDF and dominates ranking, so field boosting refines typical relevance without
// overturning the "rare identifier wins" lesson.
const FIELD_WEIGHTS: ReadonlyArray<readonly [keyof Pick<Doc, 'title' | 'summary' | 'body'>, number]> = [
  ['title', 2.0],
  ['summary', 1.5],
  ['body', 1.0],
];

interface DocStats {
  /** weighted term frequency: term → summed field weight across occurrences */
  tf: Map<string, number>;
  /** weighted document length (sum of all field weights) */
  len: number;
}

/** Build weighted term-frequency stats over title + summary + body. */
function statsFor(doc: Doc): DocStats {
  const tf = new Map<string, number>();
  let len = 0;
  for (const [field, weight] of FIELD_WEIGHTS) {
    for (const term of tokenize(doc[field])) {
      tf.set(term, (tf.get(term) ?? 0) + weight);
      len += weight;
    }
  }
  return { tf, len };
}

/**
 * IDF for a term, Lucene/Robertson form: log(1 + (N - n + 0.5) / (n + 0.5)).
 *
 * The `+1` inside the log guarantees a strictly positive IDF for every term,
 * unlike textbook Okapi (`log((N - n + 0.5)/(n + 0.5))`) which goes NEGATIVE for
 * terms in >half the corpus and needs an epsilon-floor hack (what rank_bm25
 * does). Guaranteeing non-negativity matters for our demo: query "service
 * pegging CPU" contains the common term "service"; a negative IDF would *penalize*
 * the on-topic runbook for matching it. This variant is the standard BM25 used by
 * Lucene/Elasticsearch and keeps the code free of special cases.
 */
function idf(n: number, N: number): number {
  return Math.log(1 + (N - n + 0.5) / (n + 0.5));
}

/**
 * Rank `docs` against `query` by BM25, highest score first; return the top `k`
 * (default 5) docs that actually matched at least one query term.
 *
 * Scores are raw BM25 — unbounded and corpus-relative — so only the order is
 * directly meaningful. Docs scoring 0 (no query term present) are dropped rather
 * than padding the result, so a search for a term absent from the corpus returns
 * nothing instead of arbitrary filler.
 */
export function rankDocs(docs: Doc[], query: string, k: number = 5): RankHit[] {
  const N = docs.length;
  if (N === 0) return [];

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  // One pass to build per-doc stats, average length, and document frequencies.
  const stats: DocStats[] = new Array(N);
  const df = new Map<string, number>(); // term → number of docs containing it
  let totalLen = 0;
  for (let i = 0; i < N; i++) {
    const s = statsFor(docs[i]);
    stats[i] = s;
    totalLen += s.len;
    for (const term of s.tf.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const avgdl = totalLen / N; // N > 0 guaranteed above

  // Precompute IDF for the (deduped) query terms; terms absent from the corpus
  // get df 0 → positive IDF but contribute 0 since every doc's tf is 0.
  const idfByTerm = new Map<string, number>();
  for (const term of queryTerms) {
    if (!idfByTerm.has(term)) {
      idfByTerm.set(term, idf(df.get(term) ?? 0, N));
    }
  }

  // Score each doc: Σ_q idf(q) · tf·(k1+1) / (tf + k1·(1 - b + b·len/avgdl)).
  const hits: RankHit[] = [];
  for (let i = 0; i < N; i++) {
    const { tf, len } = stats[i];
    const norm = K1 * (1 - B + (B * len) / avgdl);
    let score = 0;
    for (const [term, termIdf] of idfByTerm) {
      const f = tf.get(term);
      if (f === undefined) continue;
      score += termIdf * ((f * (K1 + 1)) / (f + norm));
    }
    if (score > 0) hits.push({ id: docs[i].id, score });
  }

  // Sort by score desc; tie-break by id ascending for a fully deterministic order
  // independent of input array order.
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return hits.slice(0, Math.max(0, k));
}
