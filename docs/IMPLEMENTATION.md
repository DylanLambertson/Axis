# Implementation Blueprint

## Suggested monorepo (adjust after feasibility spike)
```
apps/
  desktop/               # Electron main, preload, renderer integration
  web/                   # Browser client
  workspace-server/      # Remote IDE and terminal gateway
  collaboration-server/  # Identity, presence, CRDT sync, permissions
packages/
  workbench-ui/          # Custom layout and shared components
  design-tokens/         # Themes, typography, spacing, motion
  ide-core/              # IDE capability abstractions
  ide-codeoss/           # Code OSS adapters/fork integration
  protocol/              # Typed RPC and events
  ai-gateway/            # Provider registry, routing, streaming
  provider-sdk/          # External adapter contracts
  orchestration/         # Task DAG, scheduler, lifecycle
  execution/             # Tool broker, sandbox, worktree manager
  context/               # Index, memory, graph, retrieval
  persistence/           # SQLite migrations, journals
  security/              # Policy, permissions, redaction
  collaboration/         # Client sync, presence, comments
  extension-bridge/      # Verified extension compatibility
  testing/               # Fixtures, mock provider, harness
 docs/adr/
```

## Initial interfaces (illustrative)
```ts
interface WorkspaceCapability { id: string; available: boolean; reason?: string }
interface ProviderConnection { id: string; providerId: string; ownerScope: string; authMethod: 'oauth'|'api_key'|'cli'|'custom'; status: 'ready'|'expired'|'unsupported'|'error' }
interface ModelCapability { modelId: string; tools: boolean; streaming: boolean; images: boolean; structuredOutput: boolean; maxContextTokens?: number }
interface AgentTask { id: string; runId: string; dependsOn: string[]; baseSha: string; worktreeId?: string; allowedTools: string[]; status: string; budget?: {tokens?: number; usd?: number} }
interface ToolApproval { toolId: string; workspaceId: string; actorId: string; targetScope: string; risk: 'read'|'write'|'network'|'destructive'|'privileged'; expiresAt?: string }
interface KnowledgeRecord { id: string; scopeId: string; sourceRef: string; provenance: string; verified: boolean; createdAt: string; expiresAt?: string }
```

## Initial SQLite entities
`spaces`, `projects`, `repositories`, `agent_workspaces`, `connections_metadata`, `agent_runs`, `agent_tasks`, `agent_events`, `worktrees`, `approvals`, `artifacts`, `knowledge_records`, `knowledge_edges`, `skills`, `rules`, `sync_operations`, `audit_events`. Separate secrets from ordinary tables; enforce scope checks in service layer and DB queries.

## Quality gates
PRs require lint, typecheck, unit tests, affected integration tests, accessibility checks for UI, license scan, and an ADR for consequential architecture changes. CI matrices include supported desktop OS and browser targets. Use mock provider for deterministic tests; live provider tests opt-in with strict budget and secrets isolation.

## Initial agent team assignments
- Architect: feasibility ADRs and dependency inventory.
- IDE engineer: Code OSS custom workbench spike.
- Platform engineer: Electron IPC, desktop/web workspace protocol.
- AI engineer: provider SDK and mock/first official adapter.
- Runtime engineer: worktree lifecycle, sandbox and tool broker.
- Product designer: agent-first workspace shell and view-switching interaction prototypes.
- Security reviewer: threat model and gate review across workstreams.

## Task handoff template
Goal; relevant docs/ADR; owner; worktree branch/base SHA; exact scope; acceptance criteria; permitted tools; tests run/results; changed files; security/privacy impact; open questions; merge status.
