/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { StringSHA1 } from '../../../../base/common/hash.js';
import { posix, win32 } from '../../../../base/common/path.js';

/*
 * Pure parsers for Phase 0 read-only worktree discovery
 * (docs/design/axis-agent-shell.md section 5.2). They read the files git
 * itself writes: a linked worktree's `.git` file, `<common dir>/worktrees/<name>/
 * {gitdir,HEAD,locked,commondir}`, loose refs and `packed-refs`. Nothing here
 * runs git. Every parser is tolerant: malformed input yields `undefined`, as
 * the git extension's own reader does, and the entry is shown as not present.
 */

/** Largest metadata file read during discovery; git's own files are tiny. */
export const MAX_GIT_METADATA_BYTES = 64 * 1024;

/** Most `<common dir>/worktrees` entries read per project; the rest are counted, not read. */
export const MAX_DISCOVERED_WORKTREES = 200;

/** Longest branch name kept, as the contract's `WorktreeInfo.branch` (`max(256)`). */
export const MAX_BRANCH_LENGTH = 256;

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Control, format (bidi overrides, zero-width) and line-separator characters, as the protocol's name rule. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
/** Private-use and unassigned code points: no meaning a reader can check. */
const OPAQUE_TEXT = /[\p{Co}\p{Cn}]/gu;
/** A third and later combining mark in a row (stacked marks that spill over neighbouring text). */
const MARK_RUN = /(\p{M}{2})\p{M}+/gu;

export type GitHead =
	| { readonly kind: 'ref'; readonly ref: string }
	| { readonly kind: 'detached'; readonly sha: string };

/** Parses the `gitdir: <path>` line of a worktree or submodule `.git` file. */
export function parseGitFile(content: string): string | undefined {
	const line = firstLine(content);
	const match = /^gitdir: (.+)$/.exec(line);
	return match ? match[1] : undefined;
}

/** Parses a `HEAD` file: a symbolic ref or a detached SHA. */
export function parseHead(content: string): GitHead | undefined {
	const line = firstLine(content);
	const ref = /^ref: (refs\/\S+)$/.exec(line);
	if (ref) {
		return { kind: 'ref', ref: ref[1] };
	}
	return SHA.test(line) ? { kind: 'detached', sha: line } : undefined;
}

/** Parses a loose ref file (a SHA on its own line). */
export function parseLooseRef(content: string): string | undefined {
	const line = firstLine(content);
	return SHA.test(line) ? line : undefined;
}

/** Parses `packed-refs` into ref name → SHA. Peeled (`^`) lines and comments are skipped. */
export function parsePackedRefs(content: string): Map<string, string> {
	const refs = new Map<string, string>();
	for (const raw of content.split('\n')) {
		const line = raw.trimEnd();
		if (!line || line.startsWith('#') || line.startsWith('^')) {
			continue;
		}
		const space = line.indexOf(' ');
		const sha = line.slice(0, space);
		const ref = line.slice(space + 1);
		if (space > 0 && SHA.test(sha) && ref.startsWith('refs/')) {
			refs.set(ref, sha);
		}
	}
	return refs;
}

/**
 * The branch name of a `refs/heads/` ref, or `null` for anything else. `HEAD`
 * comes from repository metadata anyone can write, so control, format and bidi
 * characters become U+FFFD (visible, never reordering the row) and the name is
 * cut to the contract's 256 characters.
 */
export function branchOf(head: GitHead | undefined): string | null {
	if (head?.kind !== 'ref' || !head.ref.startsWith('refs/heads/')) {
		return null;
	}
	const name = head.ref.slice('refs/heads/'.length, 'refs/heads/'.length + MAX_BRANCH_LENGTH * 2);
	return clampText(name.replace(UNSAFE_TEXT, '\uFFFD').replace(OPAQUE_TEXT, '\uFFFD').replace(MARK_RUN, '$1'), MAX_BRANCH_LENGTH);
}

/** Cuts text to at most `max` code points, ending with an ellipsis when it was longer. */
export function clampText(value: string, max: number): string {
	const points = [...value];
	return points.length <= max ? value : points.slice(0, max - 1).join('') + '\u2026';
}

/** True for a ref name that is safe to turn into a path under the git dir. */
export function isSafeRefName(ref: string): boolean {
	return /^refs\/[A-Za-z0-9._\/-]+$/.test(ref) && !ref.split('/').some(segment => segment === '' || segment === '.' || segment === '..' || segment.endsWith('.lock'));
}

/**
 * Resolves a path read from git metadata. Git writes absolute paths, or, with
 * `worktree.useRelativePaths`, paths relative to the file's own directory,
 * whose only `..` components come first. A `.` or `..` anywhere else (any in
 * an absolute path, or one after a name) is refused rather than normalised:
 * after a link, `x/..` is not where a lexical resolver says it is.
 */
export function resolveMetadataPath(value: string, baseDir: string, windows: boolean): string | undefined {
	const path = windows ? win32 : posix;
	const absolute = path.isAbsolute(value);
	let afterName = false;
	for (const part of value.split(windows ? /[\\/]/ : '/')) {
		if (part === '.' || part === '..') {
			if (absolute || afterName) {
				return undefined;
			}
		} else if (part !== '') {
			afterName = true;
		}
	}
	return absolute ? path.normalize(value) : path.resolve(baseDir, value);
}

/**
 * The worktree directory named by a `<common dir>/worktrees/<name>/gitdir` file
 * (it names `<worktree>/.git`). The result is only a claim: the caller must
 * check that `<worktree>/.git` points back (`linksBack`) before using it.
 */
export function worktreeDirFromGitdir(gitdirContent: string, entryDir: string, windows: boolean): string | undefined {
	const line = firstLine(gitdirContent);
	if (!line) {
		return undefined;
	}
	const path = windows ? win32 : posix;
	const dotGit = resolveMetadataPath(line, entryDir, windows);
	return dotGit && path.basename(dotGit) === '.git' ? path.dirname(dotGit) : undefined;
}

/**
 * True when a worktree's `.git` file content (`gitdir: <path>`, relative to the
 * worktree) names `adminDir`, the `<common dir>/worktrees/<name>` entry it was
 * found from. Git links both ways; a `gitdir` that names a folder whose `.git`
 * does not point back is not a worktree of this repository and is refused.
 */
export function linksBack(dotGitContent: string, worktreeDir: string, adminDir: string, windows: boolean): boolean {
	const line = parseGitFile(dotGitContent);
	if (!line) {
		return false;
	}
	const path = windows ? win32 : posix;
	const target = resolveMetadataPath(line, worktreeDir, windows);
	if (!target) {
		return false;
	}
	const expected = path.normalize(adminDir);
	return windows ? target.toLowerCase() === expected.toLowerCase() : target === expected;
}

/**
 * The `core.worktree` value of a git `config` file, or `undefined`. Git writes
 * it for a submodule's git dir (`.git/modules/<name>`), naming the
 * submodule's work tree relative to the git dir. Only the simple forms git
 * itself writes are read: a `[core]` section and a `worktree = <path>` line,
 * optionally quoted.
 */
export function parseCoreWorktree(config: string): string | undefined {
	let inCore = false;
	let value: string | undefined;
	for (const raw of config.split('\n')) {
		const line = raw.trim();
		const section = /^\[\s*([A-Za-z0-9.-]+)\s*(?:"[^"]*")?\s*\]/.exec(line);
		if (section) {
			inCore = section[1].toLowerCase() === 'core' && !line.includes('"');
			continue;
		}
		const entry = inCore ? /^worktree\s*=\s*(.*)$/i.exec(line) : null;
		if (entry) {
			const text = entry[1].trim();
			const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(text);
			value = quoted ? quoted[1].replace(/\\(.)/g, '$1') : text.replace(/\s[;#].*$/, '');
		}
	}
	return value || undefined;
}

/** A display name for a project or workspace that fits the contract's name rules. */
export function displayName(value: string): string {
	const cleaned = value.replace(UNSAFE_TEXT, '').replace(OPAQUE_TEXT, '\uFFFD').replace(MARK_RUN, '$1').trim();
	return clampText(cleaned || 'unnamed', 80);
}

/** A contract-shaped id (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`): a prefix and 128 bits of the key's SHA-1. */
export function stableId(prefix: string, key: string): string {
	const sha = new StringSHA1();
	sha.update(key);
	return `${prefix}-${sha.digest().slice(0, 32)}`;
}

function firstLine(content: string): string {
	const newline = content.indexOf('\n');
	return (newline === -1 ? content : content.slice(0, newline)).replace(/\r$/, '').trim();
}
