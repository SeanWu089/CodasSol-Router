/**
 * Public ingress is an optional node capability, NOT an attribute of its OS.
 * The Router remains independently usable when these checks fail.
 */
export function ingressEligibility(node) {
  const failures = [];
  if (!node || typeof node !== "object") {
    return { eligible: false, failures: ["missing_node"] };
  }
  if (typeof node.installationId !== "string" || !node.installationId.trim()) {
    failures.push("missing_installation_identity");
  }
  const required = [
    ["userEnabled", "not_opted_in"],
    ["identityVerified", "identity_not_verified"],
    ["routerReady", "router_unreachable"],
    ["backendReady", "execution_backend_unavailable"],
    ["networkReady", "network_unavailable"],
    ["adapterAvailable", "no_ingress_adapter"],
    ["durableService", "runtime_not_durable"],
    ["credentialsProvisioned", "credentials_not_provisioned"],
    ["clientAuthReady", "public_auth_not_ready"]
  ];
  for (const [field, failure] of required) {
    if (node[field] !== true) failures.push(failure);
  }
  return { eligible: failures.length === 0, failures };
}

/**
 * Preferences affect who MAY TRY to acquire an external fenced lease.
 * They never confer ownership themselves. Keep a qualified incumbent to
 * avoid thrashing on every network/health update.
 */
export function preferredIngressCandidate(nodes, { incumbentId = null } = {}) {
  if (!Array.isArray(nodes)) throw new TypeError("nodes must be an array");
  const qualified = nodes.filter((node) => ingressEligibility(node).eligible);
  qualified.sort((a, b) => {
    if ((a.installationId === incumbentId) !== (b.installationId === incumbentId)) {
      return a.installationId === incumbentId ? -1 : 1;
    }
    const priorityA = Number.isFinite(a.priority) ? a.priority : 0;
    const priorityB = Number.isFinite(b.priority) ? b.priority : 0;
    if (priorityA !== priorityB) return priorityB - priorityA;
    return a.installationId.localeCompare(b.installationId, "en");
  });
  return qualified[0]?.installationId ?? null;
}
