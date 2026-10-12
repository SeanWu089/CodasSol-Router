# CodasSol v0.3 — external witness (experimental)

This is a **separate Cloudflare Durable Object**, not a replacement for the
existing ngrok MCP endpoint. It witnesses (1) a single short-lived coordinator
lease with a monotonically increasing epoch and (2) a global, gapless sequence
of committed OAuth checkpoint digests. No OAuth secrets or patient/project
content is stored here.

**Do not deploy this against the live Mac Router yet.** Deployment is opt-in,
and no credentials, Cloudflare account, or physical Windows device have been
configured or tested in this branch.

## Why Durable Objects?

Cloudflare's SQLite-backed Durable Objects have a single strongly consistent,
transactional storage owner. The Worker runs every read/change inside
`ctx.storage.transactionSync()`, avoiding cross-process filesystem locks and
eventually consistent KV races. Both Mac and Windows must use the **same**
`codassol-v03-primary` Durable Object.

Docs: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
and https://developers.cloudflare.com/durable-objects/platform/pricing/

Check current plan eligibility, quota and billing in the **actual Cloudflare
account** before deploying. Existing ngrok billing and request budgets are
separate.

## Setup (future, opt-in)

1. Ensure Cloudflare Workers access with SQLite-backed Durable Objects.
   Set `CODASSOL_PUBLIC_DOMAIN` in `wrangler.jsonc` to your exact, bare
   fixed `https://...` MCP origin; deployment starts with a deliberately
   unusable placeholder until this is configured.
2. Generate **two separate 256-bit random hex bearer tokens** using a
   trusted local secrets manager; never commit or paste them into issues.
3. From this directory, deploy with the current Wrangler CLI. Configure the
   Cloudflare Worker secret `CODASSOL_NODE_TOKENS` as a JSON object mapping
   immutable installation IDs to their 64-character random hex tokens.
   Use `wrangler secret put CODASSOL_NODE_TOKENS` to enter it securely.
4. Configure each Router independently with its own
   `CloudflareWitnessAuthority` client with the same exact `publicDomain`
   pointing to the new HTTPS
   `*.workers.dev` endpoint. Keep these secrets out of command-line
   arguments, logs, GitHub and the public browser.
5. Test acquire/verify/renew/release, commit monotonicity, simultaneous
   claims, stale epochs and real network partitions **before** any ingress
   activation is permitted.

## Important boundaries

- `CloudflareWitnessAuthority.enforcesExternalFencing` is **false** by
  design. The witness cannot stop a stale ngrok process serving traffic.
  The existing `NgrokAgentIngressAdapter` therefore **must reject it**
  as a stand-alone ingress authority. Provider/data-plane enforcement
  needs separate real-world verification.
- A witness lease is permanently pinned to one `publicDomain`, and
  requests for a different public origin are rejected.
- The opt-in `MirroredAuthWriter.commitPublisher` callback and
  `createWitnessCommitPublisher()` adapter now provide the **post-commit
  witness publication hook**. It runs only AFTER the standby has verified
  its signed COMMITTED certificate and BEFORE OAuth issuance succeeds.
  Set `requireExternalCommit: true` when constructing a test writer, and
  inject a current lease claim using `getClaim`. An unavailable or
  ambiguous witness confirmation fails closed, with no automatic retry.
  The full provisioned runtime, recovery logic, and production activation
  still are NOT wired, so promotion MUST remain disabled.
- No automatic lease takeover can be claimed safe while the old ngrok
  Agent may still be answering requests. Do not enable the existing
  `IngressSupervisor` in production.
- Do not let a prepared-only replica become authoritative. OAuth
  state is not recoverable merely from an epoch or an ngrok domain.
- The witness is the *one trusted coordination service* shared by hosts.
  Its outage must fail closed, even if that means temporary unavailability.
- This service uses installation bearer tokens (one per node). Actual
  production hardening requires rate limiting, rotating identities,
  auditing, secure Cloudflare account administration, and deletion and
  restore procedures for the Durable Object.

## Development checks

The pure state machine lives in
`src/ingress/cloudflare-witness-core.js`, the fail-closed Node HTTP
client in `src/ingress/cloudflare-witness-authority.js`, and Node tests in
`test/cloudflare-witness.test.js`. The worker itself is
`deploy/cloudflare-witness/worker.js`.

Run `node --test test/cloudflare-witness.test.js` and `npm test` in a
checked-out worktree once remote Mac access is restored. An isolated
GitHub Actions workflow is present, but a passing workflow result has not
been confirmed. Then run
`wrangler dev` or an isolated Workers deployment test; the Cloudflare
runtime and physical dual-host cutover have **not** been validated yet.

This code was developed on a **new GitHub-only feature branch** while the
Mac's existing CodasSol MCP returned HTTP 404. It was not installed on the Mac.
