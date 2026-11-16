import { describe, expect, it } from 'bun:test';
import { InvalidDomainStateError } from '../domain/errors.js';
import { initialReferenceRetry, nextReferenceRetry } from './reference-retry.js';

const now = new Date('2026-11-16T20:00:00.000Z');

describe('persisted PENDING_REFERENCE retry policy', () => {
  it('begins after five seconds and expires after 24 hours', () => {
    const initial = initialReferenceRetry(now);
    expect(initial.attempts).toBe(0);
    expect(initial.nextAttemptAt.getTime() - now.getTime()).toBe(5_000);
    expect(initial.expiresAt.getTime() - now.getTime()).toBe(24 * 60 * 60_000);
  });

  it('uses exponential backoff capped at fifteen minutes', () => {
    let state = initialReferenceRetry(now);
    for (let i = 1; i <= 12; i++) {
      const at = state.nextAttemptAt;
      const decision = nextReferenceRetry(state, at);
      expect(decision.expired).toBe(false);
      expect(decision.state.attempts).toBe(i);
      expect(decision.state.nextAttemptAt.getTime() - at.getTime()).toBeLessThanOrEqual(
        15 * 60_000,
      );
      state = decision.state;
    }
  });

  it('does not retry before due and prevents invalid counters', () => {
    const state = initialReferenceRetry(now);
    expect(() => nextReferenceRetry(state, now)).toThrow(InvalidDomainStateError);
    expect(() => nextReferenceRetry({ ...state, attempts: -1 }, state.nextAttemptAt)).toThrow(
      InvalidDomainStateError,
    );
  });

  it('terminates at TTL and never schedules beyond expiry', () => {
    const initial = initialReferenceRetry(now);
    const nearExpiry = { ...initial, nextAttemptAt: new Date(initial.expiresAt.getTime() - 100) };
    const decision = nextReferenceRetry(nearExpiry, nearExpiry.nextAttemptAt);
    expect(decision.state.nextAttemptAt.getTime()).toBe(initial.expiresAt.getTime());
    expect(nextReferenceRetry(decision.state, initial.expiresAt).expired).toBe(true);
  });

  it('rejects invalid dates', () => {
    expect(() => initialReferenceRetry(new Date('invalid'))).toThrow(InvalidDomainStateError);
    const state = initialReferenceRetry(now);
    expect(() => nextReferenceRetry(state, new Date('invalid'))).toThrow(InvalidDomainStateError);
  });
});
