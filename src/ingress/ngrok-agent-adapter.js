/**
 * A transport-independent, guarded ngrok Agent lifecycle adapter. This file
 * does NOT provide the external lease authority or spawn a real process.
 * The caller must supply an authority-backed launcher whose actual serving
 * path enforces the claim epoch/fencing token, even after network partitions.
 *
 * Do not replace the existing production tunnel with this until an external
 * claim primitive has been physically verified across Mac and Windows.
 */
export class NgrokAgentIngressAdapter {
  #owned = null;

  constructor({ installationId, fixedDomain, localRouterUrl, authority, launcher } = {}) {
    if (typeof installationId !== "string" || !installationId.trim()) {
      throw new TypeError("Ngrok adapter requires immutable installation identity");
    }
    const domain = new URL(fixedDomain);
    const backend = new URL(localRouterUrl);
    if (domain.protocol !== "https:" || domain.pathname !== "/" ||
        domain.search || domain.hash || domain.username || domain.password ||
        !domain.hostname) {
      throw new TypeError("Ngrok domain must be a fixed bare HTTPS origin");
    }
    if (backend.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(backend.hostname) ||
        !backend.port || backend.pathname !== "/" ||
        backend.username || backend.password || backend.search || backend.hash) {
      throw new TypeError("Ngrok must forward to an explicitly configured loopback Router");
    }
    // A local file lock, process check, or Tailscale peer vote does not
    // fence an ngrok Agent on a disconnected machine.
    if (authority?.enforcesExternalFencing !== true ||
        typeof authority.verify !== "function") {
      throw new TypeError("Provider-enforced external fencing is required");
    }
    if (launcher?.fencingAware !== true ||
        ["startOwned", "stopOwned", "inspectOwned"].some(
          (name) => typeof launcher[name] !== "function")) {
      throw new TypeError("Ngrok launcher must enforce fencing and own its process handles");
    }
    this.installationId = installationId;
    this.fixedDomain = domain.origin;
    this.localRouterUrl = backend.origin;
    this.authority = authority;
    this.launcher = launcher;
    this.fencedActivation = true;
  }

  async start({ domain, claim }) {
    if (domain !== this.fixedDomain || claim?.ownerId !== this.installationId ||
        !Number.isSafeInteger(claim?.epoch) || claim.epoch <= 0 ||
        typeof claim.fencingToken !== "string" || claim.fencingToken.length < 16) {
      throw new Error("Ingress owner/domain/fencing claim mismatch");
    }
    if (this.#owned) throw new Error("Ingress listener already owned by this adapter");
    if (await this.authority.verify(claim, domain) !== true) {
      throw new Error("External authority denied ingress ownership");
    }
    // The launcher MUST reject claims invalidated after this check.
    const handle = await this.launcher.startOwned({
      domain: this.fixedDomain, target: this.localRouterUrl, claim
    });
    if (!handle || typeof handle !== "object") {
      throw new Error("Launcher returned no owned process handle");
    }
    this.#owned = { handle, claim };
    const status = await this.launcher.inspectOwned(handle);
    if (status?.domain !== this.fixedDomain ||
        status?.target !== this.localRouterUrl || status?.running !== true ||
        await this.authority.verify(claim, domain) !== true) {
      throw new Error("Owned ngrok endpoint did not pass identity/health/fencing preflight");
    }
    return { ready: true };
  }

  async stop({ domain } = {}) {
    if (domain !== this.fixedDomain) {
      throw new Error("Refusing to stop an ingress for a different domain");
    }
    if (!this.#owned) return;
    // NEVER enumerate PIDs and kill any process merely named 'ngrok'.
    // stopOwned must affect only the exact handle returned by startOwned.
    await this.launcher.stopOwned(this.#owned.handle);
    this.#owned = null;
  }

  get hasOwnedListener() { return this.#owned !== null; }
}
