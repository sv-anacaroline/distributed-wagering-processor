import { assertValidDate, InvalidDomainStateError } from '../domain/errors.js';

/** For PENDING_REFERENCE only, never for financial ledger versions. */
export interface ReferenceRetryState {
  readonly attempts: number;
  readonly expiresAt: Date;
  readonly nextAttemptAt: Date;
}

export interface ReferenceRetryDecision {
  readonly expired: boolean;
  readonly state: ReferenceRetryState;
}

const FIVE_SECONDS = 5_000;
const FIFTEEN_MINUTES = 15 * 60_000;
const ONE_DAY = 24 * 60 * 60_000;

export function initialReferenceRetry(now: Date): ReferenceRetryState {
  assertValidDate(now, 'reference.receivedAt');
  return {
    attempts: 0,
    nextAttemptAt: new Date(now.getTime() + FIVE_SECONDS),
    expiresAt: new Date(now.getTime() + ONE_DAY),
  };
}

/** No timers or in-memory queue: persist every decision in PostgreSQL. */
export function nextReferenceRetry(state: ReferenceRetryState, now: Date): ReferenceRetryDecision {
  assertValidDate(now, 'reference.retryAt');
  assertValidDate(state.expiresAt, 'reference.expiresAt');
  assertValidDate(state.nextAttemptAt, 'reference.nextAttemptAt');
  if (!Number.isSafeInteger(state.attempts) || state.attempts < 0) {
    throw new InvalidDomainStateError('Retry attempts must be a nonnegative safe integer');
  }
  if (now.getTime() < state.nextAttemptAt.getTime()) {
    throw new InvalidDomainStateError('Cannot retry a reference before it is due');
  }
  if (now.getTime() >= state.expiresAt.getTime()) {
    return { expired: true, state };
  }

  const attempts = state.attempts + 1;
  const delay = Math.min(FIVE_SECONDS * 2 ** Math.min(attempts, 8), FIFTEEN_MINUTES);
  return {
    expired: false,
    state: {
      attempts,
      expiresAt: new Date(state.expiresAt),
      nextAttemptAt: new Date(Math.min(now.getTime() + delay, state.expiresAt.getTime())),
    },
  };
}
