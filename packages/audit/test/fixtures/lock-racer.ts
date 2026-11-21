// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Race fixture: try to take the instance lock for argv[2]; print "won" (and hold it until the parent closes stdin) or the error code.
import { acquireInstanceLock } from "../../src/index.js";

try {
  acquireInstanceLock(process.argv[2] ?? "");
  process.stdout.write("won");
  // The winner holds the lock until the test says every racer has answered, however late a slow racer starts on a loaded host.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
} catch (e) {
  process.stdout.write(String((e as { code?: unknown }).code));
}
