# The web host entry (ticket W1)

Companion to `docs/design/daemon-host.md` (sections 6.1 and 6.3), `docs/design/daemon-host-entry.md` (X1), ADR 0003 D1.4 and D1.7, ADR 0005 D3, and threat model rows DMN-4, WEB-1, WEB-2, WEB-5 and NET-1 (`docs/security/threat-model-phase0.md`, `docs/security/threat-model-phase1.md`).

## What it is

A browser build reaches the same daemon contracts as the desktop renderer. The daemon itself never listens (DMN-4, ADR 0003 D1.1): it is a child process of the web server, and its only input is the ordered control channel its parent wrote (`ChannelMux`, design 6.3). The **web host entry** runs in that parent, on the supervisor side. It is the browser's half of the transport:

```text
browser --WebSocket (loopback, token, origin)--> web host entry --ChannelMux frame { cid }--> daemon (attestation verified)
```

1. It listens on one loopback address, and only when the caller passes an explicit, strict opt-in configuration (`enabled: true`).
2. It checks every WebSocket upgrade before it answers `101`: path, `Host`, `Origin`, version, key and the per-launch token. A refused upgrade gets a status line with no body and the socket is destroyed. No unauthenticated WebSocket ever exists.
3. For each accepted socket it opens one virtual connection of the supervisor's `ChannelMux`, mints an attestation with the per-spawn key (design 6.1: `HMAC-SHA256`, single use, 30 s freshness) and sends the control message `connect { cid, attestation }`. The daemon verifies it as it does for any other connection. The browser never sees the attestation or the key.
4. It relays text messages both ways. Each browser message is parsed as JSON and sent as the `data` of a `frame` for its own `cid`, so browser bytes can never become a control message (design 6.3: a client's byte stream is never parsed as host control).

What it is not: it is not a composition point. It loads neither `compose.ts`, `entry.ts` nor a minter, and it runs in no desktop process. The reh server integration (ADR 0003 D1.7: one upstream `axis` channel on the reh socket, identity from the reh connection token) is a follow-up (below); it can reuse the session and attestation layer and drop this listener.

## Threats and decisions

| # | Threat | Decision (built) |
|---|---|---|
| W-1 | **Port exposure.** Another machine reaches the listener; the desktop app starts it by accident; a reh-web listener appears during a desktop run (ROADMAP gate, NET-1). | Bind to an IP literal only: `127.0.0.1` (default) or `::1` (`ipv6Only`). The configuration schema has no other value: no `0.0.0.0`, no `::`, no host name (a name can resolve to a routable address). A non-loopback bind needs TLS and the Phase 5 gateway and is not supported. After `listen`, the bound address is compared with the configured literal and the host refuses to run (`bind_mismatch`) if they differ. `exclusive: true`. Port `0` (ephemeral) or 1024 to 65535; the bound port is reported to the caller. **Never started by default:** there is no default configuration, the parse refuses anything but `enabled: true`, and nothing reachable from the desktop entries (the daemon entry and the main seam) can load `src/web/`: the import test, the staged-file scan and the bundle graph walk refuse it (below). |
| W-2 | **DNS rebinding.** A page on `evil.example` re-resolves its name to `127.0.0.1` and talks to the listener as same-origin. | The `Host` header must be exactly one value and equal `127.0.0.1:<port>`, `[::1]:<port>` (matching the bound family) or `localhost:<port>`, with the bound port. A rebound name sends `Host: evil.example:<port>` and is refused (`403`). The token (W-4) is a second, independent control: a rebinding page does not have it. |
| W-3 | **Cross-site WebSocket hijacking.** WebSockets are not covered by the same-origin policy; a page on any origin can open one, and a browser attaches cookies. | No ambient credential exists: nothing is read from a cookie or from HTTP authentication. `Origin` must be present, a single value, and equal one of `allowedOrigins` exactly. `allowedOrigins` is required, has 1 to 8 entries, each a serialized `http`/`https` origin (no path, query, user info, wildcard or `null`); an empty list cannot be configured. A missing `Origin` (a non-browser client) is refused too, so there is one rule. |
| W-4 | **Token handling.** The token leaks into logs, URLs, history, `Referer`, errors or responses, or is guessed. | 32 random bytes per start, base64url (43 characters), made by the host and never accepted from configuration (a configured token would persist in a file). The caller gets it once (`takeToken()`; a second call throws). The browser offers it as a WebSocket subprotocol, `Sec-WebSocket-Protocol: axis.v1, axis.auth.<token>`; the answer selects `axis.v1` only, so the token is never echoed. Not in the URL: any query string is refused. The comparison hashes both sides with SHA-256 and uses `timingSafeEqual`, so length and content leak nothing. The host keeps the digest; the text is dropped after `takeToken()` and the key copy is zeroed by `dispose()`. No log line, error or close frame carries the token, the attestation, a header value or browser data. Brute force is out of reach (256 bits); failed upgrades are counted, not throttled. |
| W-5 | **Identity.** A browser asserts who it is or replays an attestation. | The attestation is minted by the web host per socket: `actor: "user"`, `actorId: "web-user"`, `clientKind: "web"`, `windowId: "web"`, `trusted: false`, no `workspaceId`, a fresh 24-character `connectionId`. Nothing in browser data selects any of it. One `windowId` for every web socket puts all of them in one connect-limiter bucket of the daemon (burst 5, 10 a minute), so reconnect loops are throttled. **Read-only reach (policy):** `RuleTablePolicy` lets a client whose `clientKind` is not `desktop` call only the methods in the explicit allow-list `WEB_ALLOWED` (17 reads today: worktrees list/status, projects list, audit status/list/verify, cli-runs get/list, providers list, git pushPlan/compareUrl, review diff, runs get/list/events, events subscribe/unsubscribe), and only while the call is also a read (`sideEffect` `read` or `none`), at most tier 1 and not per-start. A method added later is refused to web clients until its web reach is decided, and a test compares the reach with that exact list. Not listed on purpose: all of `axis.approvals` (every web tab shares one window, DMN-3), every write, CLI run starts and stops, `review.complete`, `runs.cancel`. The `approvals` event topic carries no content (a "changed" ping), so `events.subscribe` stays a read. Invariant for X1b: no desktop identity may use `windowId: "web"`; the policy refuses one, and X1b mints `w<n>`. |
| W-6 | **Multi-client and memory limits.** Many sockets, huge frames, slow readers, a flood toward the daemon. | `maxClients` (default 4, at most 16) live sessions; one more is refused with `503` before the upgrade. `server.maxConnections` bounds raw sockets (clients plus 4 pending), `maxHeaderSize` is 8 KiB. A frame header announcing more than `maxFrameBytes` (default the protocol maximum, 1 MiB) closes with 1009 before the payload is buffered, so a session holds at most one frame. Outbound (daemon to browser): a socket whose unsent bytes pass `maxOutboundBytes` (default 4 MiB) is closed with 1013 and its virtual connection closed, because the mux has no per-connection flow control. Inbound (browser to daemon): when the supervisor channel's backlog (`ChannelFlow.pending()`, the IPC adapter's count of messages not yet written) reaches `maxChannelBacklog` (default 64), every session stops reading its socket and stops handling frames already decoded from the current read (they are held, at most one read, and replayed in order on the drain, `onDrain`), so the channel never receives more than the backlog plus one message per client. The daemon's mux bounds its own queues as before. **Before the upgrade:** Node's header and request deadlines are 5 s (checked every second), and at most 4 sockets may be mid-handshake: one more evicts the oldest, so sockets held open with a partial request cannot lock out a client (`server.maxConnections` is sessions plus pending plus one). |
| W-7 | **Protocol abuse.** Malformed frames, binary, fragmentation, compression, control-frame tricks, invalid UTF-8, hostile JSON. | A minimal RFC 6455 server codec: client frames must be masked, RSV bits zero (no extension is negotiated), control frames at most 125 bytes and unfragmented. Text only (binary: 1003), no fragmentation (1003), invalid UTF-8 or JSON (1007). Ping is answered with pong; close is answered and ends the session. JSON is parsed and then checked by the mux's own `refuseNonPlainData` walk (depth, nodes, size, `__proto__`) before it is framed. Every failure closes that one session with a closed code and no reason text. A daemon that closes the connection before sending anything (a refused attestation, the connect limit) is reported as 1008, a later close as 1000. The decoder keeps received chunks and joins them once a frame is complete, so a frame sent in tiny segments costs one copy. |
| W-8 | **Plain HTTP.** Other requests reach the server. | Every non-upgrade request gets `404` with no body and `Connection: close`. Only `GET /axis/1` upgrades. |
| W-9 | **Lifecycle.** Listeners or sockets left behind; the daemon channel closes. | `dispose()` stops listening, closes every session with 1001 and its virtual connection, removes every listener it added, zeroes its key copy and resolves when the server has closed. The channel closing (the daemon exited) closes every session with 1001 and refuses new upgrades with `503`. The host owns no timer of its own. |

## Structural isolation (the three checks)

- **Listener built-ins.** `node:net`, `node:http`, `node:https`, `node:http2`, `node:tls` and `node:dgram` may be imported by one shipped file in the whole repository, `packages/daemon-host/src/web/server.ts`. The import test (`test/packages/imports.test.mjs`), the staging scan (`LISTENER_BUILTINS` in `scripts/code-oss/stage-scan.mjs`, applied by `classifySpecifier` and by the check of every staged file) and their negative tests enforce it.
- **The web directory.** No file of `src/` outside `src/web/` may import a file inside it (not the public index, not `entry.ts`, not `compose.ts`, not `supervisor.ts`); the public index does not export it. The staged scan refuses the same edge, and the bundle graph check (`listenerReachViolations` in `scripts/code-oss/web-rules.mjs`) walks the whole graph from every staged module outside `daemon-host/web/` and from the two desktop entries (the daemon entry and the main seam) and refuses any path into `daemon-host/web/`. So a desktop bundle cannot contain the listener, which is what makes the ROADMAP "no Axis listener during a desktop run" line structural rather than a default.
- **Not a composition point.** `src/web/` may not load `compose.ts`, `entry.ts`, the public index or a minter; the existing rules already refuse that (the minter walk treats `web/` like any other module), and negative tests prove it for `web/`.

## Not done (follow-ups)

- **W1b, the reh tunnel** (ADR 0003 D1.7): an overlay file in `vs/server/node` that registers the `axis` channel on the reh socket server and feeds the session layer, with identity from the reh connection token; the reh server must then spawn the daemon child and own its `init`. Until then nothing in the product calls `startWebHost`.
- **Native confirmation and trust for web clients.** `native.confirm` names `windowId: "web"`; nobody answers it, so tier 4 is declined. `trust.set` for `web` is never sent. Both need a web approval surface (Phase 2).
- **Idle timeout and keepalive pings.** Not built (the host owns no timer; Node's header deadlines cover only the time before the upgrade); an authenticated idle socket holds a client slot until it closes.
- **TLS and non-loopback binds:** Phase 5 gateway.

## Design questions

1. Should a web client ever be `trusted: true`, or reach more than reads? The browser has no Workspace Trust prompt or approval surface of its own; a launcher flag would make trust a configuration value (CFG-1 says it must not come from workspace scope). Kept `false` and read-only (W-5); widening it is a Phase 2 decision with its own review.
2. `localhost` in `Host` is accepted (browsers resolve it to loopback). Should only the IP literal be accepted?

## Review r1 changes

- A pause now stops frames already decoded from the current read (held, replayed in order on the drain), and a drain stops resuming further sessions once one refills the backlog.
- There are now pre-upgrade deadlines (5 s headers and request), and the oldest pending socket is evicted when there are too many.
- Web clients are read-only in the policy (W-5).
- A daemon refusal before any message closes with 1008.
- The decoder joins chunks once per frame.
- The key copy lives in `createWebAttestor` and its zeroing is tested.
- The bind check is `isBoundTo` and is tested.
- Socket tests carry a timeout, so a regression fails instead of hanging.

## Review r2 changes

- The web reach in the policy is now an allow-list (`WEB_ALLOWED`) with a read-only fence, pinned by a literal list in the test.
- The policy refuses a desktop identity whose window id is `web`.
- The tests now pin:
  - the 5 s deadlines and the socket cap;
  - that the cap's `+ 1` lets a fifth pending socket evict;
  - that an upgraded session is not pending;
  - that a session's socket stays paused after its replay fills the backlog again.
- Drains now start one session later each time, so one session cannot starve the rest.
