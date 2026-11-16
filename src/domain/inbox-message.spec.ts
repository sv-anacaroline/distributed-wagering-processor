import { describe, expect, it } from 'bun:test';
import { AlreadyProcessedError, InvalidDomainStateError } from './errors.js';
import { InboxMessage, type ReceiveInboxProps } from './inbox-message.js';

const props = (): ReceiveInboxProps => ({
  messageId: 'msg-1',
  consumerName: 'wager-consumer',
  payloadHash: 'hash-1',
  receivedAt: new Date('2026-01-01T00:00:00.000Z'),
});

describe('InboxMessage', () => {
  it('receives a message as unprocessed and records its deduplication identity', () => {
    const inbox = InboxMessage.receive(props());
    expect(inbox.messageId).toBe('msg-1');
    expect(inbox.consumerName).toBe('wager-consumer');
    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.processedAt).toBeUndefined();
    expect(inbox.matchesPayload('hash-1')).toBe(true);
    expect(inbox.matchesPayload('hash-different')).toBe(false);
  });

  it('marks processing only once and refuses timestamps before reception', () => {
    const inbox = InboxMessage.receive(props());
    expect(() => inbox.markProcessed(new Date('2025-01-01T00:00:00.000Z'))).toThrow(
      InvalidDomainStateError,
    );
    inbox.markProcessed(new Date('2026-01-02T00:00:00.000Z'));
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(() => inbox.markProcessed(new Date('2026-01-03T00:00:00.000Z'))).toThrow(
      AlreadyProcessedError,
    );
  });

  it('validates consumer/message/hash and valid receive timestamps', () => {
    expect(() => InboxMessage.receive({ ...props(), messageId: '' })).toThrow(
      InvalidDomainStateError,
    );
    expect(() => InboxMessage.receive({ ...props(), consumerName: ' ' })).toThrow(
      InvalidDomainStateError,
    );
    expect(() => InboxMessage.receive({ ...props(), payloadHash: '' })).toThrow(
      InvalidDomainStateError,
    );
    expect(() => InboxMessage.receive({ ...props(), receivedAt: new Date('invalid') })).toThrow(
      InvalidDomainStateError,
    );
  });

  it('defensively copies timestamps in both directions', () => {
    const receivedAt = new Date('2026-01-01T00:00:00.000Z');
    const inbox = InboxMessage.receive({ ...props(), receivedAt });
    receivedAt.setUTCFullYear(2040);
    const copy = inbox.receivedAt;
    copy.setUTCFullYear(2050);
    expect(inbox.receivedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    inbox.markProcessed(new Date('2026-01-02T00:00:00.000Z'));
    inbox.processedAt?.setUTCFullYear(2050);
    expect(inbox.processedAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('rehydrates persisted processing state without replaying it', () => {
    const inbox = InboxMessage.rehydrate({
      ...props(),
      processedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });
});
