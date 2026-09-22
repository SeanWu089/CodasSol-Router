# CodasSol Router

Side-by-side routing layer for CodasSol. V1 transparently proxies MCP traffic to the existing Mac DevSpace without changing the current ngrok path.

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
