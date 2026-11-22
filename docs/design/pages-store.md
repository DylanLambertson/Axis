# The pages store, `axis.pages/1` and the page tools (PV-Q1 slices 1 and 2)

- **Status:** Built. Slice 1: journal schema version 14, `Journal.pages` and the contract `axis.pages/1`. Slice 2: the contract is **served** (user-only rows), and the composer tools `read_page` and `write_page` are offered to runs of a worker (§5).
- **Decides nothing new.** It builds ADR 0010 decisions 1 and 4 and the 2a threat model's decision O-4 (`docs/security/threat-model-phase2a.md` §6).
- **Code:** `packages/journal/src/schema-pages.ts` (the tables), `packages/journal/src/page-store.ts` (the store), `packages/protocol/src/pages.ts` (the contract), `packages/daemon-host/src/pages/service.ts` (the service and its audit), `src/handlers/pages.ts` (the bridge), `src/bindings/agent-pages.ts` (the tools), `src/policy/rules.ts` (the rows).
- **Later slices:** the isolated page view, attachment transfer and content sniffing, and Export to repository (PV-Q2); plugin rows (ADR 0008 `pages.read`, `pages.write`, PV-K); a keyed hash of each body in the audit, once the per-install key exists (`threat-model-phase2a.md` O-1).

## 1. Tables (schema version 14)

| Table | Holds | Rules |
|---|---|---|
| `pages` | One row per page: project, the number of its newest version, times | At most 500 per project. Id, project and creation time fixed. `last_seq` always equals its newest version's number |
| `page_versions` | Every save: title, body, author, hop, trust flags, origin, time | Never changed after insert, except a one-time reviewed mark on an untrusted version. Numbers count up from 1 with no gap. The 101st version deletes the oldest in the same statement; no other version is deleted while its page exists |
| `page_attachments` | Raster images of a page | PNG, JPEG, GIF or WebP, the type checked against the leading bytes; at most 20 per page, 5 MiB each; added by the user only; never changed |

- **Insert once.** Every table refuses an insert of an existing key. The guard fires before any conflict clause, so `INSERT OR REPLACE`, `REPLACE`, `INSERT OR IGNORE` and every `ON CONFLICT` form abort too; the tests try each verb on each table.
- **NUL.** SQLite's text functions and `GLOB` stop at a NUL byte. ASCII columns (ids, times, hashes) check that their byte length equals their character length; titles and bodies refuse a NUL byte through their blob form.
- **Limits** (ADR 0010 decision 1): body 256 KiB of UTF-8, title 1 to 200 characters under the agent-name rule (`NAME_REFUSED_RANGES`), 200 MiB of version and attachment bytes per project. A write over a limit is refused, never cut.
- **Byte counts, not bodies.** Each version stores `bytes` (its title and body in UTF-8, checked against them at insert) and each attachment `size` (checked against its bytes). The 200 MiB check sums those counts through the covering indexes `page_versions_bytes` and `page_attachments_size` (`projectBytesSql`), so a write never reads another title, body or image and costs the same at any project size; a test pins the query plan.
- **Redundant guards, kept.** `page_versions_inserted_once` and the `bytes` clause of `page_versions_fixed` can never be the first to refuse (the next-number trigger and the `bytes` CHECK refuse first); both stay as a second fence.
- **Delete.** Deleting a page deletes its versions and attachments in the same statement.

## 2. Authors and trust

- **Author** is a closed set: `user`, `agent` (an agent id), `plugin` (a plugin id of at most 64 characters, ADR 0008) or `system`. No request carries it: the daemon takes it from the attested caller.
- **`untrusted`** marks a version that may hold text the user did not write. Every non-user version is untrusted, `system` included. A user edit of an untrusted, unreviewed version stays untrusted and keeps its hop, because the earlier text is still there (ADR 0010 decision 4); once the user marks a version reviewed, the next user edit is trusted again.
- **Hop.** A non-user version records the hop of the writing run, which may be lower than the version before it (ADR 0010 decision 4: each revision carries its own writer's hop); an untrusted user edit inherits the hop of the version it edits; a trusted version has hop 0.
- **Restore** copies its source version: title, body, author, hop and `untrusted`, and records `restored_from`. Restoring an agent's text never makes it the user's, and the reviewed mark is not copied.
- **Derived twice.** The store derives these values itself, and the table's triggers check them against the version before, so no writer can store a page as more trusted than it is.
- **What a reader receives.** `readTaint(pageId)` answers whether the current version is a taint source and at which hop; the taint producer of `read_page` uses it.
- **The reviewed mark.** The store enforces only that a mark is set once, on an untrusted version, no earlier than the version was written. That the user made it, through main's native confirmation (2a decision O-4), is the slice-2 handler's job: the tier-4 row and its challenge, which main confirms in its native dialog.

## 3. The contract

| Method | Side effect | Tier | Idempotency |
|---|---|---|---|
| `list`, `get`, `versions` | read | 0 | none |
| `create` | write | 1 | required |
| `update` (on top of `baseSeq`), `restore` | write | 1 | none |
| `markReviewed` | write | 4 | none |
| `delete` | destructive | 4 | none |

- `markReviewed` lowers taint, so it is tier 4: main confirms the challenge in its own native dialog (2a decision O-4), never a renderer click alone. Tier 4 is the lowest tier with that step; a tier 3 challenge is released by the renderer's `resolve` alone (`packages/challenge` issues the native proof only from tier 4). `delete` is tier 4 too: it destroys every version.
- Refusals are closed: `not_found`, `too_large`, `stale_version`, `limit_reached`, under one fixed message; no stored title or body reaches an error.
- Every row admits only `user` (`RULES` since slice 2); the coverage check holds them at the contract's tiers.
- Attachments have no method yet: their transfer and the sniffing that ADR 0010 requires are PV-Q2's.
- **Store reasons outside the closed set** (`author`, `text`, `exists`, `media_type`) are internal: they mean a daemon bug or a check the contract's schemas already made, and the slice-2 handler answers them as `E_INTERNAL`, never with the reason.

## 3a. What the store does not defend

- **Polyglot images.** The leading-byte check proves only the start of an attachment: a PNG prefix followed by SVG or HTML is stored. No method returns attachment bytes until PV-Q2, whose sniffer and the isolated page view's rules (no SVG, served only from the attachment scheme, never a top-level document) are the defence.
- **Raw SQL.** A writer with the database file can store a title that is not valid UTF-8; SQLite does not check encodings. The daemon writes only through the store, whose values come from the contract's schemas; a same-UID writer is A10.

## 4. Divergences from ADR 0010

| # | ADR 0010 | Here | Why |
|---|---|---|---|
| 1 | "journal database or a store beside it" | the journal database | One transaction for a version and its page; the journal's backup and permissions |
| 2 | No page cap | 500 pages per project | Keeps `list` inside the protocol's message walk; the 200 MiB cap still bounds bytes |
| 3 | No title rule | 1 to 200 characters, the agent-name rule | A title is display text |
| 4 | "the next non-user revision makes the page a source again" | also: a user edit of unreviewed agent text stays a source, and a restore keeps its source's author | Without them a user edit or a restore would launder agent text |
| 5 | `system` not discussed | a `system` version is untrusted | Conservative: only the user's text is trusted |

## 5. Slice 2: the service, the bridge and the page tools

- **Callers, attested.** The bridge serves the user's own desktop connection only: every row admits only `user`, and the handler refuses any other actor and a web client again with `not_found`. A composer run reaches pages only through `read_page` and `write_page`, as its **worker** (the run's recorded worker, PV-G4, while it is not archived), scoped to the worker's project: another project's page is the same `not_found` as an unknown one. No request names an author.
- **`markReviewed` and `delete` are tier 4.** The pipeline runs the handler only after main's native dialog confirmed the challenge with its proof, so a renderer request and its own `resolve` never mark a version reviewed or delete a page (`threat-model-phase2a.md` O-4). They were tier 3 until a fix after slice 2: at tier 3 there is no native step.
- **`read_page`** (tier `read`) is IAC-T source 4. When the version read is untrusted and not reviewed, the binding takes the receipt (source `page`, the latest non-user author still on record, the version's hop, `pageId:seq` as its ref), which raises the run's received hop and taints the run, **before** the text is returned, as `read_messages` does; a read the service refuses takes no receipt. The text is framed by a per-read nonce, escaped with `toMessageText`, every line prefixed `| `, and cut at 65,536 units.
- **`write_page`** (tier `network`, the broker's approval floor) needs the user's approval in every run, as ADR 0010 asks, and IAC-T keeps it so. The card shows the page, the version it edits and the lines that change (`lineChange`: the common head and tail dropped); a write whose card cannot show that whole is refused before any card (`content_not_reviewable`). The worker is the author, at the run's received hop.
- **Audit.** One row per write (`page.create`, `page.update`, `page.restore`, `page.review`, `page.delete`), in the write's transaction, with page and project ids, the sequence number, the caller's and the author's kinds, a byte length and, for a run, its id. Never a title or a body; no keyed hash yet (O-1).
- **Refusals.** The contract's closed reasons pass; any other failure is `E_INTERNAL` without text (the store's own reasons included). For a tool, the reason reaches the model as the call's reason.
- **An archived worker** loses the page tools at its runs' next call: the worker is looked up again at every call (`journalWorkerOf`), not only when the run's tools are built.
- **Residuals.** (1) A page write records the run's received hop with no increment, unlike a message send, so a write-read-write chain between workers through one page never raises the hop; each write is approved by the user, which bounds it. (2) The broker's `broker.decision` and `broker.result` rows carry the call digest, an unkeyed hash over the arguments, page title and body included (as for `write_file` and `send_message`); with no keyed hash yet (O-1), a guessed short body can be confirmed against it by someone who can read the audit log (A10).
- **Cancellation.** A read is synchronous inside the call: the receipt is taken before the call returns, so no cancel or timeout can return the text without it. A cancelled run's call that never ran takes nothing.
