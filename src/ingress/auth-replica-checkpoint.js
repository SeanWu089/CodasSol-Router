import {
  createCipheriv, createDecipheriv, createHash, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify
} from "node:crypto";
import { LocalRefreshAuthority } from "./local-refresh-authority.js";

const VERSION = 1;
// Current SSE transport has a 256 KiB output-buffer safety limit; snapshots
// exceeding this bound must be transferred by a future chunked protocol.
const MAX_PLAINTEXT_BYTES = 128_000;
const MAX_ENVELOPE_BYTES = 220_000;
const b64 = (value) => Buffer.from(value).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("base64url");

function fail(message) {
  const error = new Error(message);
  error.code = "AUTH_REPLICA_REJECTED";
  return error;
}

function installationId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9:_-]{12,128}$/.test(id)) {
    throw new TypeError("Pinned installation ID required");
  }
  return id;
}

function validateOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" ||
      url.search || url.hash || url.username || url.password) {
    throw new TypeError("OAuth issuer must be a bare HTTPS origin");
  }
  return url.origin;
}

function keyType(value, type, algorithm) {
  if (!value || value.type !== type || value.asymmetricKeyType !== algorithm) {
    throw new TypeError(`Expected ${algorithm} ${type} key`);
  }
  return value;
}

function material(key, context) {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0),
    Buffer.from(context), 32));
}

function canonical(envelope) {
  // Exact whitelist prevents unsigned metadata being smuggled into claims.
  return JSON.stringify({
    version: envelope.version, issuer: envelope.issuer,
    source: envelope.source, target: envelope.target,
    epoch: envelope.epoch, revision: envelope.revision,
    previous: envelope.previous, issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt, ephemeralKey: envelope.ephemeralKey,
    nonce: envelope.nonce, ciphertext: envelope.ciphertext,
    tag: envelope.tag
  });
}

function bodySchema(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      snapshot.version !== 1 ||
      !snapshot.namespaces || typeof snapshot.namespaces !== "object" ||
      Array.isArray(snapshot.namespaces)) throw fail("Invalid snapshot shape");
  const permitted = new Set(["refreshGrants", "oauthClients", "revocations"]);
  for (const [namespace, data] of Object.entries(snapshot.namespaces)) {
    if (!permitted.has(namespace) || !data ||
        typeof data !== "object" || Array.isArray(data) ||
        !data.records || typeof data.records !== "object" ||
        Array.isArray(data.records)) throw fail("Invalid snapshot namespace");
  }
  return snapshot;
}

/**
 * A confidential Ed25519-signed, X25519-encrypted single checkpoint.
 * The source key signs; the target decrypts with its own PRIVATE key.
 * Never put the signing or decryption private keys in a checkpoint.
 *
 * IMPORTANT: This is passive replication, NOT a quorum commit protocol.
 * The caller MUST separately prove the checkpoint is the LATEST committed
 * revision before enabling a new writer. Staleness alone is not proof.
 */
export function sealAuthCheckpoint({
  issuer, source, target, epoch, revision, previous = null,
  state, signingKey, recipientKey,
  clock = () => Date.now(), lifetimeMs = 60_000
} = {}) {
  const origin = validateOrigin(issuer);
  installationId(source);
  installationId(target);
  keyType(signingKey, "private", "ed25519");
  keyType(recipientKey, "public", "x25519");
  if (!Number.isSafeInteger(epoch) || epoch < 1 ||
      !Number.isSafeInteger(revision) || revision < 1 ||
      (previous !== null && (typeof previous !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(previous))) ||
      !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1000 ||
      lifetimeMs > 300_000) throw new TypeError("Invalid checkpoint ordering");
  const plain = Buffer.from(JSON.stringify(bodySchema(state)));
  if (plain.length > MAX_PLAINTEXT_BYTES) throw fail("Auth state too large");
  const ephemeral = generateKeyPairSync("x25519");
  const derived = diffieHellman({
    privateKey: ephemeral.privateKey, publicKey: recipientKey
  });
  const symmetric = material(derived,
    `codassol-auth-replica:v1:${origin}:${source}:${target}`);
  const nonce = randomBytes(12);
  const issuedAt = clock();
  const envelope = {
    version: VERSION, issuer: origin, source, target, epoch, revision,
    previous, issuedAt, expiresAt: issuedAt + lifetimeMs,
    ephemeralKey: b64(ephemeral.publicKey.export({
      format: "der", type: "spki"
    })),
    nonce: b64(nonce)
  };
  const cipher = createCipheriv("aes-256-gcm", symmetric, nonce);
  const aad = Buffer.from(JSON.stringify(envelope));
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  envelope.ciphertext = b64(encrypted);
  envelope.tag = b64(cipher.getAuthTag());
  const signature = b64(sign(null, Buffer.from(canonical(envelope)), signingKey));
  return { ...envelope, signature };
}

export function openAuthCheckpoint({
  checkpoint, issuer, expectedSource, localInstallationId,
  trustedSigningKey, recipientPrivateKey, clock = () => Date.now()
} = {}) {
  const expectedIssuer = validateOrigin(issuer);
  installationId(expectedSource);
  installationId(localInstallationId);
  keyType(trustedSigningKey, "public", "ed25519");
  keyType(recipientPrivateKey, "private", "x25519");
  if (!checkpoint || Buffer.byteLength(JSON.stringify(checkpoint)) >
      MAX_ENVELOPE_BYTES || checkpoint.version !== VERSION ||
      checkpoint.issuer !== expectedIssuer ||
      checkpoint.source !== expectedSource ||
      checkpoint.target !== localInstallationId ||
      !Number.isSafeInteger(checkpoint.epoch) || checkpoint.epoch < 1 ||
      !Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1 ||
      !Number.isSafeInteger(checkpoint.issuedAt) ||
      !Number.isSafeInteger(checkpoint.expiresAt) ||
      checkpoint.expiresAt <= clock() ||
      checkpoint.issuedAt > clock() + 5000 ||
      checkpoint.expiresAt - checkpoint.issuedAt > 300_000 ||
      typeof checkpoint.signature !== "string") throw fail("Invalid checkpoint identity or age");
  try {
    if (!verify(null, Buffer.from(canonical(checkpoint)), trustedSigningKey,
      Buffer.from(checkpoint.signature, "base64url"))) {
      throw fail("Invalid checkpoint signature");
    }
    const ephemeral = createPublicKey({
      key: Buffer.from(checkpoint.ephemeralKey, "base64url"),
      format: "der", type: "spki"
    });
    keyType(ephemeral, "public", "x25519");
    const derived = diffieHellman({
      privateKey: recipientPrivateKey, publicKey: ephemeral
    });
    const key = material(derived,
      `codassol-auth-replica:v1:${expectedIssuer}:${expectedSource}:${localInstallationId}`);
    const cipher = createDecipheriv("aes-256-gcm", key,
      Buffer.from(checkpoint.nonce, "base64url"));
    const { ciphertext, tag, signature, ...aad } = checkpoint;
    cipher.setAAD(Buffer.from(JSON.stringify(aad)));
    cipher.setAuthTag(Buffer.from(checkpoint.tag, "base64url"));
    const plain = Buffer.concat([
      cipher.update(Buffer.from(checkpoint.ciphertext, "base64url")),
      cipher.final()
    ]);
    if (plain.length > MAX_PLAINTEXT_BYTES) throw fail("Auth state too large");
    const state = bodySchema(JSON.parse(plain.toString("utf8")));
    return { state, digest: digest(canonical(checkpoint)),
      previous: checkpoint.previous,
      epoch: checkpoint.epoch, revision: checkpoint.revision,
      expiresAt: checkpoint.expiresAt };
  } catch {
    throw fail("Checkpoint verification failed");
  }
}

/**
 * Atomically accepts an encrypted checkpoint into a PASSIVE local copy,
 * rejecting rollback, gaps, and forked chains. It cannot authorize becoming
 * ACTIVE: external exclusive fencing and latest-commit proof are separate.
 */
export class AuthReplicaStore {
  constructor({ filePath, authority = null } = {}) {
    this.authority = authority || new LocalRefreshAuthority({ filePath });
  }

  async receive(opened) {
    if (!opened || !opened.state || typeof opened.digest !== "string" ||
        !Number.isSafeInteger(opened.epoch) ||
        !Number.isSafeInteger(opened.revision)) throw fail("Invalid decoded checkpoint");
    return this.authority.transact((data) => {
      const last = data.checkpoint || null;
      if (last && (opened.epoch !== last.epoch ||
          opened.revision !== last.revision + 1)) {
        // Cross-epoch changes require a NEW provisioning and fencing proof;
        // do not accept an automatic reset of the version chain.
        throw fail("Checkpoint epoch changed or revision gap");
      }
      if (!last && (opened.revision !== 1 || opened.previous !== null)) {
        throw fail("Expected bootstrap revision 1");
      }
      if (last && opened.previous !== last.digest) {
        throw fail("Checkpoint chain mismatch");
      }
      data.checkpoint = {
        epoch: opened.epoch, revision: opened.revision,
        digest: opened.digest, expiresAt: opened.expiresAt
      };
      data.namespaces = opened.state.namespaces;
      return structuredClone(data.checkpoint);
    });
  }
}

/**
 * Explicitly configured on a trusted standby Router Agent. Only checkpoints
 * signed by a pinned active installation can write the passive replica.
 * No administrative/public ingress token is accepted as a signature key.
 */
export function createAuthReplicaReceiver({
  issuer, expectedSource, localInstallationId,
  trustedSigningKey, recipientPrivateKey, store,
  clock = () => Date.now()
} = {}) {
  if (typeof store?.receive !== "function") {
    throw new TypeError("A durable replica store is required");
  }
  return {
    async receive(checkpoint) {
      const opened = openAuthCheckpoint({
        checkpoint, issuer, expectedSource, localInstallationId,
        trustedSigningKey, recipientPrivateKey, clock
      });
      // The receipt is returned ONLY after atomic local persistence.
      const durable = await store.receive(opened);
      return {
        replicated: true, epoch: durable.epoch,
        revision: durable.revision, digest: durable.digest
      };
    }
  };
}

/**
 * Enqueues a single, non-replayable synchronization request to a device-bound
 * Agent. A failed/ambiguous ACK requires explicit reconciliation, not retry.
 */
export async function sendAuthReplicaCheckpoint({
  agentHub, deviceId, checkpoint, timeoutMs = 20_000
} = {}) {
  if (typeof agentHub?.enqueue !== "function" ||
      typeof deviceId !== "string" || deviceId.length === 0 ||
      !checkpoint || typeof checkpoint.target !== "string") {
    throw new TypeError("Device-scoped AgentHub and checkpoint required");
  }
  const result = await agentHub.enqueue(deviceId, {
    type: "auth-replica-checkpoint", checkpoint
  }, { timeoutMs });
  const expected = digest(canonical(checkpoint));
  if (result?.replicated !== true || result.digest !== expected ||
      result.revision !== checkpoint.revision ||
      result.epoch !== checkpoint.epoch) {
    throw fail("Replica receipt did not match committed checkpoint");
  }
  return result;
}
