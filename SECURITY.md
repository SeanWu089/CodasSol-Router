# Security Policy

CodasSol Router is intended to be self-hosted. The public repository contains
the framework; each user's deployment state and credentials must remain local.

## Current threat model

CodasSol V1 assumes that the Router owner controls the enrolled machines and
that remote Agents run under operating-system accounts whose permissions are
appropriate for the work they may perform.

The project currently provides routing boundaries, enrollment credentials,
per-device credentials, DevSpace allowed-root alignment, and fail-closed route
selection. It is **not** an operating-system sandbox and does not turn an
administrator/root account into a least-privilege execution environment.

Before using CodasSol across the public Internet, add a trusted private-network
or authenticated reverse-proxy layer and review the deployment carefully.

CodasSol can execute actions on real computers. Treat a Router credential as
high-impact infrastructure access, not as a convenience-app password.

## Deployment boundary

Do not commit or publish:

- tunnel credentials or fixed private tunnel URLs;
- device identities or pairing secrets;
- local project paths or project inventories;
- workspace-to-device bindings;
- private network addresses;
- access tokens, API keys, certificates, or private keys.

The router binds to loopback by default. Do not expose a router instance to the
public Internet unless the deployment has an explicit authentication and device
identity layer appropriate for that environment.

Public release builds intentionally do not embed the build machine's LAN Router
address. Private packaging may opt into a prefilled address explicitly with
`CODASSOL_ROUTER_URL`.

## Permission boundaries

- Keep DevSpace `allowedRoots` as narrow as practical.
- On Windows, prefer the user profile plus explicitly selected fixed data drives
  rather than the whole system drive.
- Run Agents as a normal user unless elevated privileges are truly required.
- Treat Agent tokens as device credentials and pairing tokens as enrollment
  credentials; do not reuse either for another purpose.
- Revoke/replace credentials after suspected disclosure.
- Do not assume a shell working directory is a security sandbox.

## Known hardening work

The roadmap includes explicit Agent revocation/token rotation, capability-scoped
permissions, audit logging, protocol/version compatibility checks, signed Agent
updates, and stronger release-artifact validation.

### Transport warning

The current Router/Agent protocol is HTTP at this layer. A remote Agent may
connect over a trusted LAN, or the Router may be placed behind a TLS-protected
private tunnel/reverse proxy. Do not expose the raw Router listener to an
untrusted network.

Until encrypted transport is built into CodasSol itself, assume that anyone
able to observe unprotected Router traffic could obtain bearer credentials.

### Least privilege

Each device should advertise only roots that the AI actually needs. On Windows,
the recommended installer profile exposes the user's profile and optional fixed
non-system drives instead of the whole system drive.

The DevSpace allowedRoots configuration and CodasSol Agent advertised roots
must remain synchronized. v0.1.1 added installer support for this invariant.

Public release bundles must not contain private Router addresses or deployment
metadata. v0.1.2 removed the build-machine LAN address from public bundles by
default.

### Fail-closed routing

CodasSol rejects ambiguous device matches, offline matching devices, and
attempts to silently move an existing workspace binding to another device.
These checks are security-relevant and should not be weakened merely to make
routing more convenient.

## Current hardening gaps

The project is early-stage. Before treating it as Internet-facing or multi-user
infrastructure, additional hardening is expected, including:

- encrypted Router/Agent transport or mutually authenticated TLS;
- pairing-token rotation / single-use enrollment grants;
- device-token rotation and revocation;
- explicit per-tool/per-device policy and approval controls;
- tamper-evident audit logging;
- signed release artifacts and signed/verified auto-update;
- rate limiting and enrollment abuse protection;
- stronger multi-user identity and authorization boundaries.

## Reporting a vulnerability

Please report security issues privately through GitHub's security reporting
features rather than opening a public issue containing exploit details,
credentials, or sensitive deployment information.

