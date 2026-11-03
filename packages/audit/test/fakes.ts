// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Obviously fake credentials, assembled at runtime so no secret-shaped literal
// is committed. None of these is, or was, a real credential.

const filler = (ch: string, n: number): string => ch.repeat(n);

export const FAKE = {
  anthropic: "sk-" + "ant-api03-" + filler("A1b2", 12),
  openai: "sk-" + "proj-" + filler("Zx9y", 10),
  github: "gh" + "p_" + filler("a1B2c3", 7),
  githubFine: "github" + "_pat_" + filler("Q1w2E3", 6),
  google: "AI" + "za" + filler("Sy1", 12).slice(0, 35),
  aws: "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  jwt:
    "ey" + "JhbGciOiJIUzI1NiJ9" + "." + "ey" + "JzdWIjoiZmFrZSJ9" + "." + "c2lnbmF0dXJlLWZha2U",
  password: "hunter2-" + filler("pw", 6),
  privateKey: [
    "-----BEGIN " + "PRIVATE KEY-----",
    "MIIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
    "bm90LWEtcmVhbC1rZXk=",
    "-----END " + "PRIVATE KEY-----",
  ].join("\n"),
  rsaKeyTruncated: "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIFAKEFAKEFAKE\nstill-going",
  vaultKey: "vault-canary-" + filler("k7", 8),
} as const;

/** Every fake value that must never survive redaction (the key block is checked by body line). */
export const FAKE_NEEDLES: readonly string[] = [
  FAKE.anthropic,
  FAKE.openai,
  FAKE.github,
  FAKE.githubFine,
  FAKE.google,
  FAKE.aws,
  FAKE.jwt,
  FAKE.password,
  "MIIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
  "bm90LWEtcmVhbC1rZXk=",
  FAKE.vaultKey,
];
