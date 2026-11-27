# Plugin packages: acceptance tests and mutants (ticket PV-K2, package part)

- **Status:** design only, not built. Date 2026-11-27. The test plan of `plugin-install.md`, per slice of its section 8; section
  numbers below are that note's.

Every refusal suite includes a valid control input that passes, so a component that refuses everything fails.
- **K2-p1:**
  - every manifest rule refused in isolation;
  - SemVer order (`1.0.0-2` < `1.0.0-10` < `1.0.0`), leading zeros refused, safe-integer bounds;
  - the RFC 8785 vectors inside the profile, plus duplicate key, lone surrogate, float, depth and size refusals;
  - a signature moved to another id, version, tier, permission set or bundle fails (4a/L16);
  - an independently framed vector kills a dropped prefix or NUL;
  - one bundle hash across two archives differing in order, compression and timestamps, and a different one for a one-byte
    change;
  - lists with a lower version, an unknown key, a bad signature, a duplicate `(id, version)`, or past `notAfter` refused (4a/L4);
  - mutants: the domain prefix, a separator, the tier left out of the message, the version comparison flipped, `notAfter`
    ignored, duplicate-key detection off.
- **K2-p2:**
  - one archive per refusal of §4.2 to §4.4, colons, stream names, reserved names and file and folder prefix conflicts included
    (4a/L5, 4a/L15), each leaving nothing outside the staging directory;
  - a lying declared size stopped at the cap;
  - overlapped, prepended and data-descriptor archives refused;
  - an executable bit never applied;
  - the seeded fuzz test;
  - mutants: each check removed, caps on declared sizes, the exclusive flag dropped, the CRC check off.
- **K2-p3:**
  - the `STRICT` tables' insert and trigger rules;
  - the list version never going down across restarts;
  - `not_requested` before the dialog and under the lock (a request removed while a grant is open refuses it);
  - the binding refusing after a revision change (a start approved and waiting under the mutex during an update);
  - an approved but unspent user grant and an approved but unspent enable, each refused after a package-only update that keeps
    the permission requested, and after an uninstall and reinstall;
  - the listing stored with the package, its hash checked on read, and a row whose identity exists with other fields refused;
  - persisted audit rows with the scalar encodings, never manifest text;
  - mutants: the recheck at the write removed, the revision left out of `valid()`, the allowlist entry missing.
- **K2-i1:**
  - install end to end through the supervisor (installed, disabled, no grants, the files at the identity path);
  - reinstall after uninstall reusing the retained row, generation kept, and an older package refused without downgrade, while
    v2, uninstall, then a confirmed downgrade to v1 succeeds;
  - one bundle with two different manifests (or unsigned against curated) in projects A and B: two packages, A unchanged, B gets
    exactly what it confirmed;
  - a commit with a stale, reused, expired, other-generation or wrong-digest `stagingId`, or a stale baseline, refused;
  - the source archive replaced after inspection never changes what is committed;
  - every row of §5.4's fault table at its point, two concurrent installs of one identity, and collection racing a publication;
  - review 3: rename ok, parent fsync fails, a same-daemon retry reuses, commits, then a crash and recovery find the package
    durable and referenced; an adoption whose parent fsync fails again is refused with no row; both folders fsynced after a
    quarantine move;
  - review 3: projects A and B commit concurrently while A's check finds the shared package corrupt: both finish (no deadlock),
    B is disabled only if it still points at the identity at the same revision, loads return nothing while it is suspect, and a
    noncorrupt control completes with nothing disabled;
  - review 3: a slow package lock (a held collection batch) does not delay a revoke or a disable past its budget, and a commit
    waiting past 5 s answers `busy` and revalidates on retry;
  - review 3: the complete persisted event sequence of an automatic integrity failure (§6.3), with no user-attributed row;
  - after a restart, a valid package loads, and extra, missing, oversized and swapped files are refused from the stored listing;
  - an existing identity directory with corrupted content is quarantined, not reused;
  - `verifyInstalled`:
    - each failure of §5.6 (an oversize replacement, an added tree, a link or cycle, a file growing during the read, a swapped
      file) takes the disable path;
    - only the checked buffers are served;
  - abort, expiry, window close and generation change clean staging up;
  - a repository file or workspace setting that names a plugin installs and enables nothing, and shows the notice (4a/L6);
  - an expired or refused list blocks curated installs, while installed curated plugins load with the warning and unsigned local
    installs are unchanged (4a/L12);
  - mutants: the baseline check, single use, the digest check, publication after the commit, the package lock or a pin dropped,
    collection without the recheck, the quarantine path, each read cap.
- **K2-i2:**
  - every update shows the dialog, an empty diff included (4a/L26);
  - two projects, A and B, on v1 with grants: an update or uninstall in A leaves B's version, requests, grants and package
    directory alone;
  - a zero-permission installation installs, updates and uninstalls;
  - an update of an enabled, granted installation keeps exactly the intersection of the old grants and the new requests;
  - every unspent challenge ended, an approved-unspent one included;
  - a curated downgrade to a listed version succeeds, and to an unlisted one is refused;
  - a curated key change and a curated-to-unsigned update are blocked;
  - mutants: the empty-diff dialog skipped, removed grants retained, added requests granted, the key comparison removed, the
    revision rise skipped.
- **All slices:** the K2-g3 writer rule stays green with the package files in place, and a test shows install and update leave
  `plugin_grants` unchanged for added requests.
