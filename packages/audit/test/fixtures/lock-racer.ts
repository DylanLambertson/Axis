// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Race fixture: try to take the instance lock for argv[2]; print "won" (and hold it briefly) or the error code.
import { acquireInstanceLock } from "../../src/index.js";

try {
  acquireInstanceLock(process.argv[2] ?? "");
  process.stdout.write("won");
  setTimeout(() => undefined, 400);
} catch (e) {
  process.stdout.write(String((e as { code?: unknown }).code));
}
