# Thoughts

## Two core pillars — Intelligent Routing + Dynamic Ingress (2026-10-10)

- **Product goal:** from ChatGPT (web, Codex, or mobile) anywhere, access and
  operate files and commands inside *authorized workspaces* on any registered,
  online device. The ChatGPT client device is unrelated to the execution
  device. **Route the Project, Not Devices.**
- **Intelligent Routing — ChatGPT decides; CodasSol verifies.** Expose a small
  MCP device/workspace directory, with online/execution readiness and
  optionally user-approved project aliases/recent-workspace metadata. ChatGPT
  uses conversation context to interpret requests such as “continue the
  Windows desktop project” and selects the intended device/workspace; the
  Router uses deterministic identity, path, allowed-root and workspace-owner
  checks. If the selection is ambiguous, missing, offline, or unauthorized,
  fail closed rather than silently executing on the ingress machine.
- **No second semantic LLM inside the Router.** AI reasoning belongs to the
  calling assistant. The local Router supplies trusted facts, a stable tool
  contract, secure delivery and auditable decisions; it does not hallucinate
  project/device ownership.
- **Dynamic Ingress — same MCP URL, movable ingress host.** Exactly one
  eligible online node serves the public hostname at a time; it must safely
  yield or acquire the hostname without forcing the user to reconfigure
  ChatGPT. There is *no* permanently privileged Mac or Windows.
- **Transport is an implementation detail.** Current Mac→Windows routing is
  authenticated HTTPS over Tailscale to a Windows Router, then loopback HTTP
  to its own DevSpace. Long-term goal: no *mandatory* VPN, WebSocket, P2P or
  per-device public ngrok Endpoint. Compare a minimal outbound agent
  task-claim channel against direct peer transport only when needed; do not
  prematurely choose a protocol. Multi-device execution requires some
  reachable authenticated task path, even though end-user ChatGPT clients
  never connect to individual devices themselves.
- **Security model:** semantic intent is advisory; the Router enforces exact
  device identity, allowed workspaces, local DevSpace authorization, no
  wrong-host fallback and no automatic replay of potentially mutating work.
  A ChatGPT-selected target never grants permission by itself.
- **Keep mental models separate:** the ChatGPT MCP plugin is a client-side
  tool connection to one HTTPS address, not a copy of the Router running
  inside ChatGPT. Each enrolled device can independently run its own Router
  and DevSpace; temporary ingress location is not project ownership.
- **Incremental example:** “修改 Windows 桌面上的程序” → ChatGPT chooses
  target after querying registered devices → CodasSol validates `device_id`
  and workspace root → existing Mac ingress forwards the MCP job to
  authenticated Windows Router → Windows Router's local DevSpace (loopback)
  executes → result returns to ChatGPT. Port numbers are *local to each
  device*, so multiple DevSpace instances can all listen on 127.0.0.1:7676.

- Position CodasSol as a **transparent workspace router**, not as another general remote desktop or all-in-one AI runtime.
- Product headline: **Route the Project, Not Devices.** The user/agent addresses the project or workspace; the Router resolves the physical machine.
- Keep DevSpace as the execution layer; keep CodasSol focused on discovery, routing, workspace affinity, credentials, and policy.
- Security directions: per-action approvals, capability-scoped tokens, audit trails, token rotation/revocation, signed updates, protocol compatibility, least-privilege OS accounts, and optional secure relay/Tailscale integration.
- Routing directions: aliases/tags, capability routing (`gpu`, `cuda`, `macos`, `office`, `home`), load awareness, wake/sleep state, and explicit overrides.
- Consumer workflows: retrieve/send a file from any device, start a download/render at home, run a long task on a powerful desktop from a phone, collect files across machines, and operate home-lab devices without learning SSH.
- UI directions: small device dashboard, mobile command surface, approval notifications, activity timeline, and optional GUI/computer-use capabilities.
- Avoid growing into an all-in-one chat/model/orchestration platform until the routing layer itself is mature.
