// Process-wide event bus with a ring buffer so late SSE subscribers can replay recent events.
import { EventEmitter } from 'node:events';
import { redactDeep } from './paths.mjs';

class Bus extends EventEmitter {
  #seq = 0;
  #ring = [];
  #max = 2000;
  #bytes = 0;
  #maxBytes = 8 * 1024 * 1024;

  constructor({ max = 2000, maxBytes = 8 * 1024 * 1024 } = {}) {
    super();
    this.#max = max;
    this.#maxBytes = maxBytes;
  }

  /** Emit an event to live listeners and keep it for replay. Secrets are redacted: this is the UI's live stream. */
  publish(type, data = {}) {
    const ev = { seq: ++this.#seq, ts: Date.now(), type, ...redactDeep(data) };
    const bytes = Buffer.byteLength(JSON.stringify(ev), 'utf8');
    ev.__bytes = bytes;
    this.#ring.push(ev);
    this.#bytes += bytes;
    while (this.#ring.length > this.#max || (this.#ring.length > 1 && this.#bytes > this.#maxBytes)) {
      const dropped = this.#ring.shift();
      if (dropped) this.#bytes -= dropped.__bytes ?? 0;
    }
    this.emit('event', ev);
    return ev;
  }

  /** Latest sequence number handed out (0 before any event). */
  get seq() { return this.#seq; }

  /** Oldest sequence available for replay (the next sequence when empty). */
  get oldest() { return this.#ring[0]?.seq ?? this.#seq + 1; }

  get bytes() { return this.#bytes; }

  since(seq = 0) {
    return this.#ring.filter((e) => e.seq > seq);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
