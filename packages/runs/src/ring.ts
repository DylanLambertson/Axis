// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

export const MAX_RING_CHARS = 1_048_576;
const COALESCE_BELOW = 1024;

/**
 * Bounded recent output. Memory never exceeds `capacity` characters (plus one small chunk) and the cost of an
 * append is bounded by `capacity` whatever the size or rate of the input: a chunk larger than the buffer is cut to
 * its tail first, small chunks are merged so the chunk count stays near `capacity / 1024`, and nothing here runs a
 * regular expression.
 */
/** A fresh, unshared copy of `s` (lone surrogates survive: the round trip is raw UTF-16). */
function flat(s: string): string {
  return Buffer.from(s, "utf16le").toString("utf16le");
}

export class RingBuffer {
  readonly capacity: number;
  #chunks: string[] = [];
  #head = 0;
  #length = 0;
  #total = 0;
  #dropped = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_RING_CHARS) throw new RangeError("ring capacity out of range");
    this.capacity = capacity;
  }

  /** Characters ever appended (saturating) and characters no longer held. */
  get totalChars(): number {
    return this.#total;
  }
  get droppedChars(): number {
    return this.#dropped;
  }
  get length(): number {
    return this.#length;
  }

  append(chunk: string): void {
    if (typeof chunk !== "string" || chunk.length === 0) return;
    this.#total = Math.min(Number.MAX_SAFE_INTEGER, this.#total + chunk.length);
    if (chunk.length >= this.capacity) {
      this.#dropped = Math.min(Number.MAX_SAFE_INTEGER, this.#dropped + this.#length + chunk.length - this.capacity);
      // Copy the kept tail: a slice would keep the whole (possibly huge) original string alive.
      this.#chunks = [flat(chunk.slice(chunk.length - this.capacity))];
      this.#head = 0;
      this.#length = this.capacity;
      return;
    }
    const last = this.#chunks.length - 1;
    if (last >= this.#head && (this.#chunks[last] as string).length < COALESCE_BELOW) {
      this.#chunks[last] += chunk;
    } else {
      this.#chunks.push(chunk);
    }
    this.#length += chunk.length;
    while (this.#length > this.capacity) {
      const first = this.#chunks[this.#head] as string;
      const excess = this.#length - this.capacity;
      if (first.length <= excess) {
        this.#head++;
        this.#length -= first.length;
        this.#dropped += first.length;
      } else {
        this.#chunks[this.#head] = first.slice(excess);
        this.#length -= excess;
        this.#dropped += excess;
      }
    }
    if (this.#head > 64 && this.#head * 2 > this.#chunks.length) {
      this.#chunks = this.#chunks.slice(this.#head);
      this.#head = 0;
    }
  }

  /** The last `max` characters held. */
  tail(max: number): string {
    const n = Math.max(0, Math.min(Math.trunc(max), this.#length));
    if (n === 0) return "";
    const all = this.#chunks.slice(this.#head).join("");
    return all.slice(all.length - n);
  }
}
