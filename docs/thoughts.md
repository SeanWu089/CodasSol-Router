# Thoughts

## 2026-10-28 — Android scope decision

- Approved: native Android Agent with wireless outbound authenticated connection, local access switch and normal on-device system confirmations. Build location may be any suitable computer/cloud worker; the phone is the installation and test target. This is confirmed work in todos.md.
- Long-term replaceable online ingress/coordinator remains deferred. This stage reuses the existing entry and exposes a configurable endpoint; it does not implement distributed ingress failover or unattended privileged Android control.

- 2026-10-13 confirmed: use only the existing free ingress plan and optimize away redundant peer traffic. Windows native Git checkout is `<Windows development checkout>`, development branch `feat/windows-standalone-node-v0.2`, accessed through authenticated outbound SSE. Use that directory for Windows work; preserve standalone runtime/credentials separately and do not resume Tailscale routing.

- 2026-10-13 confirmed transport constraint: CodasSol must not use Tailscale. Outbound authenticated SSE job delivery through the public ingress is the intended cross-device path; ingress takeover is separate. Historical optional-Tailscale suggestions below are superseded. Keep the user's unrelated Tailscale setup intact. Mac product peer removed; Windows reciprocal cleanup and SSE deployment remain pending.

- Position CodasSol as a **transparent workspace router**, not as another general remote desktop or all-in-one AI runtime.
- Product headline: **Route the Project, Not Devices.** The user/agent addresses the project or workspace; the Router resolves the physical machine.
- Keep DevSpace as the execution layer; keep CodasSol focused on discovery, routing, workspace affinity, credentials, and policy.
- Security directions: per-action approvals, capability-scoped tokens, audit trails, token rotation/revocation, signed updates, protocol compatibility, least-privilege OS accounts, and optional secure relay/Tailscale integration.
- Routing directions: aliases/tags, capability routing (`gpu`, `cuda`, `macos`, `office`, `home`), load awareness, wake/sleep state, and explicit overrides.
- Consumer workflows: retrieve/send a file from any device, start a download/render at home, run a long task on a powerful desktop from a phone, collect files across machines, and operate home-lab devices without learning SSH.
- UI directions: small device dashboard, mobile command surface, approval notifications, activity timeline, and optional GUI/computer-use capabilities.
- Avoid growing into an all-in-one chat/model/orchestration platform until the routing layer itself is mature.

## 2026-10-09 — Project identity and long-term Codas vision

**Canonical Mac project root:** `<development-checkout>`. This file lives at `docs/thoughts.md` relative to that root. Treat this as the intended source checkout, not an unrelated Windows folder with the same name. Resolve node identity and verify the workspace/Git root before changing files.

**Long-term product direction:** **Codas — Route the Project. Nothing More.**
The original **Route the Project, Not Devices.** remains the guiding slogan for today's CodasSol router. `CodasSol` is the incubation name; consider `Codas` as the eventual product name only after the system becomes model-, agent-, and device-agnostic.

The user specifies a **project and desired outcome**, not which computer, model, provider, tool, or runtime to choose. Those choices are internal resource-allocation details. **SIR (Selective Intelligence Router)** is a potential internal intelligence-scheduling subsystem, not the whole product.

### Roadmap — do not distract from the current milestone

1. **Phase 0 — Decentralized nodes (current priority):** independent Mac/Windows availability, stable node identity, self-registration, discovery, heartbeats, reconnect/recovery, and unambiguous routing. `dash!` must report live *verified* status rather than infer online state from registrations or previous success. In particular: **Mac OFF + Windows ON must still allow Windows discovery, `open_workspace`, and `exec_command`**, and vice versa. Add regression coverage for stale endpoint/relay URLs and workspace-to-device affinity. No machine may silently be a mandatory gateway for the others.
2. **Phase 1 — Project routing:** project identifiers, discoverable workspaces, correct routing to repositories, artifacts and environments, independent of a specific device/path.
3. **Phase 2 — Intelligent execution:** route task steps to capable agents and devices with permissions, auditability and verification.
4. **Phase 3 — SIR:** choose and coordinate cloud APIs, local models and agent roles under cost, latency, quality, privacy and hardware constraints. Do **not** implement this as part of Phase 0.

### Future SIR: route tasks, not model names

- Candidate route is a tuple of **(task step, agent, model/provider, device/runtime, tools, budget)**; not simply a prompt-to-model lookup.
- Use explicit hard constraints first (permissions, privacy, availability, platform requirements, maximum cost), then task features and a measured capability matrix. Prefer the least expensive *qualified* route.
- Use external verification (tests, type checks, lint, artifacts, reproducible tool results, independent review) and escalate only when evidence warrants it. A model's self-reported confidence is **not** a reliable standalone quality guarantee.
- Suggested modes: Auto, Fast/Budget and Deep/Quality. Avoid uncontrolled model-to-model escalation loops; SIR owns routing decisions and applies retry/escalation limits.
- Example division of labour: a strong reasoning model diagnoses architecture issues; an engineering model implements; a cheap/local model executes repetitive inspections or tests. Actual roles are based on evidence, not permanent model stereotypes.
- Keep route decisions, observed quality, cost, latency and failed attempts in an auditable history. Benchmark on real Codas tasks against simple fixed-model baselines before adding learned routing.
- A ChatGPT MCP connector can orchestrate its **own** model/API/local worker calls, but cannot programmatically switch the host model of an existing ChatGPT conversation.

### Project State: models are replaceable workers

**Principles:**

> Conversation is disposable. Project State is canonical.
>
> Models come and go. The Project remembers.

Do not hand another model a raw transcript and hope it infers the true state. Introduce a **Project State Fabric** with separate responsibilities:

| Layer | Responsibility | Tentative implementation |
| --- | --- | --- |
| Live state | Active task, transient execution details, running process, temporary locks | In-process memory first; optional shared cache later |
| Durable snapshot | Current task/project status and checkpoint for recovery | SQLite with versioned schema and transactions |
| Event log | What happened, why, by whom, with source/causality | Append-only events; snapshots derived from events |
| Artifacts | Source code, branches, files, generated outputs and test evidence | Git and content-addressed blobs; never substitute memory for files |
| Long-term memory | Decisions, constraints, lessons, semantic facts | Small curated core notes + provenance-backed retrieval |
| Temporal graph (optional) | Relationships among facts, decisions, code, and their validity intervals | Evaluate Graphiti (Zep), not the authority for current state |
| Context compiler | Minimal relevant, source-backed view per task/worker | `Context Capsule` with explicit limits and permissions |

**Graphiti idea:** a temporal knowledge graph is valuable for questions like *why did Windows routing previously depend on Mac, and what changed?* Facts need source, valid-from/valid-until or supersession, and links to commits/tests/decisions. An old observation must not silently become a current assertion. Treat Graphiti as an **optional derived memory index**, never the single source of truth.

**Handoff protocol:**

1. Before assigning a task, compile a versioned **Context Capsule**: project ID, objective, constraints, repo path/commit/dirty state, current plan, relevant decisions, working set, evidence, unsuccessful approaches, next action, capabilities/permissions, cost limits, and citations/anchors to authoritative artifacts.
2. The worker returns a response **plus structured State Delta**: findings with evidence, files changed, tests and outputs, proposed decisions, completed/new steps, and candidate memory updates.
3. Validate against the current project version and actual artifacts before committing a delta. Conflicting/stale changes need reconciliation; never let a worker silently overwrite state.
4. Long-term memory writes must be curated: deduplicate, scope by project/task, verify evidence, preserve provenance and mark superseded facts. Distinguish *proposed* from *accepted* decisions.
5. Persist recoverable checkpoints at meaningful task boundaries; do not indiscriminately store every token, ephemeral shell output or test repetition.

**Decentralized state needs different sync policies by data type:** Git for code, immutable replicated events for history, scoped metadata merge/CRDT where helpful, leases for single-writer operations, and content-addressed objects for large artifacts. Do not use CRDT for everything. Offline peers cannot assume one global monotonically increasing event counter; use stable actor/event IDs, ordering/causality metadata, idempotent reconciliation, and explicit conflict policy. Handle concurrent edits and split-brain rather than pretending they cannot happen.

**Implementation experiments after Phase 0:**

1. **Lean State:** SQLite + append-only event log + Markdown decisions; prove safe cross-model/project handoff and recovery.
2. **Temporal State:** optionally add Graphiti; measure whether time-aware/provenance-based retrieval reduces stale facts and mistaken decisions.
3. **Trace State:** anchor memories to Git commits, symbols, files, and tests and invalidate stale memories after repository changes (inspired by research on trace-grounded coding memory).

Measure handoff correctness, stale-memory rate, recovery after interruption, token usage, latency and cost. Keep the system small until experiments demonstrate improvements.


## 2026-10-22 — Unconfirmed isolation direction

Security audit showed remote shell commands run with Sean's account permissions beyond Desktop allowedRoots. Consider a dedicated low-privilege OS account, container/sandbox, or narrower per-tool permissions; no particular isolation design or restrictions have been approved yet. Preserve useful remote development functionality while separating private credentials from remote command access.


## 2026-10-28 — Distributed phone-node scope

The user's longer-term direction is a distributed Codas network with a replaceable active entry/coordinator among online computers, rather than a permanently required personal computer. The confirmed current stage is a wireless Android execution/test node using the existing ingress, with compilation on a computer/cloud and an explicit phone access switch. Automatic coordinator selection/failover and distributed project-state synchronization remain deferred ideas, not part of this Android preview.
