// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** Shannon entropy in bits per character over the characters of `s` (code units; `s` is at most a few hundred long). */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<number, number>();
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
