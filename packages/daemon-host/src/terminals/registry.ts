// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { MAX_TERMINALS_PER_WORKSPACE, terminalIdSchema, type Terminal } from "@axis/protocol";
import { isDefinitiveSpawnFailure, type PtyLateSpawn, type PtyTerminalHandle, type PtyTerminalPort } from "../ports/pty.js";

export type TerminalState = Terminal["state"];

/** One terminal the daemon opened (plain) or started (a CLI run's). Only `open` may be granted (section 4's monotonic lifecycle). */
export interface TerminalRecord {
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly kind: "plain" | "cli-run";
  readonly runId: string | null;
  readonly state: TerminalState;
}

/** A reserved plain-terminal slot: an open between its reservation and a definitive outcome (opaque to callers). */
export interface TerminalOp {
  readonly workspaceId: string;
  readonly projectId: string;
}

interface Charge extends TerminalOp {
  /** The group this slot waits on, once one is known. */
  handle: PtyTerminalHandle | undefined;
  /** Abandoned (cancelled, or its project's trust ended): a handle reported for it is never published. */
  abandoned: boolean;
  /** Held for an outcome that is not known (a timeout or an untrackable handle): released only by a late definitive answer. */
  unknown: boolean;
  /** Settled: the spawn's outcome is decided (published, failed, or handed over late). */
  settled: boolean;
}

interface Rec {
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly kind: "plain" | "cli-run";
  readonly runId: string | null;
  state: TerminalState;
  readonly handle: PtyTerminalHandle;
  readonly charge: Charge | undefined;
  readonly off: { dispose(): void };
}

export interface TerminalRegistryDeps {
  /** Only `revoke` is used here: the grant is the service's, after `attachable`. */
  readonly port: Pick<PtyTerminalPort, "revoke">;
  readonly maxPerWorkspace?: number;
}

/** True while the group may have a process: a throw counts as alive (fail closed). */
function alive(h: PtyTerminalHandle | undefined): boolean {
  if (h === undefined) return true;
  try {
    return h.groupAlive() !== false;
  } catch {
    return true;
  }
}

function validHandle(h: unknown): h is PtyTerminalHandle {
  if (typeof h !== "object" || h === null) return false;
  const x = h as Record<string, unknown>;
  return terminalIdSchema.safeParse(x["terminalId"]).success && typeof x["kill"] === "function" && typeof x["groupAlive"] === "function" && typeof x["onExit"] === "function";
}

/**
 * DC-3a (terminals-contract.md section 4): the daemon's in-memory registry of the terminals it opened and the CLI runs' terminals
 * it started. Nothing survives a daemon restart, matching the pty process.
 *
 * Slots (plain terminals only, at most `maxPerWorkspace` per workspace, pending and live together): `reserve` takes one before the
 * spawn (the caller holds the project mutex, so two opens never both see a free last slot); it is released only on a definitive
 * "no spawn" or when the group it waited on is known gone (`groupAlive` false; a throw keeps it). A timeout keeps it charged until a
 * late answer. Released slots are found by `sweep`, which every `reserve` runs first.
 *
 * Lifecycle: `open`, then `closing`, then `closed` or `exited`, never back. `close` sets `closing` FIRST, revokes the grant in the
 * pty process, then kills the group; a throwing kill leaves it `closing`. The leader's exit makes an open terminal `exited` and
 * revokes it. Only an `open` terminal is `attachable`.
 */
export class TerminalRegistry {
  readonly #port: Pick<PtyTerminalPort, "revoke">;
  readonly #max: number;
  readonly #charges = new Set<Charge>();
  readonly #recs = new Map<string, Rec>();

  constructor(deps: TerminalRegistryDeps) {
    this.#port = deps.port;
    this.#max = deps.maxPerWorkspace ?? MAX_TERMINALS_PER_WORKSPACE;
  }

  /** Reserves a plain-terminal slot in `workspaceId`, or `undefined` when its slots are all charged. */
  reserve(workspaceId: string, projectId: string): TerminalOp | undefined {
    this.sweep();
    let used = 0;
    for (const c of this.#charges) if (c.workspaceId === workspaceId) used++;
    if (used >= this.#max) return undefined;
    const c: Charge = { workspaceId, projectId, handle: undefined, abandoned: false, unknown: false, settled: false };
    this.#charges.add(c);
    return c;
  }

  /** The open's spawn rejected: a definitive failure frees the slot; anything else keeps it charged until a late answer. */
  failed(op: TerminalOp, error: unknown): void {
    const c = this.#charge(op);
    if (c === undefined || c.settled) return;
    if (isDefinitiveSpawnFailure(error)) {
      c.settled = true;
      this.#charges.delete(c);
    } else c.unknown = true;
  }

  /** The late outcome of a spawn that timed out (the pty client's `onLate`). */
  late(op: TerminalOp, outcome: PtyLateSpawn): void {
    const c = this.#charge(op);
    if (c === undefined || c.settled) return;
    c.settled = true;
    if (outcome.kind === "failed") return void this.#charges.delete(c);
    c.unknown = false; // known now: the group is tracked until it is gone (an untrackable handle sets it again)
    this.#endUnpublished(c, outcome.handle);
  }

  /** The open was cancelled or its project's trust ended: whatever handle comes for it is never published. */
  abandon(op: TerminalOp): void {
    const c = this.#charge(op);
    if (c !== undefined) c.abandoned = true;
  }

  /** The spawn resolved. Publishes an `open` terminal, or ends an abandoned or invalid one (`undefined`). */
  publish(op: TerminalOp, handle: PtyTerminalHandle): TerminalRecord | undefined {
    const c = this.#charge(op);
    if (c === undefined || c.settled) {
      this.#endUnpublished(undefined, handle);
      return undefined;
    }
    c.settled = true;
    if (c.abandoned || !validHandle(handle) || this.#recs.has(handle.terminalId)) {
      this.#endUnpublished(c, handle);
      return undefined;
    }
    return this.#add(handle, c, { workspaceId: c.workspaceId, projectId: c.projectId, kind: "plain", runId: null });
  }

  /** A CLI run's terminal (the runs' pty port wrapper). It holds no plain slot; it ends with its run, never by `close`. */
  addCliRun(handle: PtyTerminalHandle, run: { readonly runId: string; readonly workspaceId: string; readonly projectId: string }): void {
    if (!validHandle(handle) || this.#recs.has(handle.terminalId)) return;
    this.#add(handle, undefined, { workspaceId: run.workspaceId, projectId: run.projectId, kind: "cli-run", runId: run.runId });
  }

  get(terminalId: string): TerminalRecord | undefined {
    const r = this.#recs.get(terminalId);
    return r === undefined ? undefined : this.#view(r);
  }

  /** Published terminals, oldest first; a pending open is never listed. */
  list(workspaceId?: string): TerminalRecord[] {
    this.sweep();
    return [...this.#recs.values()].filter((r) => workspaceId === undefined || r.workspaceId === workspaceId).map((r) => this.#view(r));
  }

  /** The terminal, when it may be granted now: known and `open`. Read immediately before the grant, with no await between. */
  attachable(terminalId: string): TerminalRecord | undefined {
    const r = this.#recs.get(terminalId);
    return r !== undefined && r.state === "open" ? this.#view(r) : undefined;
  }

  /** Closes a plain terminal (idempotent). False for an unknown id or a CLI run's terminal. */
  close(terminalId: string): boolean {
    const r = this.#recs.get(terminalId);
    if (r === undefined || r.kind !== "plain") return false;
    this.#end(r);
    return true;
  }

  /** Project untrust or binding loss (section 2 step 4): the project's pending opens are abandoned, its live plain terminals closed. */
  projectRevoked(projectId: string): void {
    for (const c of this.#charges) if (c.projectId === projectId && !c.settled) c.abandoned = true;
    for (const r of [...this.#recs.values()]) if (r.projectId === projectId && r.kind === "plain") this.#end(r);
  }

  /** Frees the slots whose group is known gone, and forgets ended terminals whose group is gone. */
  sweep(): void {
    for (const r of [...this.#recs.values()]) {
      if (r.state === "open" || alive(r.handle)) continue;
      r.off.dispose();
      this.#recs.delete(r.terminalId);
    }
    for (const c of [...this.#charges]) {
      if (c.handle === undefined || c.unknown) continue;
      const rec = this.#recs.get(c.handle.terminalId);
      if (rec !== undefined && rec.charge === c) continue; // released with its record
      if (!alive(c.handle)) this.#charges.delete(c);
    }
  }

  #charge(op: TerminalOp): Charge | undefined {
    return this.#charges.has(op as Charge) ? (op as Charge) : undefined;
  }

  #add(handle: PtyTerminalHandle, charge: Charge | undefined, f: Pick<Rec, "workspaceId" | "projectId" | "kind" | "runId">): TerminalRecord {
    let rec: Rec | undefined;
    const off = handle.onExit(() => {
      if (rec === undefined) return;
      if (rec.state === "open") {
        rec.state = "exited";
        this.#revoke(rec.terminalId);
      } else if (rec.state === "closing") rec.state = "closed";
    });
    if (charge !== undefined) charge.handle = handle;
    rec = { ...f, terminalId: handle.terminalId, state: "open", handle, charge, off };
    this.#recs.set(rec.terminalId, rec);
    return this.#view(rec);
  }

  /** closing FIRST, then the revoke (it holds even when the kill throws), then the kill. Never moves a terminal backwards. */
  #end(r: Rec): void {
    if (r.state === "open") r.state = "closing";
    this.#revoke(r.terminalId);
    if (r.state !== "closing") return; // closed or exited: the group is already being waited on
    try {
      r.handle.kill("SIGKILL");
      r.state = "closed";
    } catch {
      /* stays closing: the slot waits for the group to be gone */
    }
  }

  /** A handle nobody may use: revoked, killed, and tracked by its slot (when it has one) until the group is gone. */
  #endUnpublished(c: Charge | undefined, handle: PtyTerminalHandle): void {
    const valid = validHandle(handle);
    if (valid) this.#revoke(handle.terminalId);
    try {
      handle.kill("SIGKILL");
    } catch {
      /* the slot below waits for the group */
    }
    if (c === undefined) return;
    if (valid) c.handle = handle;
    else c.unknown = true; // an id that cannot be checked cannot be tracked: the slot stays charged
  }

  #revoke(terminalId: string): void {
    try {
      this.#port.revoke(terminalId);
    } catch {
      /* a closed port: the pty process ended its terminals with the control channel */
    }
  }

  #view(r: Rec): TerminalRecord {
    return Object.freeze({ terminalId: r.terminalId, workspaceId: r.workspaceId, projectId: r.projectId, kind: r.kind, runId: r.runId, state: r.state });
  }
}
