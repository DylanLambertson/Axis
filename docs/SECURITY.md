<p align="center"><img src="../assets/readme/security-banner.svg" alt="Security, privacy and trust model" width="100%"></p>

# Security, Privacy and Trust Model

## Threats
Prompt injection from source files and external tools; malicious extensions; compromised provider credentials; shell command abuse; cross-Space or cross-project data leakage; supply-chain dependencies; malicious agent patches; cloud runner breakout; collab impersonation; sync key loss; model exfiltration.

<p align="center"><img src="../assets/readme/divider.svg" alt="" width="100%"></p>

## Boundaries
Electron renderer is untrusted relative to local OS; validate all IPC. Local daemon is privileged only within user grants. Extensions and MCP servers are third-party code and require trust boundaries. Agents execute in restricted subprocess/container environments with resource quotas and egress policies. Git worktrees prevent edit collisions but are **not security sandboxes**.

<p align="center"><img src="../assets/readme/security-boundaries.svg" alt="Trust boundaries between the renderer, main process, daemon and the outside world" width="100%"></p>

<p align="center"><img src="../assets/readme/divider.svg" alt="" width="100%"></p>

## Approvals and policy
Default deny for destructive file operations outside approved worktree, network egress, package install, credential reads, Git pushes, remote commands, deployments and elevated privileges. Policy engine evaluates actor, workspace, tool, scope, target, side effect and organization rule. Audit approval identity and expiration. Prevent self-granted permissions.

<p align="center"><img src="../assets/readme/approval-flow.svg" alt="How a single-use approval works in five steps" width="100%"></p>

<p align="center"><img src="../assets/readme/divider.svg" alt="" width="100%"></p>

## Secrets
OS credential store on desktop; managed encrypted vault for cloud. Scoped handles to tools; never inject all credentials into agent prompts or process environment. Redact logs and error reports. Support revoke/rotate and provider-specific access scopes.

<p align="center"><img src="../assets/readme/divider.svg" alt="" width="100%"></p>

## Local/cloud data
Clear consent before transmitting source code, prompts or embeddings to third parties. Show provider and data destination. Local-first indexing by default. Sync opt-in, encrypted in transit and at rest; E2EE only when key sharing/recovery/rotation has been designed and tested. Organization data residency as future enterprise capability.

<p align="center"><img src="../assets/readme/divider.svg" alt="" width="100%"></p>

## Identity and collaboration
OIDC/OAuth for product login where supported, device sessions, MFA/passkeys as feasible, RBAC plus resource-level authorization, invitation lifecycle, revocation, signed audit records. Never trust client-side role checks alone.

<p align="center"><img src="../assets/readme/divider.svg" alt="" width="100%"></p>

## Supply chain and updates
Pinned dependencies, SBOM, license audit, signed builds, update signatures, vulnerability scanning, Code OSS upstream security patch plan, reproducible CI where possible. Validate extension distribution and marketplace licensing separately.

<p align="center"><img src="../assets/readme/divider.svg" alt="" width="100%"></p>

## Testing
Threat model per major milestone; security integration tests, path traversal/symlink escapes, command injection, SSRF/egress, prompt injection, privilege escalation, tenant isolation, race conditions, secrets redaction, offline revocation edge cases, cloud runner containment.

<p align="center"><img src="../assets/readme/divider.svg" alt="" width="100%"></p>

<p align="center"><img src="../assets/readme/footer.svg" alt="Let's build something together." width="100%"></p>
