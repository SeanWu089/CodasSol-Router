# CodasSol Router V1 Design

## Goal

Introduce a routing layer in front of DevSpace without changing the currently working Mac path:

```text
ChatGPT -> existing ngrok -> Mac DevSpace :7676
```

The existing path remains untouched during development. The new router runs on a separate local port and is tested side-by-side.

## V1 Scope

V1 is intentionally small:

1. Run a local CodasSol Router on `127.0.0.1:17676` by default.
2. Transparently proxy MCP HTTP traffic to the current Mac DevSpace at `127.0.0.1:7676`.
3. Expose a router-only health endpoint for diagnostics.
4. Fail safely when the backend is unavailable. A failed proxy request must not trigger retries of mutation requests.
5. Keep routing configuration explicit and environment-variable driven.

V1 does **not** change ngrok, DevSpace configuration, `publicBaseUrl`, the current start script, or any StudentAlbum configuration.

## Architecture

```text
                         current production path (unchanged)
ChatGPT ----------------> ngrok ----------------> DevSpace :7676

                         side-by-side V1 test path
local test client ------> Router :17676 --------> DevSpace :7676
```

After V1 proves transparent, later phases can place the existing ngrok endpoint in front of Router.

## Router Components

- `server`: HTTP entry point and streaming reverse proxy.
- `config`: validates listen/backend host and port configuration.
- `health`: reports router status and whether the configured Mac backend is reachable.
- `errors`: converts transport failures into deterministic 502 responses without retrying the original request.

No request-body interpretation is required for V1. This reduces the chance of breaking MCP framing or streaming behavior.

## Safety Rules

- Bind to loopback by default.
- Never modify `127.0.0.1:7676` or its process.
- Never invoke `devspace config set`.
- Never invoke or reconfigure ngrok.
- Never retry failed POST/PATCH/DELETE requests automatically.
- Health checks use a separate lightweight TCP probe, not replayed MCP requests.
- Router shutdown affects only the Router process.

## Validation

Automated tests will verify:

- request method/path/query/body forwarding;
- response status/headers/body forwarding;
- chunked/streamed responses are passed through;
- backend connection failure returns 502;
- mutation requests are attempted exactly once;
- health endpoint works independently of MCP proxying.

A live smoke test will compare the direct Mac DevSpace response and the Router response for a non-mutating request while the existing 7676/ngrok path continues running.

## Next Phase

Once transparent proxying is proven, add:

1. device registry and heartbeats;
2. first-open device resolution;
3. persistent `workspace_id -> device` binding;
4. Windows outbound Agent;
5. ambiguity/offline fail-closed behavior;
6. only then switch the public ngrok endpoint from DevSpace to Router.

