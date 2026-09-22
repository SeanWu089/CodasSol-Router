# Security Policy

CodasSol Router is intended to be self-hosted. The public repository contains
the framework; each user's deployment state and credentials must remain local.

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

## Reporting a vulnerability

Please report security issues privately through GitHub's security reporting
features rather than opening a public issue containing exploit details,
credentials, or sensitive deployment information.

