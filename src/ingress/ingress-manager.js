import { ingressEligibility, preferredIngressCandidate } from "./eligibility.js";

export const IngressState = Object.freeze({
  DISABLED: "DISABLED",
  STANDBY: "STANDBY",
  CANDIDATE: "CANDIDATE",
  ACTIVE: "ACTIVE",
  DRAINING: "DRAINING",
  FENCED: "FENCED"
});

function validClaim(claim, installationId, now) {
  return claim && typeof claim === "object" &&
    claim.ownerId === installationId &&
    Number.isSafeInteger(claim.epoch) && claim.epoch > 0 &&
    Number.isFinite(claim.expiresAt) && claim.expiresAt > now &&
    typeof claim.fencingToken === "string" && claim.fencingToken.length >= 16;
}

/**
 * Policy/state machine only: neither local peer voting nor this class is a
 * distributed lock. The injected lease provider MUST enforce exclusivity at
 * the public ingress data plane, including stale/fenced process rejection.
 * This is intentionally NOT wired into the production Router yet.
 */
export class IngressManager {
  #queue = Promise.resolve();
  #claim = null;
  #started = false;

  constructor({ installationId, domain, lease, adapter, enabled = false,
    clock = () => Date.now(), activationPreflight = null } = {}) {
    if (typeof installationId !== "string" || !installationId.trim()) {
      throw new TypeError("IngressManager requires an installationId");
    }
    const url = new URL(domain);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) {
      throw new TypeError("Ingress domain must be a bare HTTPS origin");
    }
    if (!lease || ["acquire", "verify", "renew", "release"]
      .some((name) => typeof lease[name] !== "function")) {
      throw new TypeError("IngressManager requires an external fenced lease provider");
    }
    if (!adapter || adapter.fencedActivation !== true ||
        typeof adapter.start !== "function" || typeof adapter.stop !== "function") {
      throw new TypeError("Ingress adapter must enforce fenced activation and support start/stop");
    }
    if (activationPreflight !== null &&
        typeof activationPreflight !== "function") {
      throw new TypeError("Ingress activation preflight must be a function");
    }
    this.installationId = installationId;
    this.domain = url.origin;
    this.lease = lease;
    this.adapter = adapter;
    this.activationPreflight = activationPreflight;
    this.enabled = enabled === true;
    this.clock = clock;
    this.state = this.enabled ? IngressState.STANDBY : IngressState.DISABLED;
    this.reason = null;
  }

  snapshot() {
    // A fencingToken is a credential: never display it via Device Registry.
    return {
      state: this.state, reason: this.reason,
      installationId: this.installationId,
      domain: this.domain,
      epoch: this.#claim?.epoch ?? null,
      leaseExpiresAt: this.#claim?.expiresAt ?? null
    };
  }

  /**
   * Serialize heartbeats, start/stop and disconnect handling on this node.
   * Every production caller must supply verified, fresh node capabilities;
   * this manager never assumes stale peer heartbeat is proof of readiness.
   */
  reconcile({ local, peers = [], incumbentId = null } = {}) {
    const current = this.#queue.then(() => this.#reconcile({ local, peers, incumbentId }));
    this.#queue = current.catch(() => {});
    return current;
  }

  async #reconcile({ local, peers, incumbentId }) {
    if (local?.installationId !== this.installationId) {
      throw new TypeError("Local candidate identity does not match this installation");
    }
    if (!this.enabled) {
      // Even after an adapter stopped, a failed lease release must remain
      // visible and retryable; never report DISABLED while still holding it.
      if ((this.#started || this.#claim) && !(await this.#deactivate())) {
        return this.snapshot();
      }
      this.state = IngressState.DISABLED;
      this.reason = null;
      return this.snapshot();
    }
    if (this.state === IngressState.FENCED) return this.snapshot();

    const check = ingressEligibility(local);
    if (!check.eligible) {
      if (this.#started) await this.#deactivate();
      if (this.state !== IngressState.FENCED) {
        this.state = IngressState.STANDBY;
        this.reason = check.failures.join(",");
      }
      return this.snapshot();
    }

    if (this.state === IngressState.ACTIVE) {
      try {
        const updated = await this.lease.renew(this.#claim);
        if (!validClaim(updated, this.installationId, this.clock()) ||
            updated.epoch !== this.#claim.epoch ||
            await this.lease.verify(updated) !== true) {
          throw new Error("claim_not_renewed");
        }
        this.#claim = updated;
        this.reason = null;
      } catch {
        const stopped = await this.#deactivate();
        if (stopped) {
          this.reason = "lease_renewal_failed";
        }
        this.state = IngressState.FENCED;
      }
      return this.snapshot();
    }

    const preferred = preferredIngressCandidate([local, ...peers], { incumbentId });
    if (preferred !== this.installationId) {
      this.state = IngressState.STANDBY;
      this.reason = "higher_priority_candidate";
      return this.snapshot();
    }
    this.state = IngressState.CANDIDATE;
    this.reason = null;
    try {
      const claim = await this.lease.acquire({
        ownerId: this.installationId, domain: this.domain
      });
      if (!claim) {
        this.state = IngressState.STANDBY;
        this.reason = "lease_held_elsewhere";
        return this.snapshot();
      }
      this.#claim = claim;
      if (!validClaim(claim, this.installationId, this.clock()) ||
          await this.lease.verify(claim) !== true) {
        throw new Error("invalid_or_unverified_lease");
      }
      // A standby must not activate its public endpoint merely because it
      // obtained the ingress lease: committed OAuth state and an external
      // latest-revision proof are separate safety requirements.
      if (this.activationPreflight &&
          await this.activationPreflight({ claim, domain: this.domain,
            installationId: this.installationId }) !== true) {
        throw new Error("ingress_activation_preflight_failed");
      }
      if (await this.lease.verify(claim) !== true) {
        throw new Error("lease_lost_during_activation_preflight");
      }
      // The adapter itself must pass this claim to a fencing-enforcing
      // provider; checking it locally is NOT sufficient against partitions.
      this.#started = true;
      await this.adapter.start({ domain: this.domain, claim });
      if (await this.lease.verify(claim) !== true ||
          !validClaim(claim, this.installationId, this.clock())) {
        throw new Error("lease_lost_during_activation");
      }
      this.state = IngressState.ACTIVE;
      return this.snapshot();
    } catch {
      const stopped = await this.#deactivate();
      if (stopped) {
        this.reason = "activation_failed_or_unfenced";
      }
      this.state = IngressState.FENCED;
      return this.snapshot();
    }
  }

  /** Stop the locally owned listener BEFORE releasing the exclusive claim. */
  async #deactivate() {
    this.state = IngressState.DRAINING;
    if (this.#started) {
      try {
        await this.adapter.stop({ domain: this.domain, claim: this.#claim });
        this.#started = false;
      } catch {
        this.state = IngressState.FENCED;
        this.reason = "could_not_stop_listener";
        return false; // never release a claim while a listener may be running
      }
    }
    if (this.#claim) {
      try {
        await this.lease.release(this.#claim);
        this.#claim = null;
      } catch {
        this.state = IngressState.FENCED;
        this.reason = "could_not_release_lease";
        return false;
      }
    }
    return true;
  }
}
