# v0.3 ingress: offline configuration contract

**Experimental only. The existing Mac Codas! LaunchAgents are unchanged.**

The v0.3 public OAuth, mirrored authorization state and Cloudflare witness
must be provisioned separately. Startup wiring alone does not deploy the
witness, acquire a lease, or switch ngrok.

## Private configuration

Keep a separate JSON configuration file with mode 0600 on macOS/Linux.
Never commit this file, or copy credentials into any documentation or logs.

```json
{
  "version": 1,
  "installationId": "YOUR_EXISTING_IMMUTABLE_DEVICE_ID",
  "publicDomain": "https://your-fixed-ngrok-origin.example",
  "role": "leader",
  "witness": {
    "endpoint": "https://your-isolated-witness.workers.dev",
    "secret": "REPLACE_WITH_A_SEPARATE_64_CHARACTER_RANDOM_HEX_TOKEN"
  },
  "claimFile": "/absolute/private/lease-claim.json",
  "authStateFile": "/absolute/private/oauth-state.json"
}
```

The active Router uses role `leader`. A standby uses `follower`.
The state file is an atomically committed `MirroredAuthWriter` state
for the leader, or a signed and COMMITTED `AuthReplicaStore` for the
follower. A PREPARED-only snapshot never authorizes a public request.

The claim file must be atomically replaced by a fenced lease supervisor:

```json
{
  "ownerId": "YOUR_EXISTING_IMMUTABLE_DEVICE_ID",
  "epoch": 4,
  "expiresAt": 1890000000000,
  "fencingToken": "CURRENT_PRIVATE_OPAQUE_LEASE_SECRET"
}
```

**Do not invent a live lease token.** A tested, *opt-in library*
`WitnessLeaseKeeper` can acquire, renew, atomically persist and invalidate
a private claim using the configured Cloudflare witness client, but it is
not wired to an always-on service and does not schedule itself. There
is no installed lease supervisor or automatic tunnel handoff yet.
Every public request checks the claim and externally verifies its
ownership and latest committed version.

The public OAuth verifier also needs a separate private provisioning file,
configured via `CODASSOL_PUBLIC_AUTH_FILE`. If using replicated
revocations, point it to the matching live revocation state file.

## Isolated Router startup

Only for an explicitly isolated v0.3 test process, set:

```shell
CODASSOL_PUBLIC_AUTH_FILE=/absolute/private/public-auth.json
CODASSOL_PUBLIC_INGRESS_FENCE_FILE=/absolute/private/v03-ingress.json
CODASSOL_REQUIRE_PUBLIC_INGRESS_FENCE=1
```

The startup loader compares the file with the actual installed Router
installation ID and public OAuth issuer. Missing configuration, wrong
identity, unsafe file permissions, or missing OAuth verification fail
closed; requests cannot fall through to the unprotected public MCP path.

The read-only local preflight command is:

```shell
node scripts/check-public-ingress.mjs /absolute/private/v03-ingress.json YOUR_IMMUTABLE_DEVICE_ID https://your-fixed-ngrok-origin.example
```

It prints no bearer secret, performs no cloud request, and never starts
or stops a service. It distinguishes validated private configuration from
locally committed auth state and the presence of a local claim.
Exit 2 means local state/claim is not ready; exit 1 means configuration
is unsafe or invalid. Even exit 0 **does not verify remote lease or ngrok
ownership**; only a real external witness and live data-plane check can
establish that.

## Hard production blockers

- Cloudflare Durable Object witness is not deployed to a verified account
  with independent device secrets.
- There is no physical Mac/Windows lease-renewal and credential provisioning
  service yet; no crash-safe cross-epoch state reconciliation.
- ngrok data-plane uniqueness and failover for this fixed domain remain
  unverified. An old tunnel can keep receiving traffic even when requests
  are application-fenced.

**Never set these v0.3 variables on the live Mac Codas! LaunchAgent.**
