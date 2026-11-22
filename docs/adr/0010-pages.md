# ADR 0010: Pages

- **Status:** Proposed. Becomes Accepted when the Phase 2a pages gate lines in `docs/design/extensibility.md` §9 pass. The decisions it records (D-5, D-6, D-13) were delegated by the owner to the project lead on 2026-11-21 and are recorded in `docs/design/owner-decisions-2026-11-21.md`; the owner can reverse any of them there.
- **Date:** 2026-11-21.
- **Decision owner:** Dylan Lambertson.
- **Depends on:** ADR 0003 (Electron IPC bridge: the renderer is the user's client, A10) and ADR 0006 (agent home information architecture: a Pages destination on the rail and a Pages section on the project home from 2a).
- **Changes no earlier decision.** It adds a rendering surface and a storage location; ADR 0003's principal rules and ADR 0004's approval rules stand.
- **Related:** `docs/design/extensibility.md` §5 (the page design this ADR decides), §8 (PAG-1 to PAG-3), §9 (2a gate lines); `docs/design/inter-agent-communication.md` §6.5 to §6.7 (the taint rule), §7.2 (hop); `docs/design/product-vision-v2-tickets.md` (PV-Q1, which builds this).
- **Evidence tags:** **[V]** verified in an existing Axis document; **[I]** inferred, not verified.

## Context

The owner wants pages: project documents that the user and agents write and read, shown inside Axis (`product-vision-v2.md` §1). `extensibility.md` §5 proposes the design. It leaves four things for an ADR: where pages live, what format they have, how they are shown, and what an agent may do with them.

Two facts shape every answer:

- **The renderer is the user's client (A10).** Under ADR 0003 every call from the renderer is the actor `user`. Script that runs in the renderer can call `axis.approvals/1.resolve` as the user [V, `extensibility.md` §5]. A page written by an agent and shown in the renderer is therefore an attack on the approval gate if its content can ever execute.
- **A page is text the user did not necessarily write, and an agent can read it.** That makes it a prompt-injection path and a relay path between agents (`inter-agent-communication.md` §6.6, §7.2).

## Decisions

### 1. Storage (D-5)

- Pages live in the **Axis data directory, per project**, in the journal database or in a store beside it [I: which of the two is decided in PV-Q1 against the journal's size and backup rules]. They are **not** stored in the repository.
- **Reason:** a file in the repository exists once per branch, so every agent worktree would hold its own copy and the copies would diverge. A page belongs to the project, not to a branch.
- **Export to repository** is a user action that writes one page as a Markdown file into a chosen workspace. The file then goes through the normal Changes review (A5) like any other change. Export is one way: a file in the repository is never read back as a page.
- Every save keeps a **version** (bounded count, set in PV-Q1). Each version records its author (the user, or an agent id), its time and, for a non-user author, the **hop** of the writing run. Restore is a user action. Deleting a page removes its versions and attachments with it.
- Audit holds page id, version, actor, length and a keyed hash. It never holds page text.

### 2. Format (D-6)

- **Markdown, a CommonMark subset, in v1.** No raw HTML, no script, no iframes, no remote images. No other format in v1.
- Links follow the EL-5 rules: `http`, `https` and `mailto` only; a `file:` link is refused; the full URL is shown for a link in content written by an agent. A link is never opened without a user click.
- A page may reference attachments (below) and, as typed references, other pages, tasks, files and runs. A reference is data, not a grant (`inter-agent-communication.md` §5.3).

### 3. Rendering (D-13)

- A page, and any rendered-Markdown view of a message body, is shown in an **isolated page view**: a sandboxed view with an **opaque origin and no bridge port**. It has no connection to the daemon at all, so there is nothing for page script to call. The Agent view renderer only hosts it. This is the control for PAG-3.
- Inside the view: the upstream Markdown renderer and a **pinned sanitizer**, with **Trusted Types enforced** (`require-trusted-types-for 'script'`). The sanitizer is defence in depth; the missing port is the control, because a sanitizer bypass (mutation XSS) must still not reach the approval gate.
- **CSP as a response header**, from the protocol handler that serves the view (a meta tag can be removed). It follows the header CSP of `extensibility.md` §3.3 with one change: `img-src` is limited to the **attachment scheme**, with no `data:` source. The header sets `default-src 'none'`, `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `frame-src 'none'`, `frame-ancestors 'none'`. Navigation and window open are denied in main, so a link is handed to the host, which applies EL-5 and asks the user.
- **Attachments: raster images only** (PNG, JPEG, GIF, WebP), decided by **content sniffing**, not by file name or declared type. **SVG is refused**, and so is every other format, including a file named `.png` that sniffs as HTML. Size and count caps are set in PV-Q1. Attachments are served **only from the attachment scheme**, and never opened as top-level documents. Rasterising SVG is a later decision, not v1.
- A rendering failure shows the page as escaped plain text, never as a partly sanitised document.

### 4. Agent access

- **Composer agents only in 2a.** CLI agents have no page access in 2a [V, `extensibility.md` §5].
- **`read_page`** is a tier-0 read. Reads of a page are bounded in size and returned as data with the author of each revision.
- **`write_page`** needs the user's approval by default and is attributed to the agent. It is side-effecting under `inter-agent-communication.md` §6.5, so it needs approval whenever the run is tainted, whatever the user's floor. The approval card shows the page, the diff against the current version, and the run's taint sources. The user's policy tier can lower the default for a trusted run, and the taint rule can then only raise it again.
- **A page is a taint source** (source 4 of the closed list, `page` in `TAINT_SOURCES`). `read_page` taints the run when the page's **current content contains text from any non-user revision** that the user has not explicitly marked reviewed. A later user edit elsewhere on the page does not clear it, because the agent's text is still there. The flag is sticky for the run (§6.6). A page whose every revision is the user's is not a source.
- **Marking reviewed** is a user action on one version. It is recorded in the audit and applies to that version only; the next non-user revision makes the page a source again.
- **Hop.** Each non-user revision records the hop of the run that wrote it, the highest hop that run had received through any taint source. A page relay therefore counts toward the hop limit of 8 (§7.2).
- **No other access.** An agent cannot create attachments, delete a page, restore a version, mark a version reviewed or export a page in 2a. These are user actions. A page cannot grant an agent any permission, whatever its text says.

## Options considered

| Option | Reason it lost |
|---|---|
| Pages as files in the repository | One copy per branch and per agent worktree; copies diverge. Export covers the case where a page belongs in the code. |
| Rendering in the Agent view renderer behind a sanitizer alone | One sanitizer bypass would let an agent approve its own request as the user (A10). |
| Allow SVG attachments | SVG carries script and external references; sniffing it safely is a larger problem than the feature is worth in v1. |
| Treat pages as untainted when the user opens them | The agent reads what is stored, not what the user saw. |

## Consistency with the other documents

- **ADR 0006:** the rail gains Pages and the project home gains a Pages section in 2a, and only when 2a ships (no "coming soon" entry). Both open the page view described here; neither renders page text itself.
- **Threat text** (`extensibility.md` §8): PAG-1 (script or tracking in a page) is met by §2 and §3 above; PAG-2 (page content steers an agent) by §4; PAG-3 (page script reaches the bridge) by §3. The gate lines in §9 test each.
- **`inter-agent-communication.md`:** `page` stays source 4 of the closed list and the `page` reference type stays data. Nothing in this ADR adds a source.
- **`PRODUCT.md` and `UX.md`:** pages are text-first and dense, with no sample content and no metric walls. A page is a document the user reads, so it has no live data.

## Security implications

- The page view has no daemon connection, so a rendering bug cannot approve, write or run anything. The remaining harm is bounded to the view: wrong rendering, or a link the user clicks.
- Stored pages are data in the Axis data directory with the journal's file permissions; they are not backed up into the repository unless the user exports one.
- A page can carry a prompt injection. The control is the taint rule, not the sanitizer.

## Validation criteria

Accept this ADR when the 2a pages gate lines in `extensibility.md` §9 pass and PV-Q1 shows:

1. A page with raw HTML, a script tag, an `onerror` attribute or a remote image renders inert; a `file:` link is refused.
2. A mutation-XSS corpus page cannot reach the bridge: no port exists, and a probe calling `axis.approvals/1.resolve` from the page view fails.
3. An SVG attachment, and a PNG-named file that sniffs as HTML, are refused.
4. `read_page` of a page with an agent revision sets the run's taint; a user edit afterwards still leaves it set; a user-marked-reviewed version does not.
5. `write_page` by a composer run needs approval, is attributed to the agent id, and records the hop.
6. No page file appears in any repository unless the user exports it.

**Revisit** if the owner reverses D-5, D-6 or D-13, if the sanitizer or the upstream renderer cannot run under Trusted Types, or if a later phase needs rich content (then rasterised SVG or a second format is a new decision).

## Rollback

Before 2a ships, revert this ADR and the documents that cite it; no code depends on it. After 2a, pages are records behind a contract; disabling the page view leaves them stored and unreadable by agents.

## Tickets this unblocks

PV-Q1 (the page store, versions, `axis.pages/1`, `read_page` and `write_page`), and the page view and attachment scheme work it names.
