# Thoughts

## v0.3 transport decision — lightweight Single Ingress (2026-10-10)

### Public owner identity preflight (2026-10-12)

- HTTP 200 `/_codassol/health` is **not an ingress ownership proof**: the
  fixed domain might still point to the previous Mac when Windows tries
  to take over. Implemented an ephemeral per-Router HMAC challenge endpoint
  `POST /_codassol/ingress/proof`. A candidate verifies an unpredictable
  fresh challenge *through the configured public HTTPS domain* against its
  private, in-process proof verifier. This requires no remote admin bearer
  token, exposes no installation UUID or shared credential, rejects false
  positives from a wrong Router, ngrok warning page and bad responses.
- The `NgrokAgentIngressAdapter` now requires this **public instance
  verification** after a claimed launch, before it can return readiness
  to the IngressManager. Failure closes the exact newly owned launcher
  handle and keeps the manager FENCED. Loopback integration tests use two
  real Router instances; live ngrok is NOT reconfigured.
- **Critical scope:** HMAC ownership proof establishes **which Router is
  currently answering public requests**. It does **not** guarantee ngrok
  provider-side non-pooling exclusivity, safe fencing after network
  partitions, or OAuth continuity. Those remain prerequisites before
  automatic takeover can be enabled.

### Gated ingress supervisor (2026-10-12)

- Added `IngressSupervisor`, a serialized, opt-in scheduler for the fenced
  `IngressManager`. It consumes **fresh** local/peer capability snapshots,
  renews the current leader without restarting ngrok, and drains on missing
  health data, failed candidate discovery or explicit stop. Discovery has
  a bounded timeout; a hung callback cannot keep an ACTIVE listener alive
  forever. Stop waits for in-flight checks and will not report clean
  shutdown if the manager cannot deactivate its owned endpoint.
- Synthetic two-supervisor tests cover single owner under a shared injected
  authority, clean takeover after release, health loss, hanging discovery,
  concurrent ticks, and stop/activation races. **The mock authority is not
  an ngrok provider guarantee.** The scheduler is not wired into the live
  Mac LaunchAgent or allowed to start a production tunnel.
- This provides the remaining orchestration skeleton, not automatic
  takeover: real ngrok fencing/claim semantics, a provider-enforced launcher,
  candidate discovery based on trusted identities, and ChatGPT OAuth
  continuity are still outstanding.

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

### Verification checkpoint — isolated tests only (2026-10-12)

- **PASS:** authenticated SSE task delivery/result POST over a local
  streaming HTTP reverse proxy; Sticky Leader keeps Windows active after a
  simulated Mac recovery; simulated simultaneous acquisition during a peer
  partition activates only one host **when a true exclusive lease provider
  is injected**. Full Node suite: 78/78 pass.
- **Live production ingress read-only checks PASS:** Mac local Router health
  HTTP 200, same public ngrok domain health HTTP 200, unauthenticated public
  MCP HTTP 401, local ngrok Agent inspection matches expected Router upstream.
  This does **not** verify user OAuth across machines or public SSE transport.
- **BLOCKED:** direct Mac-to-Windows peer HTTPS probe timed out, so there is
  no physical two-host takeover result. macOS Tailscale CLI was unavailable
  in this worktree's shell (not proof the network itself is absent).
- **Do not disturb production:** ngrok's Free plan currently permits one
  assigned development domain. Starting an isolated second public ngrok
  endpoint on this same account could conflict with the current domain;
  no such competing endpoint was launched. ngrok documentation says its
  dev domain forwards SSE, but actual ngrok SSE behavior and **same-domain
  exclusivity/fencing** remain untested on these devices.

### Agent presence correction (2026-10-12)

- Found a real mismatch: the new SSE Agent positively heartbeats every 60
  seconds, while Device Registry previously expired ALL heartbeat Agents
  after 30 seconds. A healthy SSE subscriber could therefore appear offline
  for half of its heartbeat cycle. **Fix:** set a per-Agent 90-second TTL
  only after an authenticated SSE subscription is established; preserve the
  legacy 30-second TTL for non-SSE Agents. Revert to 30 seconds when SSE
  disconnects **without refreshing lastSeenAt** (disconnect is not proof of
  positive liveness). Tested with a simulated clock and real local SSE setup.
- The original SSE Agent comment overestimated quota: one positive POST
  heartbeat per 60 seconds is approximately **720 requests / 30 days**
  per node, not 1,440; add SSE handshakes, reconnects, job results, and
  MCP requests when estimating ngrok Free account consumption.
- **Still blocked:** real handoff needs working Windows connectivity,
  externally enforced ownership/fencing, and **independent OAuth continuity**.
  Signed-token proof-of-concept files remain separate/unintegrated.

### Queued-job safety and compatibility economics (2026-10-12)

- A job can be written into an SSE socket buffer but not processed until
  after the ingress caller has already timed out. To prevent an old command
  from starting late, new `AgentHub.enqueue` envelopes include
  `expiresAt = createdAt + timeoutMs`. The v0.3 Agent rejects an expired
  envelope **before** local DevSpace execution (both SSE and polling paths).
  This does not cancel a command that started before expiry; such work
  remains in-flight/uncertain across failover and must never be auto-replayed.
  Legacy Router jobs without `expiresAt` are allowed for rolling upgrades.
- **Fallback tradeoff:** the original `/agent/poll` waits up to ~25 seconds,
  so an always-connected idle Agent may issue approximately **103,680 public
  polling requests per 30 days**, before heartbeat POSTs. A long-term
  installation cannot depend on this fallback with ngrok Free's 20k-request
  monthly quota. Compatibility fallback must be temporary, explicitly
  quota-budgeted or deliberately much slower if a Router cannot do SSE.

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
