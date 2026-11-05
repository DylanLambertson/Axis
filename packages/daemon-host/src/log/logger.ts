// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { types } from "node:util";
import { AxisError, type Redactor } from "@axis/audit";
import type { LogLevel } from "../config.js";
import type { Clock } from "../ports/clock.js";
import { summarizeError } from "./summarize-error.js";

/**
 * Structured, bounded, redacted logging (design section 9.2). A record is `{ ts, level, event, ...fields }` with a
 * closed set of events and a closed set of field names; anything else is dropped, never serialised. Every string
 * that reaches the sink has been through the process `Redactor`, as the second layer behind the closed field set.
 * A failing sink never throws into the caller, and memory is bounded by a fixed-size queue.
 */

/** The events the host can log. Later tickets add theirs here, in the same change as the code that logs them. */
export const LOG_EVENTS = [
  "host.starting",
  "anchor.stalled",
  "anchor.resumed",
  "host.ready",
  "host.degraded",
  "host.start_failed",
  "host.shutdown",
  "host.crash",
  "init.duplicate",
  "init.invalid",
  "control.invalid",
  "connection.rejected",
  "request.failed",
  "dispose.failed",
  "log.dropped",
  "log.invalid",
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

/** Field names a record may carry. Ids, not paths, payloads or contents. */
export const LOG_FIELDS = [
  "correlationId",
  "code",
  "reason",
  "workspaceId",
  "projectId",
  "runId",
  "windowId",
  "connectionId",
  "contract",
  "method",
  "count",
  "durationMs",
] as const;
export type LogField = (typeof LOG_FIELDS)[number];

/** Field values are scalars. `error` is summarised (name, code, errno), never serialised. */
export type LogFields = { readonly [K in LogField]?: string | number | boolean } & { readonly error?: unknown };

/**
 * Where records go. `write` may return `false` for backpressure: the logger then holds records (bounded) until
 * `drain()` is called. A throw drops that record and is counted.
 */
export interface LogSink {
  write(line: string): boolean | void;
}

export interface LoggerOptions {
  readonly redactor: Redactor;
  readonly clock: Clock;
  readonly sink: LogSink;
  readonly level?: LogLevel;
  /** Records held while the sink is blocked (default 256). */
  readonly queueSize?: number;
}

export interface Logger {
  log(level: LogLevel, event: LogEvent, fields?: LogFields): void;
  debug(event: LogEvent, fields?: LogFields): void;
  info(event: LogEvent, fields?: LogFields): void;
  warn(event: LogEvent, fields?: LogFields): void;
  error(event: LogEvent, fields?: LogFields): void;
  /** Resume writing after the sink reported backpressure. */
  drain(): void;
  /** Counters, for tests and the shutdown report. */
  readonly stats: () => { readonly queued: number; readonly dropped: number; readonly sinkErrors: number };
}

const RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };
const EVENTS: ReadonlySet<string> = new Set(LOG_EVENTS);
const FIELDS: ReadonlySet<string> = new Set(LOG_FIELDS);
const DEFAULT_QUEUE = 256;
const MAX_FIELD_CHARS = 256;
/** A string longer than this is not scanned at all: it becomes a fixed marker, never a prefix that could cut a secret. */
const MAX_SCAN_CHARS = 4096;
const MAX_KEYS_COUNTED = 1024;
const MAX_QUEUE = 100_000;
const MAX_LINE_CHARS = 2048;

interface Queued {
  readonly rank: number;
  readonly line: string;
}

export function createLogger(options: LoggerOptions): Logger {
  const { redactor, clock, sink } = options;
  const threshold = RANK[options.level ?? "info"];
  const capacity = options.queueSize ?? DEFAULT_QUEUE;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_QUEUE) {
    throw new AxisError("E_INVALID_ARGUMENT", "Invalid logger queueSize");
  }
  const queue: Queued[] = [];
  let blocked = false;
  let draining = false;
  let dropped = 0;
  let announcedDropped = 0;
  let sinkErrors = 0;

  const timestamp = (): string => {
    try {
      const d = new Date(clock.now());
      return Number.isNaN(d.getTime()) ? "1970-01-01T00:00:00.000Z" : d.toISOString();
    } catch {
      return "1970-01-01T00:00:00.000Z";
    }
  };

  /** Redact first, then cut, so a secret straddling the cut cannot survive as a prefix. */
  function boundField(v: string): string {
    if (v.length > MAX_SCAN_CHARS) return "[truncated]";
    const clean = redactor.redactString(v);
    if (clean.length <= MAX_FIELD_CHARS) return clean;
    let end = MAX_FIELD_CHARS;
    const last = clean.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--; // never split a surrogate pair
    return `${clean.slice(0, end)}[cut]`;
  }

  /** The safe scalar fields of `input`: closed names only, values bounded then redacted, nothing else read. */
  function collect(input: unknown): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    // A Proxy would run attacker code on every read. The record then carries a marker and nothing else.
    if (typeof input !== "object" || input === null || types.isProxy(input)) return input === undefined ? out : { reason: "fields_unreadable" };
    let skipped = 0;
    for (const name of [...LOG_FIELDS, "error"] as const) {
      const d = Object.getOwnPropertyDescriptor(input, name);
      if (d === undefined) continue;
      if (!("value" in d)) {
        skipped++; // an accessor is never invoked
        continue;
      }
      const v: unknown = d.value;
      if (name === "error") {
        const s = summarizeError(v);
        out["errorName"] = s.name;
        if (s.code !== undefined) out["errorCode"] = s.code;
        if (s.errno !== undefined) out["errno"] = s.errno;
      } else if (typeof v === "string") {
        out[name] = boundField(v);
      } else if (typeof v === "number") {
        out[name] = Number.isFinite(v) ? v : 0;
      } else if (typeof v === "boolean") {
        out[name] = v;
      } else {
        skipped++; // objects, functions, symbols, bigint: not loggable
      }
    }
    // Names outside the closed set are counted, not copied (their keys are client text too).
    let extra = 0;
    let visited = 0;
    for (const key in input) {
      if (++visited > MAX_KEYS_COUNTED) break; // bounded: a huge object costs a bounded walk
      if (Object.hasOwn(input, key) && !FIELDS.has(key) && key !== "error") extra++;
    }
    if (skipped + extra > 0) out["fieldsDropped"] = skipped + extra;
    return out;
  }

  function serialise(level: LogLevel, event: string, fields: Record<string, string | number | boolean>): string {
    const record = { ts: timestamp(), level, event, ...fields };
    let line = JSON.stringify(record);
    if (line.length > MAX_LINE_CHARS) line = JSON.stringify({ ts: record.ts, level, event, truncated: true });
    return line;
  }

  function enqueue(rank: number, line: string): void {
    if (queue.length >= capacity) {
      // Drop the oldest record of the lowest level held (the queue is in arrival order).
      let victim = 0;
      for (let i = 1; i < queue.length; i++) if ((queue[i] as Queued).rank < (queue[victim] as Queued).rank) victim = i;
      queue.splice(victim, 1);
      dropped++;
    }
    queue.push({ rank, line });
  }

  function flush(): void {
    if (draining) return; // a sink that logs from inside `write` is served by the loop below
    draining = true;
    try {
      while (!blocked && queue.length > 0) {
        if (dropped > announcedDropped) {
          const count = dropped - announcedDropped;
          announcedDropped = dropped;
          queue.unshift({ rank: RANK.warn, line: serialise("warn", "log.dropped", { count }) });
        }
        const next = queue.shift() as Queued;
        try {
          if (sink.write(next.line) === false) blocked = true;
        } catch {
          sinkErrors++;
        }
      }
    } finally {
      draining = false;
    }
  }

  function log(level: LogLevel, event: LogEvent, fields?: LogFields): void {
    try {
      const rank = RANK[level];
      if (rank === undefined || rank < threshold) return;
      if (!EVENTS.has(event)) {
        enqueue(rank, serialise(level, "log.invalid", {}));
      } else {
        enqueue(rank, serialise(level, event, collect(fields)));
      }
      flush();
    } catch {
      sinkErrors++; // logging must never throw into a request
    }
  }

  return {
    log,
    debug: (e, f) => log("debug", e, f),
    info: (e, f) => log("info", e, f),
    warn: (e, f) => log("warn", e, f),
    error: (e, f) => log("error", e, f),
    drain: () => {
      blocked = false;
      flush();
    },
    stats: () => ({ queued: queue.length, dropped, sinkErrors }),
  };
}
