// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import * as path from 'node:path';

// Zero-width and bidi characters that HFS+ ignores when comparing names.
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

/**
 * Mirrors git's verify_path rules for the `.git` name: case-insensitive, HFS
 * ignorables dropped, NTFS trailing dots/spaces and `::$stream` suffixes
 * stripped, and the NTFS short name `git~1`.
 */
export function isGitName(component: string): boolean {
  let s = component.replace(HFS_IGNORABLE, '');
  const colon = s.indexOf(':');
  if (colon !== -1) s = s.slice(0, colon);
  s = s.replace(/[. ]+$/, '').toLowerCase();
  return s === '.git' || s === 'git~1';
}

/** True when any path component, in either separator style, names `.git`. */
export function hasGitComponent(rel: string): boolean {
  return rel.split(/[\\/]+/).some(isGitName);
}

/** A relative path that climbs out of its base (not merely a name starting with "..") . */
export function isOutsideRel(rel: string): boolean {
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}
