import { randomUUID } from "node:crypto";

export class AgentHub {
  #queues = new Map();
  #waiters = new Map();
  #pending = new Map();
  #streams = new Map();

  // One authenticated task consumer per device. In particular, replacing a
  // live stream could silently route a job to the wrong/old connection.
  subscribe(deviceId, deliver, close = () => {}) {
    if (this.#streams.has(deviceId) || this.#waiters.has(deviceId)) {
      throw Object.assign(new Error("Agent already has a task consumer"), {
        code: "AGENT_CONSUMER_ACTIVE"
      });
    }
    const stream = { deliver, close };
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
    return () => {
      if (this.#streams.get(deviceId) === stream) this.#streams.delete(deviceId);
    };
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
    const jobId = randomUUID();
    const job = {
      id: jobId,
      createdAt: Date.now(),
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

