# Thoughts

## v0.3 transport decision — lightweight Single Ingress (2026-10-10)

### Opt-in dynamic OAuth client registration (2026-10-12)

- Added constrained RFC7591 public client registration at `POST /register`
  when an OAuth issuer, owner consent service AND dynamic-client registry
  are explicitly injected. Accepts public `token_endpoint_auth_method=none`,
  authorization-code+PKCE and optional refresh grants; accepts only exact
  HTTPS or loopback-HTTP redirect URIs, rejects credentials/fragments,
  conflicting metadata and unsafe callbacks. Registration yields a random
  secretless `client_id`. A single-machine atomic file registry survives
  local restarts, caps at 512 clients and has a persisted rate limit.
- The authorization-code and token HTTP handlers re-read the registered
  client list from the configured authority before accepting new grants.
  OAuth discovery advertises `registration_endpoint` only when DCR is
  enabled. No arbitrary remote Client ID Metadata URLs are fetched, so this
  design intentionally avoids the related SSRF surface. Complete loopback
  test: dynamic registration → consent → PKCE → bearer and refresh issued.
- **Still not physical cross-host-ready:** dynamic client registry currently
  uses a local file, not an independently fenced shared authority; it needs
  the same replication/fencing work as refresh grants and revocations.
  The production Router has not been migrated, and no physical ChatGPT
  DCR browser roundtrip has been performed.

### Public MCP authorization split — experimental Mac implementation (2026-10-12)

- **Verified architecture, not an OAuth login rollout:** split the public
  CodasSol MCP resource token from each machine's **local DevSpace OAuth**
  token. An opt-in `CODASSOL_PUBLIC_AUTH_FILE` loads a *pinned*, Ed25519
  public-key verifier for access tokens bound to the stable HTTPS
  `https://<fixed-domain>/mcp` audience. Exactly the same signed test
  bearer was accepted by two independent Router instances (Mac/Windows
  simulated on loopback); local MCP calls obtain a fresh node-local
  DevSpace credential via `peerOAuth`, while remote jobs exclude the
  incoming public bearer entirely. Existing Mac DevSpace tokens deliberately
  fail in this opt-in mode; the legacy installed Router is unchanged.
- **OAuth resource boundary:** protected resource metadata is served at
  `/.well-known/oauth-protected-resource` and `.../mcp`; 401 includes a
  stable `WWW-Authenticate: Bearer resource_metadata` reference.
  Wrong audience, issuer, signature, scope, expiry, and revoked JWT IDs
  fail closed. A stale revocation snapshot also fails closed (currently
  5-minute freshness by default). Trust material is provisioned out of
  band; the incoming JWT cannot nominate its own JWKS or signing key.
  Unmatched public paths and invalid MCP JSON cannot fall through to the
  legacy raw DevSpace proxy.
- **Incomplete and intentionally disabled:** `/authorize`, `/token`,
  `/register` and OAuth discovery server endpoints return 503 in this
  experimental mode, because public **login, PKCE authorization codes,
  refresh tokens, client provisioning and shared revocation authority** are
  not yet implemented. MCP GET/DELETE stream/session affinity also remains
  unimplemented and returns 405. These must be completed before enabling
  this mode for ChatGPT. The first transition away from the existing Mac
  DevSpace-issued token **may require one explicit reauthorization**;
  only subsequent ingress switches should be seamless.
- The provisional `src/ingress/client-access-tokens.js` and its tests are
  unrelated pre-existing untracked proof-of-concept files; do not amend
  or silently include them in this implementation's commit.
- Reference: MCP authorization spec
  https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/authorization.mdx

### Public OAuth authorization-code core (2026-10-12)

- Added an **isolated** Ed25519 OAuth authorization-code issuer core
  (`PublicOAuthPkceGrants`), with mandatory S256 PKCE, exact pre-registered
  client/redirect allowlist, fixed MCP resource indicator, affirmative
  owner-approval input, short-lived one-time authorization codes, and
  10-minute resource/audience-bound JWT access tokens. A token issued by
  this module passes the independent pinned-public-key verifier on a
  different simulated Router. Tests reject mismatched redirects, wrong
  resource, absent owner approval, plain PKCE, replay, bad verifier and
  expired codes.
- **No web endpoint is connected to the grant issuer.** The required
  browser login/owner approval, client registration/discovery, consent UI,
  durable grant storage, refresh-token family replay protection, shared
  revocation state, and key rotation must be built and physically verified.
  In-memory authorization codes do not survive a mid-login ingress cutover.
  Therefore this is a building block, **not a production-ready OAuth server**.

### Opt-in OAuth consent, refresh rotation and local persistence (2026-10-12)

- Implemented `RefreshTokenRotation`: 48-byte random refresh secrets are
  persisted only as SHA-256 digests; each redemption atomically spends the
  old token and issues a new token in the same family, with a bounded
  absolute expiry. Reuse of an old token revokes its entire family,
  including descendants, and a distinct client/resource cannot redeem it.
  Concurrent cross-node refresh uses a **test-only shared serializable
  authority**; exactly one redemption wins, subsequent replay invalidates
  that family. Access JWTs minted before refresh family revocation remain
  independently valid until expiry unless access-token JTI revocations are
  synchronized. No automatic replay of a timed-out refresh is safe.
- `LocalRefreshAuthority` provides single-machine durable atomic
  state-file replacement, fsync and bounded exclusive lock acquisition;
  a possibly stale lock intentionally fails closed rather than
  unilaterally being stolen. It is **NOT** a distributed authority, even
  if two physical hosts point at the same network-mounted filename.
  Actual Mac→Windows continuity needs a trusted externally fenced,
  serializable state provider. Using the same local test file for two
  loopback Routers does not demonstrate cross-host replication.
- Added `POST /token` with strict form parsing, explicit code or refresh
  grant types, cache-preventing headers, rotating refresh tokens, and
  correctly surfaced `invalid_grant` vs `temporarily_unavailable`.
  Added opt-in `GET/POST /authorize` consent flow for **pre-registered
  client IDs only**, using a separately generated, five-minute,
  one-use 256-bit owner approval code from the trusted local CLI
  (`node src/router-cli.js oauth-approval-code`). The browser never
  receives the Router's durable admin/pairing secrets. Consent page
  displays the exact registered redirect and scope, escapes inputs,
  applies restrictive CSP, checks callback allowlist and S256 PKCE before
  consuming the local approval code, and returns code/state only to the
  registered callback. Includes Authorization Server Metadata discovery
  only if BOTH an OAuth issuer and approval store are deliberately
  injected into the runtime.
- Full local integration covers consent → browser redirect → code
  exchange → refresh and a simulated two-Router HTTP token handoff,
  including wrong callbacks, invalid approval codes, replay and
  concurrent rotation. Node test suite 109/109 plus Mac tests pass.
- **Hard launch blockers:** no user-ready OAuth startup/provisioning flow;
  dynamic client registration (or verified Client ID Metadata Documents)
  not implemented; local approval issuance requires trusted local CLI;
  no provider-fenced shared grant storage or fresh synchronized revocation
  authority; current public-MCP verifier's static revocation snapshot
  becomes stale after 5 minutes; no real ChatGPT browser OAuth test or
  physical ngrok Mac↔Windows handoff. Do **not** enable this development
  OAuth mode on the production MCP ingress.

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

### Independent Router as outbound SSE standby (2026-10-12)

- Added `src/standby-router-agent.js` as an explicit, **opt-in**
  pairing and execution wrapper that lets a fully independent Router
  also act as its own outbound SSE Agent. It reuses the authenticated
  `enroll / heartbeat / events / result` protocol rather than requiring
  an incoming per-device peer endpoint or Tailscale. The pairing token
  is used transiently and not stored; the local config pins immutable
  Router `installationId`, `device.id`, authorized roots and exact
  loopback DevSpace endpoint. A wrong installation, target, or backend
  fails closed. Active leaders cannot start the standby channel.
- Two **independent Router runtimes started on Mac loopback** passed
  an end-to-end test: Mac Router enqueued a task for the simulated
  Windows Router, which consumed SSE and executed against its own
  mocked local DevSpace using only a local OAuth bearer. Result returned
  to Mac. Neither Router had a configured PeerMesh peer or VPN path.
- **Not installed on physical Windows.** No live dual-host ngrok handoff,
  no persistent bidirectional Agent credential replication, and no
  seamless re-enrollment after leadership changes. This wrapper is a
  building block; future role changes must safely stop outbound work
  before enabling a newly fenced ingress.

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
