// Shared between Router and Agent. Changing the positive heartbeat interval
// without changing presence TTL would produce false-offline device status.
export const AGENT_SSE_HEARTBEAT_INTERVAL_MS = 30 * 60_000;
export const AGENT_SSE_PRESENCE_TTL_MS = 40 * 60_000;

export function estimatedIdleHeartbeatRequests({
  devices = 1, days = 30,
  heartbeatIntervalMs = AGENT_SSE_HEARTBEAT_INTERVAL_MS
} = {}) {
  if (!Number.isInteger(devices) || devices < 1 ||
      !Number.isInteger(days) || days < 1 ||
      !Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1000) {
    throw new RangeError("Invalid Agent heartbeat budget");
  }
  return Math.ceil((devices * days * 24 * 60 * 60_000) /
    heartbeatIntervalMs);
}
