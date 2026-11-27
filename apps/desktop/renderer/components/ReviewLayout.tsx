// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The diff-review layout (OS-6; OS-13 fills it): the changed-file list beside the diff, and at a narrow width the list
// above the diff in a collapsible section, so diff lines get the full width instead of being squeezed (QA finding 10).
// The width rule is a container query in shell.css, so it follows the pane, not the window. The header states DC-0's
// promise: a commit uses a private index and never touches the user's own staged changes.

import type { KeyboardEvent, ReactNode } from "react";
import { rovingIndex } from "@axis/ui";

export interface ReviewFile {
  readonly id: string;
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface ReviewLayoutProps {
  readonly title: string;
  readonly files: readonly ReviewFile[];
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
  readonly children: ReactNode;
}

function Counts({ file }: { readonly file: ReviewFile }) {
  return (
    <span className="axis-counts" aria-label={`${file.additions} added, ${file.deletions} removed`}>
      <span className="axis-counts__add" aria-hidden="true">+{file.additions}</span>{" "}
      <span className="axis-counts__del" aria-hidden="true">{"−"}{file.deletions}</span>
    </span>
  );
}

export function ReviewLayout(props: ReviewLayoutProps) {
  const at = props.files.findIndex((f) => f.id === props.selectedId);
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const next = rovingIndex(props.files.length, at, event.key);
    if (next === undefined) return;
    event.preventDefault();
    props.onSelect(props.files[next]!.id);
    (event.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  }
  return (
    <section className="axis-review" aria-label={props.title}>
      <header className="axis-review__head">
        <h2>{props.title}</h2>
        <p className="axis-review__note">Commits are built in a private index: your own staged changes are never touched.</p>
      </header>
      <div className="axis-review__body">
        <details className="axis-review__files" open>
          <summary>
            <span className="axis-label">Files</span> <span className="axis-review__count">{props.files.length}</span>
          </summary>
          <ul role="listbox" aria-label="Changed files" onKeyDown={onKeyDown}>
            {props.files.map((f, i) => (
              <li key={f.id} role="option" aria-selected={f.id === props.selectedId} tabIndex={f.id === props.selectedId || (at === -1 && i === 0) ? 0 : -1} onClick={() => props.onSelect(f.id)}>
                <span className="axis-review__path">{f.path}</span>
                <Counts file={f} />
              </li>
            ))}
          </ul>
        </details>
        <div className="axis-review__diff">{props.children}</div>
      </div>
    </section>
  );
}
