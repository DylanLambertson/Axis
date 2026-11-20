// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Sample } from "./suite.js";

export const HEAD = "a".repeat(40);
export const CID = "c".repeat(64);
export const FID = (n: number): string => n.toString(16).repeat(64);

export const textFile = {
  fileId: FID(1),
  displayPath: ".github/workflows/ci.yml",
  protectedPath: true,
  protectedRules: ["ci-workflow"],
  contentId: CID,
  view: { kind: "text", size: 40, lines: 3, first: ["on: push", "\tjobs: {}", "echo \\u{1b}[31m \\\\ \\xff"], last: [], omittedLines: 0, cutLines: 0, finalNewline: true },
};
export const longText = {
  fileId: FID(2),
  displayPath: "src/long.ts",
  protectedPath: false,
  protectedRules: [],
  contentId: CID,
  view: { kind: "text", size: 900_000, lines: 1000, first: ["a", "b"], last: ["y", "z"], omittedLines: 996, cutLines: 1, finalNewline: false },
};
export const tooLarge = {
  fileId: FID(3),
  displayPath: "data/huge.csv",
  displayOldPath: "data/old.csv",
  protectedPath: false,
  protectedRules: [],
  contentId: CID,
  view: { kind: "too-large", size: 2_000_000, objectPrefix: "0123456789ab", first: ["id,name"], last: ["9,nine"], readComplete: true, cutLines: 0 },
};
export const binary = { fileId: FID(4), displayPath: "img/logo.png", protectedPath: false, protectedRules: [], contentId: CID, view: { kind: "binary", size: 1234, objectPrefix: "fedcba987654" } };
export const link = { fileId: FID(5), displayPath: "docs/link", protectedPath: false, protectedRules: [], contentId: CID, view: { kind: "symlink", target: "../../etc/passwd", targetCut: false, escapesWorktree: true } };
export const gitlink = { fileId: FID(6), displayPath: "vendor/lib", protectedPath: false, protectedRules: [], contentId: CID, view: { kind: "submodule", commit: "b".repeat(40) } };
export const deleted = { fileId: FID(7), displayPath: "old.txt", protectedPath: false, protectedRules: [], contentId: CID, view: { kind: "deleted" } };
export const unavailable = { fileId: FID(8), displayPath: "secret.env", protectedPath: false, protectedRules: [], contentId: null, view: { kind: "unavailable", reason: "filtered" } };

export const contentResponse = { head: HEAD, files: [textFile, longText, tooLarge, binary, link, gitlink, deleted, unavailable], notFound: [] as string[] };

export const REVIEW_CONTENT_SAMPLES: readonly Sample[] = [
  { contract: "axis.review", method: "content", side: "request", name: "one file", value: { workspaceId: "ws-1", fileIds: [FID(1)] } },
  { contract: "axis.review", method: "content", side: "request", name: "eight files", value: { workspaceId: "ws-1", fileIds: [1, 2, 3, 4, 5, 6, 7, 8].map(FID) } },
  { contract: "axis.review", method: "content", side: "response", name: "every view", value: contentResponse },
  { contract: "axis.review", method: "content", side: "response", name: "nothing found", value: { head: "c".repeat(64), files: [], notFound: [FID(9)] } },
];
