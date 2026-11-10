// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { matchProtected } from "@axis/broker";
import type { ProtectedPathMatcher } from "@axis/review";

/**
 * The WT-3 rules the broker enforces on a composer write, as the review's matcher: a path the broker would gate is the
 * path the diff flags. Segments are split on `/` and `\`, empty and `.` segments dropped, and the broker folds each one
 * (case, compatibility forms, default-ignorable code points, trailing dots and spaces, 8.3 short names). A `..` segment
 * cannot occur in a repository path (the review marks it unsafe); it is kept as a segment, never resolved. The label is
 * the rule name shown to the user; a Git directory is `.git`.
 */
export const brokerProtectedPaths: ProtectedPathMatcher = {
  match: (path) => {
    const hit = matchProtected(path.split(/[\\/]+/).filter((s) => s !== "" && s !== "."));
    return hit === undefined ? [] : [{ rule: hit.label }];
  },
};
