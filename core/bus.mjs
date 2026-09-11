// Process-wide event bus with a ring buffer so late SSE subscribers can replay recent events.
import { EventEmitter } from 'node:events';

class Bus extends EventEmitter {
  #seq = 0;
  #ring = [];
  #max = 2000;

  /** Emit an event to live listeners and keep it for replay. */
  publish(type, data = {}) {
    const ev = { seq: ++this.#seq, ts: Date.now(), type, ...data };
    this.#ring.push(ev);
    if (this.#ring.length > this.#max) this.#ring.shift();
    this.emit('event', ev);
    return ev;
  }

  /** Latest sequence number handed out (0 before any event). */
  get seq() { return this.#seq; }

  since(seq = 0) {
    return this.#ring.filter((e) => e.seq > seq);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
