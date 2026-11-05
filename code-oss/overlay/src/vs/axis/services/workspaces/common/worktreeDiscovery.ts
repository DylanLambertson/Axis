/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

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

/** Most linked worktrees listed per project (the contract's list limit). */
export const MAX_DISCOVERED_WORKTREES = 1000;

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

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

/** The branch name of a `refs/heads/` ref, or `null` for anything else. */
export function branchOf(head: GitHead | undefined): string | null {
	if (head?.kind !== 'ref' || !head.ref.startsWith('refs/heads/')) {
		return null;
	}
	return head.ref.slice('refs/heads/'.length);
}

/** True for a ref name that is safe to turn into a path under the git dir. */
export function isSafeRefName(ref: string): boolean {
	return /^refs\/[A-Za-z0-9._\/-]+$/.test(ref) && !ref.split('/').some(segment => segment === '' || segment === '.' || segment === '..' || segment.endsWith('.lock'));
}

/**
 * Resolves a path read from git metadata. Git writes absolute paths, or, with
 * `worktree.useRelativePaths`, paths relative to the file's own directory.
 */
export function resolveMetadataPath(value: string, baseDir: string, windows: boolean): string {
	const path = windows ? win32 : posix;
	return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

/** The worktree directory named by a `<common dir>/worktrees/<name>/gitdir` file (it names `<worktree>/.git`). */
export function worktreeDirFromGitdir(gitdirContent: string, entryDir: string, windows: boolean): string | undefined {
	const line = firstLine(gitdirContent);
	if (!line) {
		return undefined;
	}
	const path = windows ? win32 : posix;
	const dotGit = resolveMetadataPath(line, entryDir, windows);
	return path.basename(dotGit) === '.git' ? path.dirname(dotGit) : undefined;
}

/** A display name for a project or workspace that fits the contract's name rules. */
export function displayName(value: string): string {
	// Control, format (bidi, zero-width) and line-separator characters, as the protocol's name rule.
	const cleaned = value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').trim();
	return (cleaned || 'unnamed').slice(0, 80);
}

/** A contract-shaped id (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`) derived from a prefix and a stable hash. */
export function stableId(prefix: string, hash: number): string {
	return `${prefix}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function firstLine(content: string): string {
	const newline = content.indexOf('\n');
	return (newline === -1 ? content : content.slice(0, newline)).replace(/\r$/, '').trim();
}
