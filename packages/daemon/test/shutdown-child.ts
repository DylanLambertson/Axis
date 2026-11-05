// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Run by shutdown-signal.test.ts as a child process: one in-flight request, then a real SIGTERM.
import { Daemon, MemoryIdempotencyStore, installShutdownSignals, memoryPair } from "../src/index.js";
import { CONTRACT, allowAll, hello, req, testRegistry, verifier } from "./harness.js";

const daemon = new Daemon({
  identity: verifier,
  audit: { append: () => undefined },
  registry: testRegistry,
  policy: allowAll,
  idempotency: new MemoryIdempotencyStore(),
  shutdown: { graceMs: 5_000, cancelSettleMs: 500 },
});
daemon.register(CONTRACT, 1, {
  echo: async () => {
    process.stdout.write("started\n");
    await new Promise((r) => setTimeout(r, 300));
    return { text: "done" };
  },
});

const { client, server } = memoryPair();
daemon.accept(server, "good");
const answers: Array<{ id?: string; ok?: boolean; type?: string }> = [];
let onAnswer: (() => void) | undefined;
client.on("message", (m: { id?: string; ok?: boolean; type?: string }) => {
  answers.push(m);
  onAnswer?.();
});
client.postMessage(hello());
const until = (pred: () => boolean, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(pred()), ms);
    const check = (): void => {
      if (pred()) {
        clearTimeout(t);
        resolve(true);
      }
    };
    onAnswer = check;
    check();
  });

await until(() => answers.some((m) => m.type === "welcome"), 2_000);
client.postMessage(req("r1", "echo", { text: "hi" }));

installShutdownSignals(daemon, {
  exit: (code) => {
    void until(() => answers.some((m) => m.id === "r1"), 1_000).then((got) => {
      const ok = answers.find((m) => m.id === "r1")?.ok === true;
      process.stdout.write(`${JSON.stringify({ code, answered: got, ok })}\n`);
      client.close();
      process.exitCode = code;
    });
  },
});
