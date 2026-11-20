// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { providerCredentialSchema, providerInfoSchema } from "../src/index.js";

// PRV-1 (ticket C6): where a connection's credential is stored, as the provider list shows it. Never the credential.

const info = {
  providerId: "anthropic",
  displayName: "Anthropic (Claude API)",
  apiVersion: 1,
  connectionId: "anthropic-main",
  status: "unchecked",
  models: [],
  destination: { origin: "https://api.anthropic.com", description: "Anthropic Claude API" },
};

test("each credential state carries exactly its fields", () => {
  for (const ok of [
    { state: "stored", backend: "gnome_libsecret", protection: "os_protected", weakConsent: false, backendChanged: false },
    { state: "stored", backend: "basic_text", protection: "none", weakConsent: true, backendChanged: true },
    { state: "missing", backend: "macos_keychain", protection: "os_protected", policy: "allowed" },
    { state: "missing", backend: "basic_text", protection: "none", policy: "consent_required" },
    { state: "unavailable" },
  ]) {
    assert.equal(providerCredentialSchema.safeParse(ok).success, true, JSON.stringify(ok));
    assert.equal(providerInfoSchema.safeParse({ ...info, credential: ok }).success, true);
  }
  assert.equal(providerInfoSchema.safeParse(info).success, true, "absent for a connection that needs none");
});

test("a credential value, an unknown backend or protection, or a field of another state is refused", () => {
  for (const bad of [
    { state: "stored", backend: "gnome_libsecret", protection: "os_protected", weakConsent: false, backendChanged: false, secret: "x".repeat(20) },
    { state: "stored", backend: "plaintext_file", protection: "os_protected", weakConsent: false, backendChanged: false },
    { state: "stored", backend: "gnome_libsecret", protection: "strong", weakConsent: false, backendChanged: false },
    { state: "stored", backend: "gnome_libsecret", protection: "os_protected" },
    { state: "missing", backend: "gnome_libsecret", protection: "os_protected", policy: "allowed", weakConsent: false },
    { state: "missing", backend: "gnome_libsecret", protection: "os_protected", policy: "maybe" },
    { state: "unavailable", backend: "gnome_libsecret" },
    { state: "locked" },
    "stored",
    null,
  ]) {
    assert.equal(providerCredentialSchema.safeParse(bad).success, false, JSON.stringify(bad));
    assert.equal(providerInfoSchema.safeParse({ ...info, credential: bad }).success, false);
  }
});
