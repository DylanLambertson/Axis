/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { readEventBody, readServerFrame, readSubscribeReply } from '../../common/axisEventFrames.js';
import { endFrame, eventFrame, reply, resyncFrame, SUB } from './axisEventFixtures.js';

suite('Axis event frames', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every event body of the contract is read, and only those', () => {
		assert.deepStrictEqual(readEventBody({ topic: 'workspaces', workspaceId: 'ws-a' }), { topic: 'workspaces', workspaceId: 'ws-a' });
		assert.deepStrictEqual(readEventBody({ topic: 'runs', runId: 'run-1' }), { topic: 'runs', runId: 'run-1' });
		assert.deepStrictEqual(readEventBody({ topic: 'runs', runId: 'run-1', state: 'BLOCKED' }), { topic: 'runs', runId: 'run-1', state: 'BLOCKED' });
		assert.deepStrictEqual(readEventBody({ topic: 'approvals' }), { topic: 'approvals' });
		assert.deepStrictEqual(readEventBody({ topic: 'anchor', stalled: true }), { topic: 'anchor', stalled: true });
		assert.deepStrictEqual(readEventBody({ topic: 'audit', headSeq: 7 }), { topic: 'audit', headSeq: 7 });
	});

	test('a body with an unknown field (a path, a name) is rejected whole', () => {
		for (const body of [
			{ topic: 'workspaces', workspaceId: 'ws-a', path: '/work/x' },
			{ topic: 'runs', runId: 'run-1', name: 'x' },
			{ topic: 'approvals', challengeId: 'c1' },
			{ topic: 'anchor', stalled: false, detail: 'x' },
			{ topic: 'audit', headSeq: 1, payload: {} },
		]) {
			assert.strictEqual(readEventBody(body), undefined, JSON.stringify(body));
		}
	});

	test('a body with a missing or mistyped field, a bad id or an unknown topic or state is rejected', () => {
		for (const body of [
			{ topic: 'workspaces' }, { topic: 'workspaces', workspaceId: 5 }, { topic: 'workspaces', workspaceId: '/etc/x' },
			{ topic: 'workspaces', workspaceId: 'ws\u0000a' }, { topic: 'workspaces', workspaceId: 'ws a\n' }, { topic: 'workspaces', workspaceId: '' },
			{ topic: 'runs', runId: 'run-1', state: 'DONE' }, { topic: 'runs', runId: 'run-1', state: undefined }, { topic: 'runs', state: 'RUNNING' },
			{ topic: 'anchor', stalled: 'yes' }, { topic: 'audit', headSeq: -1 }, { topic: 'audit', headSeq: 1.5 }, { topic: 'audit', headSeq: Number.NaN },
			{ topic: 'other' }, { workspaceId: 'ws-a' }, null, 'x', [], 5,
		]) {
			assert.strictEqual(readEventBody(body), undefined, JSON.stringify(body));
		}
		assert.strictEqual(readEventBody(Object.create({ topic: 'approvals' })), undefined);
		class Impostor { topic = 'approvals'; }
		assert.strictEqual(readEventBody(new Impostor()), undefined);
	});

	test('frames: event, resync and end are read; version, sub, seq and extra keys are checked', () => {
		assert.deepStrictEqual(readServerFrame(eventFrame(5, { topic: 'runs', runId: 'run-1' })), { kind: 'event', sub: SUB, seq: 5, event: { topic: 'runs', runId: 'run-1' } });
		assert.deepStrictEqual(readServerFrame(resyncFrame(9)), { kind: 'resync', sub: SUB, seq: 9 });
		assert.deepStrictEqual(readServerFrame(endFrame()), { kind: 'end', sub: SUB });
		for (const frame of [
			{ ...eventFrame(5), v: 2 }, { ...eventFrame(5), sub: 'short' }, { ...eventFrame(5), sub: 'sub/AAAAAAAAAAAAAAAAAAAAAA' },
			{ ...eventFrame(5), seq: -1 }, { ...eventFrame(5), seq: '5' }, { ...eventFrame(5), seq: Number.MAX_SAFE_INTEGER + 1 },
			{ ...eventFrame(5), extra: 1 },
			{ ...resyncFrame(5), resync: { reason: 'other' } }, { ...resyncFrame(5), resync: { reason: 'overflow', x: 1 } }, { ...resyncFrame(5), extra: 1 },
			{ ...endFrame(), end: { reason: 'other' } }, { ...endFrame(), seq: 3 },
			{ v: 1, sub: SUB, seq: 5 }, { v: 1, sub: SUB, seq: 5, event: { topic: 'approvals' }, resync: { reason: 'overflow' }, end: { reason: 'shutdown' } },
			null, 'x', 5,
		]) {
			assert.strictEqual(readServerFrame(frame), undefined, JSON.stringify(frame));
		}
	});

	test('an event whose body is unknown (additive field, new topic, bad id) is opaque: sound envelope, body discarded', () => {
		for (const event of [{ topic: 'approvals', x: 1 }, { topic: 'newtopic' }, { topic: 'workspaces', workspaceId: '/etc/passwd' }, 'x', null]) {
			assert.deepStrictEqual(readServerFrame(eventFrame(5, event as Record<string, unknown>)), { kind: 'opaque', sub: SUB, seq: 5 }, JSON.stringify(event));
		}
		for (const frame of [{ ...eventFrame(5, { topic: 'x' }), seq: -1 }, { ...eventFrame(5, { topic: 'x' }), v: 2 }, { ...eventFrame(5, { topic: 'x' }), extra: 1 }, { ...eventFrame(5, { topic: 'x' }), sub: 'bad' }]) {
			assert.strictEqual(readServerFrame(frame), undefined, 'a broken envelope is never opaque');
		}
	});

	test('the subscribe reply must be exact and its window may not exceed what the shell buffers', () => {
		assert.deepStrictEqual(readSubscribeReply(reply()), reply());
		for (const bad of [
			reply({ window: 33 }), reply({ window: 0 }), reply({ window: 1.5 }), reply({ resumed: 'no' }), reply({ seq: -1 }),
			reply({ subscriptionId: 'x' }), reply({ epoch: '../..' }), reply({ extra: 1 }), { epoch: reply().epoch }, null, 'x',
		]) {
			assert.strictEqual(readSubscribeReply(bad), undefined, JSON.stringify(bad));
		}
	});
});
