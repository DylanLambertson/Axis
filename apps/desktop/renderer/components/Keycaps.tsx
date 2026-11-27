// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A shortcut badge: the keycaps of a chord, shown on the control it triggers. Hidden from assistive technology; the
// control carries `aria-keyshortcuts` instead.

export function Keycaps({ keys }: { readonly keys: readonly string[] }) {
  return (
    <span className="axis-keycaps" aria-hidden="true">
      {keys.map((k, i) => (
        <kbd key={i} className="axis-kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}
