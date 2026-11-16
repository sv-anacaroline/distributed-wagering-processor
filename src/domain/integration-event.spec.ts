import { describe, expect, it } from 'bun:test';
import { InvalidDomainStateError } from './errors.js';
import { IntegrationEvent, type IntegrationEventProps } from './integration-event.js';

interface TestData {
  readonly nested: { readonly value: string };
  readonly items: readonly string[];
}
class TestEvent extends IntegrationEvent<TestData> {
  readonly eventType = 'TestEvent';
  readonly version = 1;
  static from(props: IntegrationEventProps<TestData>): TestEvent {
    return new TestEvent(props);
  }
}
const props = (): IntegrationEventProps<TestData> => ({
  eventId: 'event-1',
  aggregateId: 'wallet-1',
  correlationId: 'request-1',
  causationId: 'txn-1',
  occurredAt: new Date('2026-01-01T00:00:00.000Z'),
  data: { nested: { value: 'original' }, items: ['a'] },
});

describe('IntegrationEvent', () => {
  it('serializes stable versioned envelopes with UTC dates and identifiers', () => {
    const event = TestEvent.from(props());
    expect(event.eventType).toBe('TestEvent');
    expect(event.version).toBe(1);
    expect(event.eventId).toBe('event-1');
    expect(event.aggregateId).toBe('wallet-1');
    expect(event.correlationId).toBe('request-1');
    expect(event.causationId).toBe('txn-1');
    expect(event.toJSON()).toEqual({
      eventId: 'event-1',
      eventType: 'TestEvent',
      aggregateId: 'wallet-1',
      correlationId: 'request-1',
      causationId: 'txn-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      data: { nested: { value: 'original' }, items: ['a'] },
    });
  });

  it('keeps payload and Date immutable from callers', () => {
    const input = props();
    const event = TestEvent.from(input);
    input.occurredAt.setUTCFullYear(2040);
    input.data.nested.value = 'mutated';
    expect(event.data.nested.value).toBe('original');
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.nested)).toBe(true);
    expect(event.occurredAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    event.occurredAt.setUTCFullYear(2040);
    const serialized = event.toJSON();
    serialized.data.nested.value = 'another';
    expect(event.toJSON().data.nested.value).toBe('original');
  });

  it('validates required fields and omits optional causationId', () => {
    expect(() => TestEvent.from({ ...props(), eventId: '' })).toThrow(InvalidDomainStateError);
    expect(() => TestEvent.from({ ...props(), aggregateId: '' })).toThrow(InvalidDomainStateError);
    expect(() => TestEvent.from({ ...props(), correlationId: '' })).toThrow(InvalidDomainStateError);
    expect(() => TestEvent.from({ ...props(), causationId: '' })).toThrow(InvalidDomainStateError);
    expect(() => TestEvent.from({ ...props(), occurredAt: new Date('invalid') })).toThrow(InvalidDomainStateError);
    expect(TestEvent.from({ ...props(), causationId: undefined }).toJSON().causationId).toBeUndefined();
  });
});
