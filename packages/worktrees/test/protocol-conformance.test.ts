// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ERROR_CODES, projectIdSchema, workspaceIdSchema, workspaceNameSchema, workspaceStateSchema,
} from '@axis/protocol';
import { SLUG_PATTERN, WorkspaceMetaSchema, type WorktreeErrorCode } from '../src/index.js';

describe('axis.worktrees/1 alignment', () => {
  it('only uses error codes from the protocol set', () => {
    const codes: WorktreeErrorCode[] = ['E_INVALID_ARGUMENT', 'E_NOT_FOUND', 'E_CONFLICT', 'E_POLICY_DENIED', 'E_INTERNAL'];
    for (const c of codes) assert.ok((ERROR_CODES as readonly string[]).includes(c), c);
  });

  it('uses the protocol workspace states and id grammar', () => {
    const states = WorkspaceMetaSchema.shape.state.options;
    for (const s of states) assert.ok(workspaceStateSchema.safeParse(s).success, s);
    assert.ok(workspaceIdSchema.safeParse('ws-0123456789abcdef').success);
    assert.ok(projectIdSchema.safeParse('p_1').success);
    assert.equal(workspaceIdSchema.safeParse('a/b').success, false);
  });

  it('derives slugs that satisfy the protocol name rule', () => {
    assert.ok(SLUG_PATTERN.test('fix-login'));
    assert.ok(workspaceNameSchema.safeParse('fix-login').success);
  });
});
