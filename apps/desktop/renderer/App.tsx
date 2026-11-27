// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The empty frame of the own shell. OS-6 builds the core frame (top bar, navigation rail, router).
import { BRAND } from "@axis/ui";

export function App() {
  return (
    <main className="axis-shell">
      <h1 className="axis-shell__title">{BRAND.productName}</h1>
    </main>
  );
}
