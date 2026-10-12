# Thoughts

## v0.3 transport decision — lightweight Single Ingress (2026-10-10)

### Local implementation checkpoint (2026-10-12)

- Added **opt-in-by-new-code SSE-first Agent transport** using the existing
  enrolled per-device bearer token: authenticated
  `GET /_codassol/agent/events` streams `ready`/`job` frames and periodic
  SSE keepalive comments; existing authenticated `POST /agent/result` is
  unchanged. A positive `POST /agent/heartbeat` is still required every
  ~60 seconds; one-way SSE keepalive alone is **not** proof of client health.
- One consumer per device is enforced; legacy HTTP polling is retained for
  servers without SSE support, and a single poll is attempted after repeated
  transient stream failures. Reconnects use exponential backoff with jitter,
  bounded output buffering, and no automatic replay of delivered commands.
  Expired, unclaimed jobs are purged from the queue.
- **Validated only in an isolated Mac loopback test Router**, including
  live SSE Agent execution/error-result POST, auth rejection, duplicate
  subscription rejection, fallback detection, shutdown, and no stale queued
  mutations. Not deployed to the live Mac Router/DevSpace/ngrok installation,
  not tested on ngrok HTTPS, and **not** a working Dynamic Ingress takeover.
  Ownership fencing, shared OAuth acceptance and real dual-host cutover
  remain separate unfinished milestones.

**Architecture keywords:** `Single Stable MCP URL` · `Sticky Leader` ·
`Passive Failover` · `HTTPS SSE (Server-Sent Events)` ·
`Outbound-Only Agent` · `HTTP POST Result` · `Heartbeat/Keepalive` ·
`Reconnect + Exponential Backoff + Jitter` · `Endpoint Exclusivity (no Pooling)` ·
`Fencing/Single Active Ingress` · `OAuth Continuity` ·
`Device Registry` · `Workspace Affinity` · `Intelligent Routing` ·
`Fail Closed` · `No Command Replay`.

- **Decision (design baseline, not yet production-validated):** prefer one
  authenticated outbound HTTPS SSE stream per standby device to the *current*
  Router over the single public ngrok URL. Ingress pushes task/heartbeat events;
  device executes only its own authorized local DevSpace tasks and reports
  results via normal HTTPS POST. Empty idle periods need no new HTTP request.
  Keep SSE connection health distinct from actual endpoint-ownership authority.
- **Stable ownership:** whichever eligible node currently holds the public
  hostname keeps it (Sticky Leader); no proactive re-election, no preferred
  permanent Mac, and a recovered former leader stays standby. On suspected
  failure, check local connectivity, attempt *non-pooled, provider-exclusive*
  hostname acquisition with bounded backoff/jitter, and confirm identity before
  serving MCP. Never activate two owners. ngrok's exclusivity/release/fencing
  behavior is **not yet proven** in real Mac↔Windows cutover tests.
- **Budget:** ngrok Free lists 20k HTTPS requests and 1 GB transfer/month
  (account-wide); a stream's periodic SSE comment frames are not separate HTTP
  requests but do consume bytes. If reconnecting hourly, one standby uses
  ~720 stream-opening requests/30 days; frequent disconnects can raise this
  substantially. Measure actual usage and streaming timeouts, not estimates.
- **Historical distinction:** original v0.1 Windows Agent used HTTPS outbound
  `agent/heartbeat`, `agent/poll`, `agent/result` through Mac's ngrok URL:
  **no Tailscale required**. v0.2 also added a direct peer-Router HTTPS path
  over Tailscale as *one implementation*, not a product prerequisite. Prefer
  minimal incremental evolution of the original queue/auth/agent protocol.
- **Why not alternatives:** high-frequency short polling costs too many
  requests; HTTP long polling remains the compatibility fallback; WebSocket
  adds unnecessary bidirectional channel management for simple text tasks;
  ngrok Endpoint Pooling load-balances incoming MCP requests across replicas,
  breaking our sticky single-owner assumption without shared session/state.
  Fully cloud-hosted coordination and extra per-device public endpoints are
  intentionally out of scope for this lightweight baseline.
- **Failure/safety limitations:** SSE disconnect alone does not prove the
  leader died. Network partitions, ngrok delayed release, proxy buffering,
  stream idle timeouts, reconnection storms and Mac/Windows OAuth token
  interoperability must be tested. An in-flight or mutating command is never
  automatically retried after an ownership change. If ngrok does not enforce
  adequate ownership fencing, a small authoritative external claim mechanism
  is required; do not ship an unsafe dual-owner approximation.
- **Source references (checked 2026-10-10):**
  https://ngrok.com/pricing ;
  https://ngrok.com/compare/cloudflare-tunnel ;
  https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events ;
  https://ngrok.com/blog/self-hosting-with-and-without-ngrok .

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
