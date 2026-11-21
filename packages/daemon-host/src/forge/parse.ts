// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import {
  CC_CS_LS_RANGES,
  CF_RANGES,
  FORGE_BRANCH_CHARS,
  FORGE_LOGIN_CHARS,
  FORGE_MAX_ROWS,
  FORGE_TITLE_CHARS,
  INVISIBLE_RANGES,
  rangesToClass,
  refNameSchema,
  type ForgePullRequest,
  type ForgeRepository,
} from "@axis/protocol";

/**
 * `gh pr list --json` output to rows (docs/design/forge-pr-list.md §5). The output is untrusted: anyone who can open a pull
 * request writes its title and branch name. Three stages, so one odd row cannot deny the list (review 1 SF-4a):
 *   1. outer, strict: one JSON array of at most 50 objects, or `invalid`;
 *   2. per row, lax, the filter FIRST: same repository (`isCrossRepository === false`), head owner equal to the pinned
 *      owner, branch under `axis/`; any other row is dropped whatever else it holds;
 *   3. kept rows, strict: a row that fails is dropped and counted, never fatal.
 * Display text is stripped of controls, format and invisible characters, NFC-normalised and cut with an ellipsis.
 */

const STRIP = new RegExp(`[${rangesToClass([...CC_CS_LS_RANGES, ...CF_RANGES, ...INVISIBLE_RANGES])}]`, "gu");
const ELLIPSIS = "…";

/** Plain display text of at most `max` UTF-16 units plus the ellipsis of a cut; total for any string. */
export function forgeDisplay(raw: string, max: number): string {
  const clean = raw.normalize("NFC").replace(STRIP, "");
  if (clean.length <= max) return clean;
  let out = "";
  for (const cp of clean) {
    if (out.length + cp.length > max) break;
    out += cp;
  }
  return out + ELLIPSIS;
}

const LOGIN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?|app\/[a-z0-9](?:[a-z0-9-]{0,99}))$/;

/** Stage 3: the fields a kept row must hold. Unknown keys are dropped; wrong types refuse the row. */
const keptRowSchema = z.object({
  number: z.number().int().min(1).max(2 ** 31),
  title: z.string().max(1024),
  headRefName: refNameSchema.and(z.string().max(255)),
  author: z.object({ login: z.string().regex(LOGIN) }),
  isDraft: z.boolean(),
  reviewDecision: z.string().max(64).nullable().optional(),
  statusCheckRollup: z.unknown().optional(),
});

const own = (o: object, k: string): unknown => (Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Stage 2: is this row the user's same-repository pull request on an `axis/` branch? Reads three fields only. */
function kept(row: Record<string, unknown>, owner: string): boolean {
  if (own(row, "isCrossRepository") !== false) return false;
  const head = own(row, "headRepositoryOwner");
  const login = isRecord(head) ? own(head, "login") : undefined;
  const branch = own(row, "headRefName");
  return typeof login === "string" && login.toLowerCase() === owner.toLowerCase() && typeof branch === "string" && branch.startsWith("axis/");
}

const ROLLUP_READ = 200;
const FAILING = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const PENDING = new Set(["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED", "EXPECTED"]);

/** One closed value for the checks of a row; at most 200 entries are read (gh asks for at most 100). */
export function reduceChecks(rollup: unknown): ForgePullRequest["checks"] {
  if (rollup === undefined || rollup === null) return "none";
  if (!Array.isArray(rollup)) return "unknown";
  if (rollup.length === 0) return "none";
  let failing = false;
  let pending = false;
  let unknown = false;
  for (const entry of rollup.slice(0, ROLLUP_READ)) {
    const e = isRecord(entry) ? entry : {};
    const conclusion = own(e, "conclusion");
    const status = own(e, "status");
    const state = own(e, "state");
    const v = typeof conclusion === "string" && conclusion !== "" ? conclusion : typeof state === "string" ? state : typeof status === "string" ? status : undefined;
    if (v !== undefined && FAILING.has(v)) failing = true;
    else if (v !== undefined && PENDING.has(v)) pending = true;
    else if (v === undefined || !PASSING.has(v)) unknown = true;
  }
  return failing ? "failing" : pending ? "pending" : unknown ? "unknown" : "passing";
}

const REVIEWS: Readonly<Record<string, ForgePullRequest["review"]>> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "review_required" };

export function reduceReview(decision: string | null | undefined): ForgePullRequest["review"] {
  if (decision === undefined || decision === null || decision === "") return "none";
  return Object.hasOwn(REVIEWS, decision) ? (REVIEWS[decision] as ForgePullRequest["review"]) : "unknown";
}

export type ParsedList =
  | { readonly kind: "ok"; readonly rows: readonly ForgePullRequest[]; readonly incomplete: boolean; readonly invalidRows: number }
  | { readonly kind: "invalid" };

export function parseForgeList(stdout: string, pin: ForgeRepository): ParsedList {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { kind: "invalid" };
  }
  if (!Array.isArray(data) || data.length > FORGE_MAX_ROWS || !data.every(isRecord)) return { kind: "invalid" };
  const rows: ForgePullRequest[] = [];
  let invalidRows = 0;
  for (const raw of data as Record<string, unknown>[]) {
    if (!kept(raw, pin.owner)) continue;
    const r = keptRowSchema.safeParse(raw);
    if (!r.success) {
      invalidRows++;
      continue;
    }
    const v = r.data;
    rows.push({
      number: v.number,
      title: forgeDisplay(v.title, FORGE_TITLE_CHARS),
      branch: forgeDisplay(v.headRefName, FORGE_BRANCH_CHARS),
      author: forgeDisplay(v.author.login, FORGE_LOGIN_CHARS),
      draft: v.isDraft,
      checks: reduceChecks(v.statusCheckRollup),
      review: reduceReview(v.reviewDecision),
      url: `https://github.com/${pin.owner}/${pin.repo}/pull/${v.number}`,
    });
  }
  return { kind: "ok", rows, incomplete: data.length === FORGE_MAX_ROWS, invalidRows };
}
