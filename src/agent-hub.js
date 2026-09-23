import { randomUUID } from "node:crypto";

export class AgentHub {
  #queues = new Map();
  #waiters = new Map();
  #pending = new Map();

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
        reject(Object.assign(new Error(`Agent job ${jobId} timed out`), {
          code: "AGENT_JOB_TIMEOUT",
          jobId,
          deviceId
        }));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(jobId, { deviceId, resolve, reject, timer });

      const waiter = this.#waiters.get(deviceId);
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

