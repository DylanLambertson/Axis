// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { execFileSync } from "node:child_process";

/**
 * Without openssl the egress tests cannot make their certificates. On a dev machine they are skipped with a loud reason;
 * under the gate (which sets AXIS_REQUIRE_PINNING_TEST=1) and in CI they FAIL, so ADR 0009's first test never passes by
 * not running.
 */
export function opensslMissing(env: NodeJS.ProcessEnv = process.env, probe: () => void = () => execFileSync("openssl", ["version"], { stdio: "ignore" })): string | false {
  try {
    probe();
    return false;
  } catch {
    if (env.AXIS_REQUIRE_PINNING_TEST === "1" || env.CI !== undefined) throw new Error("openssl is missing: ADR 0009's pinning test is required here (gate or CI) and cannot run without it");
    return "SKIPPED ADR 0009's pinning test: openssl is needed to make the test certificate (the gate and CI require it)";
  }
}
