'use client';

// PanelBody — renders a panel's plain-text body with light, MEANINGFUL syntax
// highlighting so the dense teaching panels read like a console, not a wall of grey.
//
// The highlighting is purely PRESENTATIONAL and derived from the text itself — it
// never adds, hides, or changes any content. It only tints tokens that already
// carry meaning in these scenarios:
//   • PII shapes (emails, IPs, phones, secret tokens)        → red   (a leak)
//   • [REDACTED_*] placeholders                              → green (scrubbed)
//   • PASS / ✓ / APPROVED / "caught" / yes                   → green
//   • FAIL / ✗ / REJECTED / ESCAPED / HIJACKED = true        → red
//   • a rubric score "n/5"                                   → amber, bold
//   • honesty source chips [LLM] / [Code]                     → teal / grey chips
//   • ⚠ guardrail / distractor markers                        → amber
//   • inline `code` and bracketed [doc_id] citations         → cyan
//
// Implementation: a single-pass tokenizer over each line builds an array of
// {text, cls} segments via a combined regex, so segments never overlap and the
// original characters are always preserved (we only wrap them in <span>s).

import { Fragment } from 'react';

// One highlight rule: a global regex + the Tailwind classes to wrap its match in.
// Order matters — earlier rules win a given character span (the combined matcher
// tries them in order at each position). Keep high-precision shapes (secrets,
// emails) before looser ones (bare numbers) so a token is classified once, well.
interface Rule {
  name: string;
  re: RegExp;
  cls: string;
}

const RULES: Rule[] = [
  // honesty tags — the whole bracketed source tag becomes a chip.
  { name: 'tag-model', re: /\[LLM\]/g, cls: 'rounded bg-decide/15 px-1 text-decide font-semibold' },
  { name: 'tag-det', re: /\[Code\]/g, cls: 'rounded bg-ink-faint/15 px-1 text-ink-dim font-semibold' },
  // redaction placeholders — the safe, scrubbed outcome.
  { name: 'redacted', re: /\[REDACTED_[A-Z]+\]/g, cls: 'rounded bg-decide/15 px-1 text-decide' },
  // secrets (api_key=…, sk-…, bearer …, ghp_…, AKIA…) — high precision, run first.
  {
    name: 'secret',
    re: /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S+|\bsk-[A-Za-z0-9]{6,}|\bghp_[A-Za-z0-9]{10,}|\bAKIA[0-9A-Z]{8,}|\bbearer\s+[\w.\-]+/gi,
    cls: 'rounded bg-danger/15 px-1 text-danger',
  },
  // emails.
  { name: 'email', re: /[\w.+-]+@[\w-]+\.[\w.-]+/g, cls: 'rounded bg-danger/15 px-1 text-danger' },
  // phone numbers with explicit separators (e.g. +1-202-555-0143).
  { name: 'phone', re: /\+?\d{1,2}[-.\s]\d{3}[-.\s]\d{3}[-.\s]\d{4}/g, cls: 'rounded bg-danger/15 px-1 text-danger' },
  // IPv4 dotted quads.
  { name: 'ip', re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, cls: 'rounded bg-danger/15 px-1 text-danger' },
  // rubric score n/5 — the model's verdict number.
  { name: 'score', re: /\b[0-5]\s*\/\s*5\b/g, cls: 'font-bold text-think' },
  // positive verdict words / marks.
  {
    name: 'pass',
    re: /✓|\bPASS\b|\bPASSES\b|\bAPPROVED\b|\bOK\b|\bcaught\b|\bclean\b|blast radius zero/g,
    cls: 'font-semibold text-decide',
  },
  // negative verdict words / marks.
  {
    name: 'fail',
    re: /✗|\bFAIL\b|\bFAILS\b|\bFAILED\b|\bREJECTED\b|\bESCAPED\b|\bREFUSED\b|\bABORTED\b|\bLEAK\b|\bMISSING\b|\bHIJACKED\b/g,
    cls: 'font-semibold text-danger',
  },
  // caution markers (distractors, guardrail arrows, warnings).
  { name: 'warn', re: /⚠[^\n]*?(?=$|\s{2,}|·|\n)|★/g, cls: 'text-think' },
  // bracketed doc-id citations like [cpu_saturation_runbook].
  { name: 'cite', re: /\[[a-z][a-z0-9_]+\]/g, cls: 'rounded bg-ctx/10 px-0.5 text-ctx' },
  // inline `code`.
  { name: 'code', re: /`[^`]+`/g, cls: 'rounded bg-ctx/10 px-1 text-ctx' },
];

interface Seg {
  text: string;
  cls?: string;
}

/**
 * Tokenize one line into highlighted/plain segments. We collect every rule match,
 * then sweep left→right choosing the earliest match (ties: rule order), emitting
 * plain text in the gaps. Overlapping matches are resolved by skipping any match
 * that starts before the cursor, so each character is classified at most once.
 */
function segmentLine(line: string): Seg[] {
  interface M { start: number; end: number; cls: string; order: number }
  const matches: M[] = [];
  RULES.forEach((rule, order) => {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(line)) !== null) {
      if (m[0].length === 0) {
        rule.re.lastIndex += 1; // guard against zero-width matches
        continue;
      }
      matches.push({ start: m.index, end: m.index + m[0].length, cls: rule.cls, order });
    }
  });
  // earliest start first; on a tie prefer the rule declared earlier (higher precision)
  matches.sort((a, b) => a.start - b.start || a.order - b.order || b.end - a.end);

  const segs: Seg[] = [];
  let cursor = 0;
  for (const mt of matches) {
    if (mt.start < cursor) continue; // overlaps an already-emitted segment
    if (mt.start > cursor) segs.push({ text: line.slice(cursor, mt.start) });
    segs.push({ text: line.slice(mt.start, mt.end), cls: mt.cls });
    cursor = mt.end;
  }
  if (cursor < line.length) segs.push({ text: line.slice(cursor) });
  return segs;
}

export default function PanelBody({ body }: { body: string }) {
  const lines = body.split('\n');
  return (
    <div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink-base">
      {lines.map((line, i) => (
        <Fragment key={i}>
          {segmentLine(line).map((seg, j) =>
            seg.cls ? (
              <span key={j} className={seg.cls}>
                {seg.text}
              </span>
            ) : (
              <Fragment key={j}>{seg.text}</Fragment>
            ),
          )}
          {i < lines.length - 1 ? '\n' : null}
        </Fragment>
      ))}
    </div>
  );
}

// Exported for unit tests — verifies highlighting never drops/alters characters.
export { segmentLine };
