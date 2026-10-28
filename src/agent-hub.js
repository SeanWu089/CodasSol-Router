import { randomUUID } from "node:crypto";

export class AgentHub {
  #queues = new Map();
  #waiters = new Map();
  #pending = new Map();
  #streams = new Map();
  #clock;
  constructor({ clock = () => performance.now() } = {}) { this.#clock = clock; }

  // One authenticated task consumer per device. In particular, replacing a
  // live stream could silently route a job to the wrong/old connection.
  subscribe(deviceId, deliver, close = () => {}, { leaseMs = 0, previousStreamId } = {}) {
    this.expireStream(deviceId);
    const previous = this.#streams.get(deviceId);
    // Only the authenticated device possessing the exact leased stream ID can
    // replace its broken downstream. Stale attempts cannot evict a successor.
    if (leaseMs > 0 && previous?.leaseMs && previous.id === previousStreamId) {
      this.#streams.delete(deviceId);
      try { previous.close(); } catch { /* replacement owns cleanup */ }
    }
    if (this.#streams.has(deviceId) || this.#waiters.has(deviceId)) {
      throw Object.assign(new Error("Agent already has a task consumer"), {
        code: "AGENT_CONSUMER_ACTIVE"
      });
    }
    const stream = { deliver, close, id: randomUUID(), leaseMs, deadline: this.#clock() + leaseMs };
    this.#streams.set(deviceId, stream);
    // Let the caller flush its HTTP headers before a queued job is emitted.
    queueMicrotask(() => {
      if (this.#streams.get(deviceId) !== stream) return;
      const queue = this.#queues.get(deviceId);
      while (queue?.length) {
        if (!this.#deliver(stream, queue[0])) break;
        queue.shift();
      }
      if (queue && !queue.length) this.#queues.delete(deviceId);
    });
    const unsubscribe = () => {
      if (this.#streams.get(deviceId) !== stream) return false;
      return this.#streams.delete(deviceId);
    };
    unsubscribe.streamId = stream.id;
    return unsubscribe;
  }

  expireStream(deviceId) {
    const stream = this.#streams.get(deviceId);
    if (!stream?.leaseMs || this.#clock() < stream.deadline) return false;
    this.#streams.delete(deviceId);
    try { stream.close(); } catch { /* cleanup cannot preserve an expired consumer */ }
    return true;
  }

  renewStream(deviceId, streamId) {
    this.expireStream(deviceId);
    const stream = this.#streams.get(deviceId);
    if (!stream?.leaseMs || stream.id !== streamId) return false;
    stream.deadline = this.#clock() + stream.leaseMs;
    return true;
  }

  #deliver(stream, job) {
    try {
      return stream.deliver(job) === true;
    } catch {
      return false;
    }
  }

  closeStreams() {
    for (const stream of this.#streams.values()) {
      try { stream.close(); } catch { /* best-effort during shutdown */ }
    }
    this.#streams.clear();
  }

  #removeQueuedJob(deviceId, jobId) {
    const queue = this.#queues.get(deviceId);
    if (!queue) return;
    const index = queue.findIndex((job) => job.id === jobId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.#queues.delete(deviceId);
  }

  enqueue(deviceId, payload, { timeoutMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
      throw new RangeError("Agent job timeout must be 1ms–1 hour");
    }
    const jobId = randomUUID();
    const createdAt = Date.now();
    const job = {
      id: jobId,
      createdAt,
      // The Agent must not start an old mutation after the caller timed out.
      // Enforced by v0.3 Agents before dispatch, even for already-streamed
      // jobs that could not be retracted from TCP buffers.
      expiresAt: createdAt + timeoutMs,
      payload
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(jobId);
        // Never deliver a timed-out mutation after the caller has given up.
        this.#removeQueuedJob(deviceId, jobId);
        reject(Object.assign(new Error(`Agent job ${jobId} timed out`), {
          code: "AGENT_JOB_TIMEOUT",
          jobId,
          deviceId
        }));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(jobId, { deviceId, resolve, reject, timer });

      this.expireStream(deviceId);
      const stream = this.#streams.get(deviceId);
      const queued = this.#queues.get(deviceId);
      const waiter = this.#waiters.get(deviceId);
      // Preserve FIFO when subscribe() has not yet drained older jobs.
      if (stream && !queued?.length && this.#deliver(stream, job)) {
        return;
      }
      if (waiter) {
        this.#waiters.delete(deviceId);
        waiter(job);
      } else {
        const queue = this.#queues.get(deviceId) || [];
        queue.push(job);
        this.#queues.set(deviceId, queue);
      }
    });
  }

  async poll(deviceId, { timeoutMs = 25_000 } = {}) {
    this.expireStream(deviceId);
    if (this.#streams.has(deviceId) || this.#waiters.has(deviceId)) {
      throw Object.assign(new Error("Agent already has a task consumer"), {
        code: "AGENT_CONSUMER_ACTIVE"
      });
    }
    const queue = this.#queues.get(deviceId);
    if (queue?.length) {
      const job = queue.shift();
      if (queue.length === 0) this.#queues.delete(deviceId);
      return job;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#waiters.get(deviceId) === finish) {
          this.#waiters.delete(deviceId);
        }
        resolve(null);
      }, timeoutMs);
      const finish = (job) => {
        clearTimeout(timer);
        resolve(job);
      };
      this.#waiters.set(deviceId, finish);
    });
  }

  complete(deviceId, jobId, result) {
    const pending = this.#pending.get(jobId);
    if (!pending || pending.deviceId !== deviceId) return false;
    this.#pending.delete(jobId);
    clearTimeout(pending.timer);
    pending.resolve(result);
    return true;
  }

  fail(deviceId, jobId, error) {
    const pending = this.#pending.get(jobId);
    if (!pending || pending.deviceId !== deviceId) return false;
    this.#pending.delete(jobId);
    clearTimeout(pending.timer);
    const wrapped = Object.assign(new Error(error?.message || "Remote agent job failed"), {
      code: error?.code || "AGENT_JOB_FAILED",
      deviceId,
      jobId
    });
    pending.reject(wrapped);
    return true;
  }
}

