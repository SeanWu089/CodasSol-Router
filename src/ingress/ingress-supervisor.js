import { IngressState } from "./ingress-manager.js";

/**
 * Schedules the guarded ingress state machine, but never grants authority.
 * The injected Manager still requires externally fenced ownership and a
 * launcher with the public Router-instance proof preflight.
 *
 * No background timer is started unless start() is explicitly called.
 */
export class IngressSupervisor {
  #timer = null;
  #running = false;
  #pending = null;
  #lastSnapshot = null;

  constructor({ manager, candidateSnapshot, intervalMs = 5000,
    snapshotTimeoutMs = 5000,
    onChange = () => {}, onError = () => {}
  } = {}) {
    if (typeof manager?.reconcile !== "function" ||
        typeof manager?.snapshot !== "function" ||
        typeof manager?.installationId !== "string" ||
        typeof candidateSnapshot !== "function" ||
        typeof onChange !== "function" || typeof onError !== "function") {
      throw new TypeError("IngressSupervisor needs a manager and candidate source");
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 300000) {
      throw new RangeError("IngressSupervisor interval must be 1-300 seconds");
    }
    if (!Number.isInteger(snapshotTimeoutMs) || snapshotTimeoutMs < 100 ||
        snapshotTimeoutMs > 60_000) {
      throw new RangeError("IngressSupervisor snapshot timeout must be 100-60000ms");
    }
    this.manager = manager;
    this.candidateSnapshot = candidateSnapshot;
    this.intervalMs = intervalMs;
    this.snapshotTimeoutMs = snapshotTimeoutMs;
    this.onChange = onChange;
    this.onError = onError;
  }

  get running() { return this.#running; }
  get state() { return this.manager.snapshot(); }

  #reportError(error) {
    try { this.onError(error); } catch { /* observer cannot bypass fencing */ }
  }

  async #check() {
    const controller = new AbortController();
    let timeout;
    try {
      const candidates = await Promise.race([
        this.candidateSnapshot({ signal: controller.signal }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("candidate_snapshot_timeout"));
          }, this.snapshotTimeoutMs);
        })
      ]);
      if (!candidates?.local ||
          candidates.local.installationId !== this.manager.installationId) {
        throw new Error("Candidate identity unavailable");
      }
      return await this.manager.reconcile(candidates);
    } catch (error) {
      // Missing/stale health data is NOT permission to preserve an ACTIVE
      // endpoint. Fail closed: the Manager deactivates its owned listener.
      this.#reportError(error);
      return this.manager.reconcile({
        local: { installationId: this.manager.installationId,
          userEnabled: false }
      });
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  #notify(snapshot) {
    const previous = this.#lastSnapshot;
    this.#lastSnapshot = snapshot;
    if (previous?.state !== snapshot.state ||
        previous?.reason !== snapshot.reason) {
      try { this.onChange(snapshot, previous); }
      catch (error) { this.#reportError(error); }
    }
  }

  async tick() {
    if (this.#pending) return this.#pending;
    const pending = this.#check();
    this.#pending = pending;
    try {
      const result = await pending;
      this.#notify(result);
      return result;
    } finally {
      if (this.#pending === pending) this.#pending = null;
    }
  }

  #schedule() {
    if (!this.#running) return;
    this.#timer = setTimeout(async () => {
      this.#timer = null;
      if (!this.#running) return;
      try {
        await this.tick();
      } catch (error) {
        this.#reportError(error);
      } finally {
        if (this.#running) this.#schedule();
      }
    }, this.intervalMs);
    this.#timer.unref?.();
  }

  async start() {
    if (this.#running) return this.state;
    this.#running = true;
    try {
      const result = await this.tick();
      this.#schedule();
      return result;
    } catch (error) {
      this.#running = false;
      throw error;
    }
  }

  async stop() {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    // Wait for a running tick before disabling and tearing down. This
    // prevents the tick from reactivating an ingress after stop() returns.
    if (this.#pending) {
      try { await this.#pending; } catch { /* follow with guarded drain */ }
    }
    this.manager.enabled = false;
    const result = await this.manager.reconcile({
      local: { installationId: this.manager.installationId, userEnabled: false }
    });
    this.#notify(result);
    if (result.state !== IngressState.DISABLED) {
      throw new Error("Ingress supervisor could not safely deactivate its endpoint");
    }
    return result;
  }
}
