import { describe, expect, it } from 'vitest';
import { ArrayEventSink, EventSink, FanoutEventSink, FilteredEventSink } from '../../src/core/EventSink.js';

describe('EventSink', () => {
  it('increments sequence numbers monotonically', () => {
    const sink = new EventSink();

    expect(sink.next()).toBe(1);
    expect(sink.next()).toBe(2);
    expect(sink.next()).toBe(3);
  });

  it('stores emitted events in ArrayEventSink', () => {
    const sink = new ArrayEventSink();
    sink.emit({ seq: sink.next(), type: 'alpha', payload: {} });
    sink.emit({ seq: sink.next(), type: 'beta', payload: {} });

    expect(sink.events.map(event => event.seq)).toEqual([1, 2]);
    expect(sink.events.map(event => event.type)).toEqual(['alpha', 'beta']);
  });

  it('fans out one sequenced stream to multiple sinks', () => {
    const left = new ArrayEventSink();
    const right = new ArrayEventSink();
    const sink = new FanoutEventSink([left, right]);

    sink.emit({ seq: sink.next(), type: 'alpha', payload: {} });
    sink.emit({ seq: sink.next(), type: 'beta', payload: {} });

    expect(left.events.map(event => event.seq)).toEqual([1, 2]);
    expect(right.events.map(event => event.seq)).toEqual([1, 2]);
    expect(left.events.map(event => event.type)).toEqual(['alpha', 'beta']);
    expect(right.events.map(event => event.type)).toEqual(['alpha', 'beta']);
  });

  it('filters events before writing to a child sink', () => {
    const child = new ArrayEventSink();
    const sink = new FilteredEventSink(child, event => event.stepId === 'keep');

    sink.emit({ seq: 1, stepId: 'keep', type: 'alpha', payload: {} });
    sink.emit({ seq: 2, stepId: 'skip', type: 'beta', payload: {} });

    expect(child.events.map(event => event.seq)).toEqual([1]);
    expect(child.events.map(event => event.type)).toEqual(['alpha']);
  });
});
