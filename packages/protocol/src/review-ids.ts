// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";

/** Longest display path in an `axis.review/1` reply (UTF-16 units of the escaped text). */
export const MAX_REVIEW_PATH = 256;

/**
 * Names a file within one review. Minted by the host: the SHA-256, in lower-case hex, of the UTF-8 encoding of the repository
 * path as the host DECODED it (`ReviewFile.path`), never of the display string. The host has the path as a string, not as raw
 * bytes, so two different byte paths that decode to the same string would share an id: a path that does not decode as strict
 * UTF-8 (it holds U+FFFD) is therefore `unsafePath` (`not_utf8`), which blocks the tree, and the handler folds entries with
 * equal path strings into one row instead of listing equal ids. Among files that can be committed an id is unique within a
 * response. Two files can show the same `displayPath` (a cut in the middle of long paths) but never the same `fileId`.
 * It is an identity, not a secret.
 */
export const fileIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The content AND mode binding of an acknowledgement: the SHA-256, in lower-case hex, of the string
 * `<newMode> <newOid>` (for example `100644 3b18e5...`), where mode and oid are the file's entry in the SNAPSHOT TREE the
 * `treeHash` is built from (for a symlink, mode `120000` and the blob of its target). An object id hashes bytes only, so
 * the mode is part of the binding: the same bytes made executable (`100755`) or turned into a symlink (`120000`) give a
 * different `contentId`, and an acknowledgement of one does not carry to the other. A WT-3 protected file hashes
 * `<newMode> <newOid> protected`. In a `diff` reply only a `truncated` file has one; `content` gives one for every file it shows.
 */
export const contentIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
