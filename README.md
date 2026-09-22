# CodasSol Router

CodasSol Router is an experimental, self-hosted routing layer for connecting
multiple computers behind one MCP-facing entry point.

The core idea is simple: keep DevSpace on each machine as the execution backend,
and put a small router in front of them that can discover devices, bind a
workspace to the right machine, and fail closed when routing is ambiguous.

    CodasSol Router
        |
        +-- Mac / Linux Agent -> DevSpace -> local projects
        |
        +-- Windows Agent     -> DevSpace -> local projects

This repository is the **public framework**, not a hosted service and not a
copy of any particular user's deployment. Real device names, credentials,
project paths, tunnel configuration, and workspace bindings belong in local
private state and should never be committed.

## Current status

The current V1 is intentionally conservative: it transparently proxies MCP
HTTP traffic to one DevSpace backend while preserving streaming and upstream
authentication behavior. The routing core now includes device presence,
platform-aware project-root matching, fail-closed device selection and
persistent workspace-to-device bindings. A Windows outbound agent and live MCP
integration are the next transport layer.

## Start

```bash
npm start
```

Defaults:

- Router: `127.0.0.1:17676`
- Mac DevSpace backend: `127.0.0.1:7676`
- Health: `http://127.0.0.1:17676/_codassol/health`

Optional environment variables:

```bash
CODASSOL_LISTEN_HOST=127.0.0.1
CODASSOL_LISTEN_PORT=17676
CODASSOL_BACKEND_HOST=127.0.0.1
CODASSOL_BACKEND_PORT=7676
CODASSOL_BACKEND_TIMEOUT_MS=15000
```

V1 deliberately does not modify DevSpace, ngrok, or the existing `start-devspace-ngrok.sh`.

## Public framework vs. private deployment

The repository stays generic. Your local deployment state should live outside
the repository, for example under `~/.codassol/`, and contain device
registrations, workspace bindings, credentials, and machine-specific settings.

The default listener is loopback-only. If you use a tunnel or reverse proxy,
keep credentials outside the repository and treat your own deployment as a
private service.

## Security

See [SECURITY.md](SECURITY.md). In particular, do not publish real device
identities, local paths, pairing secrets, tunnel credentials, or workspace
binding state.

## License

MIT.
