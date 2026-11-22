# The pages store and `axis.pages/1` (PV-Q1 slice 1)

- **Status:** Built (slice 1): journal schema version 14, `Journal.pages`, and the **planned** contract `axis.pages/1` with user-only planned policy rows. Nothing is served yet.
- **Decides nothing new.** It builds ADR 0010 decisions 1 and 4 and the 2a threat model's decision O-4 (`docs/security/threat-model-phase2a.md` §6).
- **Code:** `packages/journal/src/schema-pages.ts` (the tables), `packages/journal/src/page-store.ts` (the store), `packages/protocol/src/pages.ts` (the contract), `packages/daemon-host/src/policy/planned.ts` (the rows).
- **Later slices:** the pages service and its handlers (served rows, audit with keyed hashes, the native confirmation for marking reviewed); the composer tools `read_page` (taint source 4) and `write_page` (approval) after PV-G3; the isolated page view, attachment transfer and content sniffing, and Export to repository (PV-Q2); plugin rows (ADR 0008 `pages.read`, `pages.write`, PV-K).

## 1. Tables (schema version 14)

| Table | Holds | Rules |
|---|---|---|
| `pages` | One row per page: project, the number of its newest version, times | At most 500 per project. Id, project and creation time fixed. `last_seq` always equals its newest version's number |
| `page_versions` | Every save: title, body, author, hop, trust flags, origin, time | Never changed after insert, except a one-time reviewed mark on an untrusted version. Numbers count up from 1 with no gap. The 101st version deletes the oldest in the same statement; no other version is deleted while its page exists |
| `page_attachments` | Raster images of a page | PNG, JPEG, GIF or WebP, the type checked against the leading bytes; at most 20 per page, 5 MiB each; added by the user only; never changed |

- **Insert once.** Every table refuses an insert of an existing key. The guard fires before any conflict clause, so `INSERT OR REPLACE`, `REPLACE`, `INSERT OR IGNORE` and every `ON CONFLICT` form abort too; the tests try each verb on each table.
- **NUL.** SQLite's text functions and `GLOB` stop at a NUL byte. ASCII columns (ids, times, hashes) check that their byte length equals their character length; titles and bodies refuse a NUL byte through their blob form.
- **Limits** (ADR 0010 decision 1): body 256 KiB of UTF-8, title 1 to 200 characters under the agent-name rule (`NAME_REFUSED_RANGES`), 200 MiB of version and attachment bytes per project. A write over a limit is refused, never cut.
- **Delete.** Deleting a page deletes its versions and attachments in the same statement.

## 2. Authors and trust

- **Author** is a closed set: `user`, `agent` (an agent id), `plugin` (a plugin id of at most 64 characters, ADR 0008) or `system`. No request carries it: the daemon takes it from the attested caller.
- **`untrusted`** marks a version that may hold text the user did not write. Every non-user version is untrusted, `system` included. A user edit of an untrusted, unreviewed version stays untrusted and keeps its hop, because the earlier text is still there (ADR 0010 decision 4); once the user marks a version reviewed, the next user edit is trusted again.
- **Hop.** A non-user version records the hop of the writing run; an untrusted user edit inherits it; a trusted version has hop 0.
- **Restore** copies its source version: title, body, author, hop and `untrusted`, and records `restored_from`. Restoring an agent's text never makes it the user's, and the reviewed mark is not copied.
- **Derived twice.** The store derives these values itself, and the table's triggers check them against the version before, so no writer can store a page as more trusted than it is.
- **What a reader receives.** `readTaint(pageId)` answers whether the current version is a taint source and at which hop; the taint producer of `read_page` uses it.

## 3. The planned contract

| Method | Side effect | Tier | Idempotency |
|---|---|---|---|
| `list`, `get`, `versions` | read | 0 | none |
| `create` | write | 1 | required |
| `update` (on top of `baseSeq`), `restore` | write | 1 | none |
| `markReviewed` | write | 3 | none |
| `delete` | destructive | 3 | none |

- `markReviewed` lowers taint, so it is tier 3: the challenge is resolved in main's native dialog (2a decision O-4), never by a renderer click alone.
- Refusals are closed: `not_found`, `too_large`, `stale_version`, `limit_reached`, under one fixed message; no stored title or body reaches an error.
- Every row admits only `user` (`PLANNED_RULES`); the coverage check holds them at the contract's tiers.
- Attachments have no method yet: their transfer and the sniffing that ADR 0010 requires are PV-Q2's.

## 4. Divergences from ADR 0010

| # | ADR 0010 | Here | Why |
|---|---|---|---|
| 1 | "journal database or a store beside it" | the journal database | One transaction for a version and its page; the journal's backup and permissions |
| 2 | No page cap | 500 pages per project | Keeps `list` inside the protocol's message walk; the 200 MiB cap still bounds bytes |
| 3 | No title rule | 1 to 200 characters, the agent-name rule | A title is display text |
| 4 | "the next non-user revision makes the page a source again" | also: a user edit of unreviewed agent text stays a source, and a restore keeps its source's author | Without them a user edit or a restore would launder agent text |
| 5 | `system` not discussed | a `system` version is untrusted | Conservative: only the user's text is trusted |
