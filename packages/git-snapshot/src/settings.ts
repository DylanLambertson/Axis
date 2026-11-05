// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

export interface SettingClass {
  readonly label: string;
  readonly severity: "high" | "medium";
}

type Rule = readonly [section: string, sub: "none" | "any" | "opt", names: readonly string[], cls: SettingClass];

const high = (label: string): SettingClass => ({ label, severity: "high" });
const medium = (label: string): SettingClass => ({ label, severity: "medium" });

// Settings that make git run a program, redirect where it talks to, or change which credentials it uses.
// `sub` says whether a subsection is required ("any"), absent ("none") or optional ("opt").
const RULES: readonly Rule[] = [
  ["core", "none", ["hookspath"], high("core.hooksPath")],
  ["core", "none", ["fsmonitor"], high("core.fsmonitor")],
  ["core", "none", ["sshcommand"], high("core.sshCommand")],
  ["core", "none", ["gitproxy"], high("core.gitProxy")],
  ["core", "none", ["askpass"], high("core.askPass")],
  ["core", "none", ["editor", "pager"], medium("core editor or pager command")],
  ["core", "none", ["attributesfile", "excludesfile"], high("core attributes or excludes file")],
  ["core", "none", ["worktree"], high("core.worktree")],
  ["extensions", "none", ["worktreeconfig"], medium("extensions.worktreeConfig")],
  ["include", "none", ["path"], high("include.path")],
  ["includeif", "any", ["path"], high("includeIf path")],
  ["credential", "opt", ["helper", "username", "usehttppath"], high("credential helper")],
  ["url", "any", ["insteadof", "pushinsteadof"], high("url rewrite")],
  ["remote", "any", ["url", "pushurl", "proxy", "uploadpack", "receivepack", "vcs", "mirror", "push"], high("remote")],
  ["remote", "none", ["pushdefault"], medium("remote.pushDefault")],
  ["branch", "any", ["remote", "pushremote"], medium("branch remote")],
  ["filter", "any", ["clean", "smudge", "process", "required"], high("filter driver")],
  ["diff", "none", ["external"], high("diff.external")],
  ["diff", "any", ["command", "textconv"], high("diff driver")],
  ["merge", "any", ["driver", "name", "recursive"], high("merge driver")],
  ["mergetool", "any", ["cmd", "path"], high("mergetool command")],
  ["difftool", "any", ["cmd", "path"], high("difftool command")],
  ["alias", "none", ["*"], high("alias")],
  ["pager", "none", ["*"], medium("pager command")],
  ["protocol", "opt", ["allow"], high("protocol allow")],
  ["gpg", "opt", ["program"], high("gpg program")],
  ["sequence", "none", ["editor"], high("sequence.editor")],
  ["uploadpack", "none", ["packobjectshook"], high("uploadpack.packObjectsHook")],
  ["trailer", "any", ["cmd", "command"], high("trailer command")],
  ["submodule", "any", ["update", "url"], high("submodule")],
  ["http", "opt", ["proxy", "extraheader", "sslverify", "sslcainfo", "cookiefile", "proxyauthmethod"], high("http transport")],
  ["init", "none", ["templatedir"], medium("init.templateDir")],
];

/** Classifies a (lower-cased section, subsection, lower-cased name) as security-relevant, or null. */
export function classifySetting(section: string, subsection: string | null, name: string): SettingClass | null {
  for (const [sec, sub, names, cls] of RULES) {
    if (sec !== section) continue;
    if (sub === "none" && subsection !== null) continue;
    if (sub === "any" && subsection === null) continue;
    if (names.includes("*") || names.includes(name)) return cls;
  }
  return null;
}

/** Settings whose value is a path that git reads, and the group of entry it adds. */
export const PATH_SETTINGS: ReadonlyMap<string, "hooks" | "attributes"> = new Map([
  ["core.hookspath", "hooks"],
  ["core.attributesfile", "attributes"],
  ["core.excludesfile", "attributes"],
]);

/** Labels whose flags are never pushed out of a flag list by a flood of lesser ones. */
export const CRITICAL_LABELS: ReadonlySet<string> = new Set([
  "core.hooksPath",
  "core.fsmonitor",
  "core.sshCommand",
  "core.gitProxy",
  "core.askPass",
  "core attributes or excludes file",
  "core.worktree",
  "include.path",
  "includeIf path",
  "credential helper",
  "url rewrite",
  "remote",
  "filter driver",
  "gpg program",
  "http transport",
  "protocol allow",
  "index flag hides changes",
]);
