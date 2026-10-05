// Process-wide event bus with a ring buffer so late SSE subscribers can replay recent events.
import { EventEmitter } from 'node:events';
import { redactDeep } from './paths.ts';

/** Replayable event. Payload fields are spread onto the event next to `seq`, `type` and `ts`. */
export interface BusEvent {
  seq: number;
  type: string;
  ts: number;
  [field: string]: unknown;
}

export interface BusOptions {
  max?: number;
  maxBytes?: number;
}

class Bus extends EventEmitter {
  #seq = 0;
  #ring: BusEvent[] = [];
  #max = 2000;
  #bytes = 0;
  #maxBytes = 8 * 1024 * 1024;
  #sizes = new WeakMap<BusEvent, number>();

  constructor({ max = 2000, maxBytes = 8 * 1024 * 1024 }: BusOptions = {}) {
    super();
    this.#max = max;
    this.#maxBytes = maxBytes;
  }

  /** Emit an event to live listeners and keep it for replay. Secrets are redacted: this is the UI's live stream. */
  publish(type: string, data: Record<string, unknown> = {}): BusEvent {
    const ev: BusEvent = { seq: ++this.#seq, ts: Date.now(), type, ...redactDeep(data) };
    const bytes = Buffer.byteLength(JSON.stringify(ev), 'utf8');
    this.#sizes.set(ev, bytes);
    this.#ring.push(ev);
    this.#bytes += bytes;
    while (this.#ring.length > this.#max || (this.#ring.length > 1 && this.#bytes > this.#maxBytes)) {
      const dropped = this.#ring.shift();
      if (dropped) this.#bytes -= this.#sizes.get(dropped) ?? 0;
    }
    this.emit('event', ev);
    return ev;
  }

  /** Latest sequence number handed out (0 before any event). */
  get seq(): number { return this.#seq; }

  /** Oldest sequence available for replay (the next sequence when empty). */
  get oldest(): number { return this.#ring[0]?.seq ?? this.#seq + 1; }

  get bytes(): number { return this.#bytes; }

  since(seq = 0): BusEvent[] {
    return this.#ring.filter((e) => e.seq > seq);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
