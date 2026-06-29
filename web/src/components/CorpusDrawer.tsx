'use client';

import { useState } from 'react';
import type { Doc, ScenarioId } from '@/types';
import { TOOL_NAMES } from '@/types';

interface CorpusDrawerProps {
  docs: Doc[];
  scenarioId: ScenarioId;
}

export default function CorpusDrawer({ docs, scenarioId: _scenarioId }: CorpusDrawerProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-3 mb-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[12px] text-decide hover:underline"
      >
        {open ? '▾' : '▸'} Corpus &amp; tools ({docs.length} docs)
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          <div>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
              Docs
            </h3>
            <div className="max-h-80 overflow-y-auto space-y-2">
              {docs.map((doc) => (
                <div key={doc.id}>
                  <p className="font-semibold text-xs">{doc.title}</p>
                  <p className="text-[11px] text-ink-dim">{doc.summary}</p>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
              Tools
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {TOOL_NAMES.map((name) => (
                <span
                  key={name}
                  className="rounded-md border border-line bg-bg-card px-2 py-0.5 text-[11px] font-mono text-ink-dim"
                >
                  {name}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
