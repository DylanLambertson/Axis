// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-5 review 2 (SF1): the reconnecting client's read of a call's outcome. The daemon's replies are JSON on the wire, so a reply
// is read through own data properties only and its result is copied into fresh plain data before anything adopts it: no getter,
// inherited field or `then` on what the connection hands back is run by the shell, and any reply that is not plain data is an
// `invalid_reply`. A Proxy's traps do still run when its properties are inspected; whatever they throw is that same closed code.

/** The outcome of one call, read from the connection's answer. */
export type AxisReply = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly code: unknown };

/** More nested arrays and objects than this is not daemon data (the daemon's replies are a few levels deep). */
export const AXIS_WIRE_DEPTH_LIMIT = 64;

class NotWireData extends Error {}

/** `key` as an own data property of `value`; undefined when absent. An accessor is not read: it throws NotWireData. */
function dataField(value: object, key: string): unknown {
	const d = Object.getOwnPropertyDescriptor(value, key);
	if (d === undefined) {
		return undefined;
	}
	if (!('value' in d)) {
		throw new NotWireData();
	}
	return d.value;
}

/** The `code` of an error or answer as an own data property, or undefined; nothing on it is run, and nothing on it throws out. */
export function codeOf(value: unknown): unknown {
	try {
		if (typeof value !== 'object' || value === null) {
			return undefined;
		}
		const d = Object.getOwnPropertyDescriptor(value, 'code');
		return d !== undefined && 'value' in d ? d.value : undefined;
	} catch {
		return undefined;
	}
}

function copy(value: unknown, depth: number): unknown {
	if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
		return value;
	}
	if (typeof value !== 'object' || depth >= AXIS_WIRE_DEPTH_LIMIT) {
		throw new NotWireData();
	}
	const proto = Object.getPrototypeOf(value) as unknown;
	let out: unknown;
	if (Array.isArray(value)) {
		if (proto !== Array.prototype) {
			throw new NotWireData();
		}
		const length = dataField(value, 'length');
		if (typeof length !== 'number') {
			throw new NotWireData();
		}
		const items: unknown[] = [];
		for (let i = 0; i < length; i++) {
			items.push(copy(dataField(value, String(i)), depth + 1));
		}
		out = items;
	} else {
		if (proto !== Object.prototype && proto !== null) {
			throw new NotWireData();
		}
		const fields: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			// defineProperty, not assignment: a `__proto__` key stays a plain field.
			Object.defineProperty(fields, key, { value: copy(dataField(value, key), depth + 1), enumerable: true, writable: true, configurable: true });
		}
		out = fields;
	}
	return out;
}

/**
 * A fresh copy of JSON-shaped data (null, booleans, numbers, strings, arrays and plain objects, read through own data properties).
 * Anything else, an accessor, or nesting past the limit (a cycle among them) throws; the caller turns that into `invalid_reply`.
 */
export function wireDataCopy(value: unknown): unknown {
	return copy(value, 0);
}

/**
 * Reads an answer `{ ok: true, result }` or `{ ok: false, error: { code } }`. The result comes back as a fresh copy, so resolving
 * a promise with it runs nothing of the connection's. Never throws: anything that is not such an answer is `invalid_reply`.
 */
export function readReply(answer: unknown): AxisReply {
	try {
		if (typeof answer !== 'object' || answer === null) {
			return { ok: false, code: 'invalid_reply' };
		}
		const ok = dataField(answer, 'ok');
		if (ok === true) {
			return { ok: true, result: wireDataCopy(dataField(answer, 'result')) };
		}
		if (ok !== false) {
			return { ok: false, code: 'invalid_reply' };
		}
		return { ok: false, code: codeOf(dataField(answer, 'error')) };
	} catch {
		return { ok: false, code: 'invalid_reply' };
	}
}

/**
 * Waits for what a connection's call returned without touching it here: the shell's own promise adopts it, so a `then` getter
 * that throws, or a thenable that misbehaves, becomes a rejection handed to `onError` rather than an exception in the caller.
 */
export function whenSettled(value: unknown, onValue: (v: unknown) => void, onError: (e: unknown) => void): void {
	new Promise<unknown>(adopt => adopt(value)).then(onValue, onError);
}
