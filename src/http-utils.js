export async function readJsonBody(req, { maxBytes = 1_000_000 } = {}) {
  const buffer = await readBody(req, { maxBytes });
  const text = buffer.toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

export async function readBody(req, { maxBytes = 20_000_000 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Request body too large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res, statusCode, value) {
  const payload = JSON.stringify(value);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}

export function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

