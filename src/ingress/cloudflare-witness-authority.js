/**
 * HTTPS client for a separately hosted Cloudflare Durable Object witness.
 * Each physical Router uses its own secret; never place this configuration
 * in git or forward the witness bearer to a DevSpace/Agent/MCP client.
 */
export class CloudflareWitnessAuthority {
  constructor({
    endpoint, publicDomain, installationId, secret, fetchImpl = fetch,
    timeoutMs = 5_000
  } = {}) {
    const url = new URL(endpoint);
    const domain = new URL(publicDomain);
    if (url.protocol !== "https:" || url.pathname !== "/" ||
        url.search || url.hash || url.username || url.password ||
        domain.protocol !== "https:" || domain.pathname !== "/" ||
        domain.search || domain.hash || domain.username || domain.password ||
        !/^[A-Za-z0-9:_-]{12,128}$/.test(installationId ?? "") ||
        !/^[a-f0-9]{64}$/i.test(secret ?? "") ||
        typeof fetchImpl !== "function" ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 500 ||
        timeoutMs > 30_000) {
      throw new TypeError("Pinned HTTPS witness, device ID and 256-bit secret required");
    }
    this.endpoint = url.origin;
    this.publicDomain = domain.origin;
    this.installationId = installationId;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    // A strongly consistent lease does NOT physically fence an ngrok Agent:
    // the ngrok adapter deliberately refuses this controller by itself.
    this.enforcesExternalFencing = false;
  }

  async #request(action, payload = {}) {
    const response = await this.fetchImpl(this.endpoint + "/v1/" + action, {
      method: "POST", redirect: "error",
      headers: {
        "authorization": "Bearer " + this.secret,
        "x-codassol-installation-id": this.installationId,
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok ||
        !response.headers?.get("content-type")?.includes("application/json")) {
      throw Object.assign(new Error("External witness unavailable"), {
        code: "WITNESS_UNAVAILABLE"
      });
    }
    const result = await response.json();
    if (!Object.hasOwn(result, "result")) {
      throw Object.assign(new Error("Witness returned invalid response"), {
        code: "WITNESS_UNAVAILABLE"
      });
    }
    return result.result;
  }

  acquire({ ownerId, domain }) {
    if (ownerId !== this.installationId || domain !== this.publicDomain) {
      throw new Error("Witness owner or public domain mismatch");
    }
    return this.#request("acquire", { ownerId, domain });
  }

  verify(claim) { return this.#request("verify", { claim }); }
  renew(claim) { return this.#request("renew", { claim }); }

  async release(claim) {
    if (await this.#request("release", { claim }) !== true) {
      throw Object.assign(new Error("External witness refused release"), {
        code: "WITNESS_RELEASE_REFUSED"
      });
    }
  }

  publishCommitted({ claim, checkpoint }) {
    return this.#request("publish", { claim, checkpoint });
  }

  async confirmLatestCommitted({
    claim, installationId, checkpoint
  }) {
    if (installationId !== this.installationId) return false;
    return this.#request("confirm", { claim, checkpoint });
  }

  status() { return this.#request("status"); }
}
