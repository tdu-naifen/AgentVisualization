// cancel.ts — the sentinel thrown when an in-flight generation is interrupted by a
// user pause or a scenario switch. Carried up the await chain so the scenario/UI can
// DROP the partial step (never commit it half-done) without showing a red error.
// Dependency-free so both lib/llm.ts and the UI can import it.

export class CancelledError extends Error {
  constructor(message = 'generation cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

/** Type guard: was this thrown value a cancellation (vs a real error)? */
export function isCancelled(e: unknown): e is CancelledError {
  return e instanceof CancelledError || (e instanceof Error && e.name === 'CancelledError');
}
