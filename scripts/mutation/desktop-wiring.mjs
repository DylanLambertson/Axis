// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Mutation run for OS-2's second PR: main's wiring of the hardening (apps/desktop/main/hardening.ts and g28.ts).
//
//   npm run build && npx tsc -b apps/desktop && node scripts/mutation/desktop-wiring.mjs "$PWD"
//
// Each mutant edits ONE compiled file under apps/desktop/dist/tsc, runs test/hardening.test.ts (compiled), and restores the
// file. The names are the ids in that test file's mutant list. Not part of the gate. The entry order (E1, E2) is pinned by
// test/entry-order.test.mjs and the preload (P5-P9) by test/preload-pin.test.mjs, which run their own bad variants.
import { runMutants } from "./run.mjs";
const root = process.argv[2];
const D = `${root}/apps/desktop/dist/tsc`;
const F = { h: `${D}/main/hardening.js`, g: `${D}/main/g28.js` };
const T = { h: [`${D}/test/hardening.test.js`], g: [`${D}/test/hardening.test.js`] };
const M = [
  ["g", "H1 check skipped", "if (refused.length === 0)", "if (true)"],
  ["g", "H1 no exit", "exit(DEBUG_FLAG_EXIT);", ""],
  ["h", "H2 scheme not registered", "deps.protocol.registerSchemesAsPrivileged(", "void ("],
  ["h", "H3 name not set", "deps.app.setName(INTERNAL_APP_NAME);", ""],
  ["h", "H3 userData not set", 'deps.app.setPath("userData", userData);', ""],
  ["h", "H3 overlap unchecked", "if (userDataOverlapsDataRoot(real(userData), real(deps.dataBase), deps.platform) || userDataOverlapsDataRoot(userData, deps.dataBase, deps.platform))", "if (false)"],
  ["h", "H11 links not resolved", "userDataOverlapsDataRoot(real(userData), real(deps.dataBase), deps.platform) || ", ""],
  ["h", "H4 scheme handler missing", "session.protocol.handle(APP_SCHEME,", "void (APP_SCHEME,"],
  ["h", "H4 session policy missing", 'hardenSession(session, (what) => emit({ kind: "policy", what }));', ""],
  ["h", "H4 filter missing", "installSchemeFilter(session.webRequest,", "void (session.webRequest,"],
  ["h", "H5 devtools packaged", "devtools: !options.packaged", "devtools: true"],
  ["h", "H6 not registered", "const entry = deps.registry.add(win.webContents.id);", "const entry = { id: 0 };"],
  ["h", "H6 wrong URL", "await win.loadURL(APP_URL);", 'await win.loadURL("axis-app://shell/");'],
  ["h", "H7 not pruned", "win.on(\"closed\", () => deps.registry.close(entry.id));", ""],
  ["h", "H8 sender unchecked", 'if (typeof id !== "number")', "if (false)"],
  ["h", "H9 relative entry", "if (!isAbsolute(entry))", "if (false)"],
  ["h", "H10 missing API accepted", "if (missing.length > 0)", "if (false)"],
  ["h", "H10 chooser accepted", "if (heard.length > 0)", "if (false)"],
  ["h", "H12 web contents not hardened", 'hardenWebContents(contents, (what) => onEvent({ kind: "policy", what }));', ""],
  ["h", "H12 certificate chosen", "event.preventDefault();\n        callback();\n        onEvent({ kind: \"policy\", what: \"client_certificate\" });", "onEvent({ kind: \"policy\", what: \"client_certificate\" });"],
  ["h", "H12 login answered", "event.preventDefault();\n        callback();\n        onEvent({ kind: \"policy\", what: \"login\" });", "onEvent({ kind: \"policy\", what: \"login\" });"],
  ["h", "H13 Open the default", "defaultId: c.defaultId", "defaultId: 1"],
  ["h", "H13 cancel answer", "cancelId: c.cancelId", "cancelId: 1"],
  ["h", "H13 link", "noLink: c.noLink", "noLink: false"],
  ["h", "H13 detail", "detail: c.detail", "detail: c.detail.slice(0, 20)"],
  ["h", "H13 opens on any answer", "return answer?.response === OPEN_BUTTON;", "return true;"],
];
runMutants({ root, files: F, tests: T, mutants: M });
