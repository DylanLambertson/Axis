// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The timer typings Code OSS 1.144.0 declares globally (src/typings/base-common.d.ts, lines 21-29, MIT licence,
// Copyright (c) Microsoft Corporation). In the Code OSS tree `setTimeout` and `setInterval` return an opaque
// `TimeoutHandle`, not Node's `Timeout`, and the handle has no `unref`. test/packages/staged-typecheck.test.mjs
// compiles the staged packages with this file so that code typed against Node's return type fails here, in the
// ordinary test run, and not only in the manual full Code OSS build.
declare global {
	interface TimeoutHandle { readonly _: never; }
	type Timeout = TimeoutHandle;
	function setTimeout(handler: string | Function, timeout?: number, ...arguments: any[]): Timeout;
	function clearTimeout(timeout: Timeout | undefined): void;

	function setInterval(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]): Timeout;
	function clearInterval(timeout: Timeout | undefined): void;
}

export {};
