// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { ProviderError } from "@axis/providers";

/** The part of a body reader the adapter uses. Node's `ReadableStreamDefaultReader` satisfies it. */
export interface BodyReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock?(): void;
}

export interface ResponseBody {
  getReader(): BodyReader;
}

/** The structural subset of a `fetch` `Response` the adapter reads. */
export interface ResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly redirected?: boolean | undefined;
  readonly url?: string | undefined;
  readonly type?: string | undefined;
  readonly body: ResponseBody | null;
}

export interface FetchInit {
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
  /** Always `manual`: redirects are never followed (ANT-1). */
  readonly redirect: "manual";
  readonly signal: AbortSignal;
}

/** Node's global `fetch` fits this. Tests inject a fake, so no test touches the network. */
export type FetchLike = (url: string, init: FetchInit) => Promise<ResponseLike>;

function cancelled(): ProviderError {
  return new ProviderError("cancelled");
}

/**
 * A response body read under a byte budget and an abort signal. A pending read
 * is raced against the signal so cancellation does not wait for the next
 * chunk, and `close()` always releases the response.
 */
export class BodyStream {
  private readonly reader: BodyReader;
  private readonly onAbort: () => void;
  private finished = false;
  private closed = false;
  private total = 0;

  constructor(
    body: ResponseBody,
    private readonly signal: AbortSignal,
    private readonly maxBytes: number,
  ) {
    this.reader = body.getReader();
    this.onAbort = (): void => {
      void this.release();
    };
    if (signal.aborted) this.onAbort();
    else signal.addEventListener("abort", this.onAbort, { once: true });
  }

  /** The next chunk, or undefined at the end. Fails with `cancelled`, `network` or `invalid_response`. */
  async next(): Promise<Uint8Array | undefined> {
    if (this.finished) return undefined;
    if (this.signal.aborted) throw cancelled();
    let step: { readonly done: boolean; readonly value?: Uint8Array | undefined };
    // The abort promise is made per read and its listener removed afterwards. A promise that lives as
    // long as the stream would keep a reaction, and with it every chunk, alive until the stream ends.
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(cancelled());
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      step = await Promise.race([this.reader.read(), aborted]);
    } catch (e) {
      if (this.signal.aborted) throw cancelled();
      if (e instanceof ProviderError) throw e;
      throw new ProviderError("network", { reason: "stream_error" });
    } finally {
      if (onAbort !== undefined) this.signal.removeEventListener("abort", onAbort);
    }
    if (step.done) {
      this.finished = true;
      return undefined;
    }
    const value = step.value;
    if (!(value instanceof Uint8Array)) throw new ProviderError("invalid_response", { reason: "malformed_chunk" });
    this.total += value.length;
    if (this.total > this.maxBytes) throw new ProviderError("invalid_response", { reason: "response_too_large" });
    return value;
  }

  private async release(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener("abort", this.onAbort);
    try {
      if (!this.finished) await this.reader.cancel();
    } catch {
      // The response is being dropped anyway.
    }
    try {
      this.reader.releaseLock?.();
    } catch {
      // A pending read can make the release throw; the cancel above already ended it.
    }
  }

  /** Release the response: cancel it unless it was read to the end. Safe to call twice. */
  close(): Promise<void> {
    return this.release();
  }
}

/** Drop a response we will not read, without waiting for it. */
export function discard(res: ResponseLike): void {
  try {
    const p = res.body?.getReader().cancel();
    void Promise.resolve(p).catch(() => undefined);
  } catch {
    // Nothing to release.
  }
}
