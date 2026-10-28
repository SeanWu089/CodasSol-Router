import { request } from "node:https";
import { isIP } from "node:net";

// An optional private address pin changes only connection resolution. The URL
// remains the TLS/Host identity; certificate validation is never disabled.
export function createPinnedPeerFetch(connectAddress, requestFn = request) {
  const family = isIP(connectAddress);
  if (!family) throw new Error("Peer connectAddress must be an IP address");
  return async (url, options = {}) => {
    const target = new URL(url);
    if (target.protocol !== "https:") throw new Error("Address pins require HTTPS");
    return new Promise((resolve, reject) => {
      const req = requestFn(target, {
        method: options.method || "GET",
        headers: options.headers,
        signal: options.signal,
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions?.all) callback(null, [{ address: connectAddress, family }]);
          else callback(null, connectAddress, family);
        }
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) {
            req.destroy(new Error("Peer response exceeds 16 MiB"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("Peer response interrupted")));
        res.on("end", () => {
          const status = res.statusCode;
          if (status >= 300 && status < 400) {
            reject(new Error("Peer redirects are forbidden"));
            return;
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
        });
      });
      req.on("error", reject);
      req.end(options.body);
    });
  };
}
