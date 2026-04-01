import { appendFileSync, closeSync, openSync } from 'fs';

export class EventSink {
  constructor() {
    this._seq = 0;
  }

  next() {
    this._seq += 1;
    return this._seq;
  }

  emit(_event) {}

  close() {}
}

export class ArrayEventSink extends EventSink {
  constructor() {
    super();
    this.events = [];
  }

  emit(event) {
    this.events.push(event);
  }
}

export class NdjsonEventSink extends EventSink {
  constructor(filePath) {
    super();
    this._filePath = filePath;
    this._fd = openSync(filePath, 'w');
  }

  emit(event) {
    appendFileSync(this._fd, `${JSON.stringify(event)}\n`);
  }

  close() {
    if (this._fd === null) return;
    closeSync(this._fd);
    this._fd = null;
  }
}

export class FanoutEventSink extends EventSink {
  constructor(sinks = []) {
    super();
    this._sinks = sinks.filter(Boolean);
  }

  emit(event) {
    for (const sink of this._sinks) {
      sink.emit?.(event);
    }
  }

  close() {
    for (const sink of this._sinks) {
      sink.close?.();
    }
  }
}

export class FilteredEventSink {
  constructor(sink, predicate) {
    this._sink = sink;
    this._predicate = predicate;
  }

  emit(event) {
    if (this._predicate?.(event)) {
      this._sink?.emit?.(event);
    }
  }

  close() {
    this._sink?.close?.();
  }
}
