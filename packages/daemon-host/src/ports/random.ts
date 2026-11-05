// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** Randomness, injected so tests are deterministic. The real source is the operating system's CSPRNG. */
export interface RandomSource {
  /** `length` random bytes (1 to 1024). */
  bytes(length: number): Uint8Array;
  /** A random version 4 UUID in lowercase canonical form. */
  uuid(): string;
}
