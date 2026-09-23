function parsePort(value, fallback, name) {
  const raw = value ?? String(fallback);
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function splitRoots(value) {
  if (!value) return [];
  return String(value)
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  return {
    listenHost: env.CODASSOL_LISTEN_HOST || "127.0.0.1",
    listenPort: parsePort(env.CODASSOL_LISTEN_PORT, 17676, "CODASSOL_LISTEN_PORT"),
    backendHost: env.CODASSOL_BACKEND_HOST || "127.0.0.1",
    backendPort: parsePort(env.CODASSOL_BACKEND_PORT, 7676, "CODASSOL_BACKEND_PORT"),
    backendTimeoutMs: Number.parseInt(env.CODASSOL_BACKEND_TIMEOUT_MS || "15000", 10),
    stateDir: env.CODASSOL_STATE_DIR,
    localDeviceId: env.CODASSOL_LOCAL_DEVICE_ID || "local",
    localDeviceLabel: env.CODASSOL_LOCAL_DEVICE_LABEL || "Local computer",
    localRoots: splitRoots(env.CODASSOL_LOCAL_ROOTS)
  };
}
