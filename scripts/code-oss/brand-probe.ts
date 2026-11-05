// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Brand probe for scripts/code-oss/check-staged.mjs --build-bundle (ADR 0005 D3.6). The check copies this file over
// the daemon entry of a scratch Code OSS tree, bundles it with the tree's real minified step, runs the output and
// reads the JSON line below. It is never part of the overlay. It imports the two brand classes and the daemon-only
// mint functions straight from the staged packages and reports whether forgeries are rejected.
import { UserPrincipal } from '../../packages/journal/principal.js';
import { userPrincipal } from '../../packages/journal/daemon-principal.js';
import { TrustAttestation } from '../../packages/runs/attestation.js';
import { attestTrust } from '../../packages/runs/daemon-attestation.js';

const principal = userPrincipal();
const attestation = attestTrust({ workspaceId: 'w', projectId: 'p', issuedAt: 1000 });
const expected = { workspaceId: 'w', projectId: 'p', now: 1000, ttlMs: 60000 };
const ownKeys = Reflect.ownKeys(principal);
const copy: Record<PropertyKey, unknown> = {};
for (const key of ownKeys) {
	copy[key] = (principal as unknown as Record<PropertyKey, unknown>)[key];
}
const first = TrustAttestation.check(attestation, expected, true) ?? null;
const second = TrustAttestation.check(attestation, expected, false) ?? null;
console.log(JSON.stringify({
	realPrincipal: UserPrincipal.is(principal),
	handWritten: UserPrincipal.is({ $a: 'user' }),
	cloned: UserPrincipal.is(structuredClone(principal)),
	copied: UserPrincipal.is(copy),
	ownKeys: ownKeys.length,
	realAttestation: TrustAttestation.is(attestation),
	attestationHandWritten: TrustAttestation.is({ $a: {}, $b: false }),
	attestationCloned: TrustAttestation.is(structuredClone(attestation)),
	first,
	second,
}));
