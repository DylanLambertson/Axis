# Main's secret broker (ticket PV-N0)

- **Status:** design for review (security-relevant). Nothing here is built.
- **Date:** 2026-11-22. **Code baseline:** `origin/main` at `6c95e93`; upstream Code OSS `1.144.0` at `2c33b50` (the vendor tree).
- **Decides:** how the daemon's vault (`@axis/vault`) gets a production `SecretBackend`. ADR 0003 D1.6 sketches a privileged main port carrying `secrets.decrypt(handle, purpose)`; this note fixes the shape. It needs no ADR amendment: D1.6 stands, and section 3 says how the messages map to it.
- **Builds on:** ADR 0003 (D1.6; the renderer holds the upstream `encryption` channel), ADR 0009 decision 5 (vault namespaces, the production backend as a prerequisite), `docs/design/anthropic-adapter.md` §10 (the vault and the `SecretBackend` contract), `docs/design/main-answers.md` §3.1 (the audit anchor: the pattern copied here), `docs/design/product-vision-v2-tickets.md` §5.1 (PV-N0), threat model PRV-1, PRV-2, EXT-1, EXT-4, A10.
- **Evidence tags:** **[V]** verified in the code (file and symbol named); **[U]** verified in the upstream vendor tree at `2c33b50`; **[D]** decided here; **[I]** inferred, not verified.

## 1. Why

The vault keeps no secret itself: it stores through an injected `SecretBackend` [V, `packages/vault/src/types.ts` `SecretBackend`]. The daemon entry passes none, so in a built app no provider key is read and no integration can connect [V, `daemon-host/src/compose.ts` `composer.anthropic`; ADR 0009 decision 5]. `safeStorage` exists only in Electron main, so the backend must live there and the daemon must reach it.

## 2. What exists

- **The contract** the backend must meet: `info`, `put`, `get`, `meta`, `remove`, `list`; `put` must refuse a write that would land on another backend or protection than its `meta` says, and report where it landed; `get` and `meta` must report each entry's real protection from the stored data, not from metadata the vault wrote (`anthropic-adapter.md` §10.3) [V for the type; the per-entry rule is a design requirement].
- **The pattern:** main already stores one `safeStorage` record for the daemon, the audit anchor: `<base>/anchor/audit-anchor.v1`, directory `0700`, file `0600`, atomic write (temporary file `wx`, write, `fsync`, `rename`, directory `fsync`), one write at a time, a strict record form, and no answer when the backend is not secure [V, `main-answers.md` §3.1; `daemon-host/src/main/anchor-file.ts`, `anchor-store.ts`].
- **The control channel** is main's private channel to the daemon; no renderer can post on it [V, ADR 0003 D1.4; `daemon-host/src/control/messages.ts`]. Requests have closed types and strict schemas; main's answers are pure modules under `daemon-host/src/main/` tested without Electron, with source pins for the Electron adapters in `axisMainPorts.ts` [V, `main-answers.md` §1].
- **Upstream's `encryption` channel.** Main registers `EncryptionMainService` on the renderer-reachable bus with `ProxyChannel.fromService` [U, `src/vs/code/electron-main/app.ts:1435-1436`]. Its `decrypt(value)` parses `{ data }` and returns `safeStorage.decryptString` of **any** ciphertext; `encrypt(value)` encrypts any text; `setUsePlainTextEncryption` switches `safeStorage` to the hardcoded key on Linux [U, `src/vs/platform/encryption/electron-main/encryptionMainService.ts` `decrypt`, `encrypt`, `setUsePlainTextEncryption`]. So every renderer, and anything that compromises one, holds a decryption oracle for every ciphertext made with the app's `safeStorage` key (threat model EXT-4, A10).

## 3. Decisions

### 3.1 Main stores the ciphertext; the daemon never does [D]

- **Location:** `<base>/secrets/`, next to `<base>/anchor/` and never inside the daemon's data directory `<base>/daemon`, created `0700`; one file per entry, `0600`, named by the lower-case hex of the entry name's UTF-8 bytes plus `.v1` (vault names include `:` for `integration:<id>`, ADR 0009, which Windows file names refuse).
- **Record:** strict JSON `{ "v": 1, "meta": <EntryMeta>, "ct": "<base64 ciphertext>" }`, at most 16 KiB. The ciphertext is `safeStorage.encryptString` of the **framed plaintext** `axis.secret/1\n<name>\n<secret>`. On read, main decrypts and requires the exact frame and the file's own name: a record copied under another name, or any other form, is `corrupt`.
- **Writes** are the anchor's: temporary file `wx` `0600` in the same directory, write, `fsync`, close, `rename`, directory `fsync` on POSIX; one write at a time per entry; a remove is `unlink` plus directory `fsync`. At most 256 entries; one more is `refused`.
- **The daemon holds plaintext only in memory**, as today (PRV-2). It never writes a ciphertext, so the journal, its exports and the daemon's data directory hold no credential in any form.

### 3.2 Close the renderer's decrypt path for Axis records (EXT-4) [D]

- **A patch to `EncryptionMainService`** (one new file in `code-oss/patches`, counted against the ADR 0002 shell-layer budget): `decrypt` refuses (throws, with no text of the value) when the plaintext begins with the frame tag `axis.secret/`, and `encrypt` refuses a value that begins with it. Main's broker calls Electron's `safeStorage` directly, never the service, so the patch does not touch it.
- **What it closes:** a renderer, a webview that reached the renderer's bus, or an extension path through it cannot turn an Axis record into plaintext through the `encryption` channel, and cannot mint a framed record to plant a key of its choosing (for example its own provider key, to receive the user's prompts).
- **What it does not close (the residual, under A10 and EXT-1):** a process of the same user can read the record file and get the `safeStorage` key outside the app on some platforms: on Linux from an unlocked keyring (libsecret, KWallet) without a prompt, and on Windows through DPAPI, which any process of the user can call; on macOS the keychain item's access list makes another program prompt [I: platform behaviour, not re-verified here]. The renderer already has `localPty` and `localFilesystem` (ADR 0003, threat model §4.1), so a **fully compromised** renderer on Linux or Windows can still get there. The patch removes the one-call oracle, not same-user access.
- **Fallback.** If PV-N0b finds that the patch breaks upstream behaviour (a caller of the service that legitimately handles text starting with `axis.secret/`; none is known), the decision falls back to "accepted under A10" with this residual stated and gate line 9 turned into a recorded residual; the reason must be written here.
- **No wrap key.** A second key held by another process of the same user would be readable by the same attacker; it does not raise the bar, so none is added.

### 3.3 Weak backends are refused (PRV-1) [D, open item for the project lead]

- **Backend report:** `safeStorage.isEncryptionAvailable()` and, on Linux, `safeStorage.getSelectedStorageBackend()`; macOS and Windows report `macos_keychain` and `windows_dpapi`, protection `os_protected` [I: Electron API names at the pin, as main's anchor uses them, `main-answers.md` §3.1].
- **Refused:** encryption not available, or Linux `basic_text` or `unknown`. A store answers `refused` with a fixed reason the UI shows ("this system has no protected key store; Axis does not store credentials in plain text"). The daemon's vault is created with `weakPolicy: "refuse"` [V, `vault/src/vault.ts` `VaultOptions.weakPolicy`], so the consent path is never offered in production. **Open item:** the vault's design allows a consent path for `basic_text`; this note refuses instead, by the project lead's default, until a decision row says otherwise.
- **The ciphertext is checked, not only the report.** The renderer can call `setUsePlainTextEncryption` (section 2), and a keyring can stop between calls, so after `encryptString` main checks the ciphertext itself on Linux: a `v10` prefix (the hardcoded key) is refused and nothing is written; only `v11` (a keyring key) is stored [I: Chromium `os_crypt` prefixes, `anthropic-adapter.md` §10.3]. On read, the same prefix decides the protection `get` and `meta` report, so a weak copy is shown as weak after a restart with nothing persisted about it.

### 3.4 The control messages [D]

Daemon → main requests, each with a `requestId`, strict schemas, closed types; main → daemon answers. They are the D1.6 privileged port: no renderer can send or read them.

| Request | Payload | Answer |
|---|---|---|
| `secrets.info` | none | `{ backend, protection, available }` |
| `secrets.put` | `{ name, secret, meta }` | `{ landedOn: { backend, protection } }` or an error |
| `secrets.get` | `{ name }` | `{ secret, meta }` with `meta.protection` from the ciphertext, or `not_found` |
| `secrets.meta` | `{ name }` | `{ meta }` (no decryption) or `not_found` |
| `secrets.remove` | `{ name }` | `{ removed }` |
| `secrets.list` | none | `{ entries: [{ name, meta }] }`, at most 256 |

- **Bounds:** names match the vault's `NAME_RE` plus the `integration:` prefix; secrets 8 to 4,096 printable ASCII (the vault's rule); one request per name at a time, and at most 4 in flight in all; every answer within 5 s, and 60 s for `get` and `put` on macOS, where the keychain may prompt [I]. Silence is a `backend_failed` on the daemon side, which the vault already maps to a fixed error [V, `VaultError`].
- **Closed errors:** `not_found`, `refused` (weak or unavailable backend), `corrupt`, `failed`. Never an exception text, a path or a value. Main logs closed event names only, as for the anchor.
- **The daemon side** is a `SecretBackend` over the control client (`daemon-host/src/secrets-backend.ts`), validating every answer field by field (the vault treats backend data as untrusted [V, `anthropic-adapter.md` §10.2]). The ADR 0003 sketch `secrets.decrypt(handle, purpose)` maps to `secrets.get { name }`: the purpose is checked and audited by the vault in the daemon (and bound to the entry kind by ADR 0009 decision 5), not by main.

### 3.5 Wiring [D]

- The daemon entry passes the control-channel backend to the composition (`composer.anthropic.backend`), and the integrations binding gets the same backend (PV-N1f).
- **At start** the daemon lists the entries and reveals each provider entry once with `validate_connection` so the redactor knows every stored key before any request (`anthropic-adapter.md` §10.2, `knownSecrets`); a failure leaves that connection unusable, never the daemon.
- **Out of scope:** storing a key over the bridge (the "connect" flow with its tier and dialog), the consent grantor, and the UI; separate tickets.

## 4. Threats

| ID | Threat | Control |
|---|---|---|
| SB-1 | A renderer decrypts an Axis record through upstream's `encryption` channel | The service refuses framed plaintext (3.2); residual: same-user key access outside the app (A10) |
| SB-2 | A renderer plants a record with its own key | `encrypt` refuses the frame; main writes only on a daemon request; the name inside the frame must match the file |
| SB-3 | A credential is stored under the hardcoded Linux key | Report check and `v10` ciphertext check on every write; weak backends refused (3.3) |
| SB-4 | A record moved between entries, truncated or swapped | Framed plaintext with the name; strict record; atomic writes |
| SB-5 | A hung keyring stalls the daemon | Bounded in-flight requests, per-request timeouts, failure confined to the one connection |
| SB-6 | A plaintext reaches a log or error | Closed errors and event names in main and the daemon backend; the vault's existing redaction |

## 5. Gate lines

1. In a built app, a key stored through the broker is read back by the providers binding, and no file under `<base>/daemon` or the journal holds it in any form.
2. Each record file is `0600` in a `0700` directory; a crash during a write leaves the old record or the new one, never a mix.
3. A record copied to another entry's file name, or with a changed frame, reads `corrupt`.
4. With Linux `basic_text`, or `setUsePlainTextEncryption(true)` called from a renderer before a store, the store is refused and nothing is written.
5. A `v10` record placed by hand is reported with protection `none` and refused by `reveal` under the vault's rules.
6. A hung `secrets.get` fails that request within its timeout and leaves other connections usable.
7. No log line or error in main or the daemon carries a canary secret.
8. Every control answer that is malformed or oversized is a `backend_failed`, never a partial value.
9. Upstream's `encryption` channel `decrypt` of an Axis record, and `encrypt` of a framed value, are refused; any other value still works.

## 6. Slices

| Slice | Content | Size | Proves |
|---|---|---|---|
| **PV-N0a** | Control schemas for the six requests and answers; the main-side pure module (record format, framing, atomic store, prefix check, bounds, closed errors) under `daemon-host/src/main/`, tested with a fake cipher and a real temporary directory | M | 2, 3, 4 (logic), 5, 7, 8 |
| **PV-N0b** | The upstream patch to `EncryptionMainService` with a pinned source test, and the shell-budget count | S | 9 |
| **PV-N0c** | The daemon `SecretBackend` over the control client, `weakPolicy: "refuse"`, the entry and composition wiring, the startup reveal; the Electron adapter in `axisMainPorts.ts` (`safeStorage`, file paths) with source pins | M | 1, 6, 7 |

Each is a large-builder slice with an independent security review and mutation testing of the refusal paths. PV-N0a and PV-N0b are independent; PV-N0c follows PV-N0a.

## 7. Open item

- **PRV-1 consent for weak backends.** This note refuses `basic_text` outright (3.3). Allowing it with consent, as the vault supports, needs a decision row in `owner-decisions-2026-11-21.md`.
