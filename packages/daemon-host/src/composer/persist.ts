// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Redactor } from "@axis/audit";
import type { ActivityRecord } from "@axis/journal";
import { runEventSchema, type RunEvent } from "@axis/protocol";

/**
 * Composer activity as journal rows (ticket J2). Only display-safe events are stored: every string of the event goes
 * through the host redactor first (model text can quote a secret a file held), and the result must still be a valid
 * `axis.runs/1` event, or nothing is stored. A stored row is checked again when it is read back: a row that is not a
 * valid event is left out, never forwarded. Provider bodies never reach here: events carry display text and closed labels.
 */

/** The row for an event, or undefined when the redacted event is no longer a valid one (it is then not stored). */
export function toActivityRecord(event: RunEvent, redactor: Redactor): ActivityRecord | undefined {
  const { seq, at, ...rest } = event;
  let safe: unknown;
  try {
    safe = redactStrings(rest, redactor);
  } catch {
    return undefined;
  }
  const checked = runEventSchema.safeParse({ ...(safe as object), seq, at });
  if (!checked.success) return undefined;
  const { seq: _s, at: _a, ...body } = checked.data;
  return { seq, at, type: checked.data.type, body: JSON.stringify(body) };
}

/** Rows back to events; a row that does not parse to a valid event of its own sequence number is left out. */
export function fromActivityRecords(records: readonly ActivityRecord[]): RunEvent[] {
  const out: RunEvent[] = [];
  for (const r of records) {
    let body: unknown;
    try {
      body = JSON.parse(r.body);
    } catch {
      continue;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) continue;
    const parsed = runEventSchema.safeParse({ ...body, seq: r.seq, at: r.at });
    if (parsed.success && parsed.data.type === r.type) out.push(parsed.data);
  }
  return out;
}

function redactStrings(value: unknown, redactor: Redactor): unknown {
  if (typeof value === "string") return redactor.redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactStrings(v, redactor));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactStrings(v, redactor)]));
  }
  return value;
}
