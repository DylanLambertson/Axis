// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ProviderAdapter } from "../src/types.js";

/**
 * The adapter with every output recorded: events, results, listings,
 * reports and thrown values. `stream` still calls the adapter synchronously,
 * so the "never throws synchronously" check sees the adapter itself.
 */
export function recording(a: ProviderAdapter, sink: unknown[]): ProviderAdapter {
  const keep = <T>(p: Promise<T>): Promise<T> =>
    p.then(
      (v) => {
        sink.push(v);
        return v;
      },
      (e: unknown) => {
        sink.push(e);
        throw e;
      },
    );
  const w: { -readonly [K in keyof ProviderAdapter]: ProviderAdapter[K] } = {
    descriptor: a.descriptor,
    listModels: (o) => keep(a.listModels(o)),
    getCapabilities: (m, o) => keep(a.getCapabilities(m, o)),
    validateConnection: (o) => keep(a.validateConnection(o)),
    generate: (r, o) => keep(a.generate(r, o)),
    stream: (r, o) => {
      const inner = a.stream(r, o);
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for await (const ev of inner) {
              sink.push(ev);
              yield ev;
            }
          } catch (e) {
            sink.push(e);
            throw e;
          }
        },
      };
    },
  };
  const count = a.countTokens;
  if (count !== undefined) w.countTokens = (r, o) => keep(count.call(a, r, o));
  const cost = a.estimateCost;
  if (cost !== undefined) {
    w.estimateCost = (m, u) => {
      const c = cost.call(a, m, u);
      sink.push(c);
      return c;
    };
  }
  return w;
}
