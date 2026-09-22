import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade"
]);

function filteredHeaders(headers) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

export function probeBackend(config, timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: config.backendHost,
      port: config.backendPort
    });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function createRouterServer(config = loadConfig()) {
  return http.createServer(async (req, res) => {
    if (req.url === "/_codassol/health" && req.method === "GET") {
      const backendReachable = await probeBackend(config);
      const payload = JSON.stringify({
        ok: true,
        backend: {
          host: config.backendHost,
          port: config.backendPort,
          reachable: backendReachable
        }
      });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store"
      });
      res.end(payload);
      return;
    }

    const upstream = http.request(
      {
        host: config.backendHost,
        port: config.backendPort,
        method: req.method,
        path: req.url,
        headers: {
          ...filteredHeaders(req.headers),
          host: `${config.backendHost}:${config.backendPort}`
        },
        timeout: config.backendTimeoutMs
      },
      (upstreamRes) => {
        res.writeHead(
          upstreamRes.statusCode || 502,
          upstreamRes.statusMessage,
          filteredHeaders(upstreamRes.headers)
        );
        upstreamRes.pipe(res);
      }
    );

    upstream.once("timeout", () => {
      upstream.destroy(new Error("backend timeout"));
    });

    upstream.once("error", (error) => {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      const payload = JSON.stringify({
        error: "backend_unavailable",
        message: "CodasSol Router could not reach the selected backend. No retry was attempted."
      });
      res.writeHead(502, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store"
      });
      res.end(payload);
    });

    req.once("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });
}

export async function startRouter(config = loadConfig()) {
  const server = createRouterServer(config);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listenPort, config.listenHost, resolve);
  });
  return server;
}

const isMain = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const config = loadConfig();
  const server = await startRouter(config);
  console.log(
    `CodasSol Router listening on http://${config.listenHost}:${config.listenPort} -> http://${config.backendHost}:${config.backendPort}`
  );
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
