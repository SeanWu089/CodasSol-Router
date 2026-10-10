# CodasSol Core v0.3 — Dynamic Ingress

**Status:** architecture approved; implementation in progress (not deployed).
**Principle:** **Route the Project, Not Devices.**
**Milestone:** **Single Endpoint · Dynamic Ingress · Distributed Nodes.**

## Product contract

The AI client configures **one** stable HTTPS MCP URL (the existing reserved
ngrok development domain). CodasSol may have an arbitrary number of registered
devices; **only the elected ingress host** needs a public ngrok Agent Endpoint.
Project ownership, not the incoming host, determines where work executes.

Each authorized online device is an independent Router/Node. Mac and Windows
must both be able to serve ingress while the other is powered off; an Android
node may serve ingress **only while its foreground/background service and
network capabilities demonstrably support it**. An iPhone/iPad cannot be
promised permanent background ingress under normal app lifecycle rules.
Offline devices remain discoverable as offline, not executable.

### Diagram

```text
                  ChatGPT / Codex / MCP client
                              |
                    fixed ngrok HTTPS URL
                              |
                    exactly one active Agent
                              |
                   Ingress host (movable)
                              |
                       CodasSol Core
                authentication + route owner
                              |
                   authenticated Peer Mesh
              /---------------+---------------\
        macOS Router     Windows Router     Android Node
           DevSpace          DevSpace       eligible only
```

## Separation of concerns

1. **Public ingress** is a disposable, movable transport binding. The fixed
   domain belongs to the ngrok account; its Agent process does **not** define
   device identity or workspace ownership. At most one active public Endpoint
   is the **target**, irrespective of N registered nodes.
2. **Router / Device Registry** uses immutable installation UUIDs, authenticated
   peer identity, explicit allowed roots, and verified execution health. Human
   display names and legacy Agent IDs never control endpoint ownership.
3. **Workspace routing** is pinned to the owner node and validated there.
   Ingress migration cannot silently rebind a workspace or replay a failed
   mutating command. Owner-side bindings and authenticated recovery precede
   any forwarded execution.
4. **Authentication** has three separate realms:
   - one stable *client-to-CodasSol* authorization/issuer, valid irrespective
     of current ingress host; credential material must be securely provisioned,
     rotated and revoked across eligible ingress nodes;
   - per-node *Router-to-Router* trust (mutual peer identity and tokens);
   - per-node *Router-to-local-DevSpace* OAuth kept on its executing node.
   Never forward client or DevSpace bearer credentials as peer credentials.
   A shared hostname **alone** does not make independent DevSpace OAuth
   sessions portable. Failover must fail closed until issuer and session
   continuity are tested end to end with the existing ChatGPT connector.

## Ingress Manager (platform-neutral Core)

Core owns an injectable, deterministic state machine, not platform commands:

- **NodeEligibility:** authenticated installation identity; Router and local
  execution backend ready; outbound peer connectivity; supported ingress
  adapter; permissions; uninterrupted service capability; user opt-in and
  power/network constraints. A healthy phone is not automatically an
  ingress-capable phone.
- **LeaderCandidate:** choose candidates using a deterministic preference
  (current healthy leader remains preferred; then user preference, host
  capability, installation UUID). Peer heartbeats aid discovery but are
  **not** a distributed lock.
- **IngressLease / Fencing:** a provider-authoritative exclusive ownership
  signal or external lease is REQUIRED before publishing the endpoint.
  Leases carry a monotonic epoch/fencing token and expiry; renewals enforce
  ownership. A candidate **must not** publish on a merely stale peer
  heartbeat. With no trustworthy coordinator/claim primitive, stay STANDBY
  or UNKNOWN rather than risk split brain.
- **IngressAdapter:** start/stop/probe only *our own* ngrok instance, bound
  to the existing reserved domain and local Router; report authoritative
  URL/ownership and startup failures; never stop an unrelated process.
  Platform-specific launchd, Windows Task Scheduler, and Android service
  adapters implement the same contract.
- **AuthContinuity:** validate public MCP OAuth discovery, authorization and
  token reuse across handovers; do not classify a mere HTTP health 200 as
  successful ChatGPT reconnection.

**State machine:** `DISABLED` -> `STANDBY` -> `CANDIDATE` ->
`ACTIVE` -> `DRAINING` -> `STANDBY`; any state may enter `FENCED`
on ambiguous ownership, loss of eligibility or claim failure. The
public listener cannot be started unless a current, verifiable claim belongs
to this installation. A second candidate must never be declared ACTIVE
based solely on a peer being unreachable.

**Network partition rule:** without a reliable third-party arbiter, perfect
availability and guaranteed single-writer ownership cannot be obtained from
two intermittently connected laptops. ngrok remains a hosted data plane.
It **may** also be usable as an authoritative exclusion mechanism, but the
actual behavior of this account, reserved domain, non-pooled endpoint conflicts,
disconnect cleanup and concurrent reconnects MUST be physically verified
before enabling automatic election. Endpoint Pooling is *not* an exclusive
leader lease and is disabled for the single-active-ingress design. If ngrok
does not expose an adequate claim/fencing primitive, introduce a tiny
provider-backed lease/coordinator (or document the weaker manual-failover
mode); do **not** pretend peer voting alone solves this.

## Release sequence

**v0.3-A: specification + pure Core (this first increment).** Introduce
platform-agnostic capabilities, eligibility, leader states and guarded
transitions with deterministic tests. Disabled by default. No production
ngrok process changes, credentials copied, or network endpoints opened.

**v0.3-B: transport and safe takeover lab.** Probe ngrok's same-domain
non-pooled collision/release semantics using an isolated test configuration,
then add a guarded Mac + Windows IngressAdapter with private credentials,
idempotent lifecycle, persisted epochs, explicit fencing and crash recovery.
Retain the known-good Mac tunnel until a reversible cutover is proven.

**v0.3-C: stable MCP client auth.** Client auth independent of local DevSpace
OAuth, provision and rotate secrets securely, preserve/recover workspace
affinity, test actual ChatGPT connector authorization both before and after
ingress migration.

**v0.3-D: devices.** Integrate Mac launchd and Windows scheduled tasks; add
capability-gated Android foreground-service support after physical device
tests. iOS/iPadOS start as clients/peers unless platform rules permit ingress
in a defined supported operating mode.

**v0.3-E: fault-injection and release.** Real Mac-off / Windows-on and
Windows-off / Mac-on trials, rejoin/split-brain tests, WAN blips, reboot,
token revocation, lost connectivity, and offline reporting. Only then merge
through `develop` to `main`. No release tag until explicitly requested.

## Phase 0 acceptance (all required)

- With Mac ON and Windows ON, fixed public URL opens both authorized
  workspaces and runs correctly pinned commands.
- With Mac OFF and Windows ON, that **unchanged** public URL authorizes a
  real MCP client, opens Windows workspace and executes a command; no Mac
  routing, SSH hop, or manual ngrok launch.
- Symmetric Windows OFF / Mac ON recovery, without changing client MCP URL.
- Failover does not expose raw Router/peer/admin endpoints unauthenticated,
  does not move workspace ownership, and fails closed on conflicting claims.
- N local nodes do not require N ngrok Endpoint slots; at most one live
  public ingress Endpoint, with documented outage while no eligible node runs.
- Timed handover, reconnection/auth failures, reboot recovery and mobile
  eligibility are reported honestly; a green health check alone is
  insufficient proof of executable routing.

## Git organization

`main` = verified releases; `develop` = integrated next release;
`feat/core-dynamic-ingress-v0.3` = cross-platform core architecture and
implementation. Existing `feat/mobile-android-v0` and Windows worktrees
remain separate until deliberate reviewed merges. Platform integrations
should use short-lived feature branches from this Core contract, not fork
election rules by operating system. Architecture/design is committed first,
followed by Core implementation commits. **No tag** at this stage.

## Sources / verification boundaries

- [ngrok endpoint creation](https://ngrok.com/docs/ai-gateway/guides/creating-endpoints)
  distinguishes short-lived Agent Endpoints from managed Cloud Endpoints.
- [ngrok Endpoint Pooling](https://ngrok.com/use-cases/api-gateway) provides
  shared-URL load balancing, **not** a single-holder lease.
- [ngrok plan limits](https://ngrok.com/pricing) limit simultaneous online
  Endpoints on Free plans; one-to-one per-device endpoints are not our goal.
- Existing v0.2 trusted peer Router design:
  [distributed routing v0.2](2026-10-08-distributed-routing-v0.2-design.md).

