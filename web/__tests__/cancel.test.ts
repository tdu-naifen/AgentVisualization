import { describe, it, expect } from 'vitest';
import { CancelledError, isCancelled } from '@/lib/cancel';

describe('CancelledError', () => {
  it('is identifiable via isCancelled across rethrows', () => {
    const e = new CancelledError('user paused');
    expect(isCancelled(e)).toBe(true);
    expect(e.name).toBe('CancelledError');
    expect(e.message).toBe('user paused');
  });

  it('isCancelled rejects ordinary errors', () => {
    expect(isCancelled(new Error('boom'))).toBe(false);
    expect(isCancelled('nope')).toBe(false);
    expect(isCancelled(null)).toBe(false);
  });
});
