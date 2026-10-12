import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { AuthReplicaStore } from "./auth-replica-checkpoint.js";
import { CloudflareWitnessAuthority } from "./cloudflare-witness-authority.js";
import { LocalRefreshAuthority } from "./local-refresh-authority.js";
import {
  PublicRequestFence, createCommittedAuthStateReader,
  createFollowerCommittedAuthStateReader
} from "./public-request-fence.js";

function invalid(message) {
  return Object.assign(new Error(message), {
    code: "PUBLIC_INGRESS_PROVISIONING_INVALID"
  });
}

function absolute(value) {
  return typeof value === "string" && path.isAbsolute(value);
}

async function privateJson(filePath, limit = 8_192) {
  if (!absolute(filePath)) throw invalid("Provisioning requires an absolute file path");
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || (process.platform !== "win32" &&
        (metadata.mode & 0o077) !== 0) ||
        metadata.size > limit || metadata.size === 0) {
      throw invalid("Unsafe permissions or size on private ingress configuration");
    }
    const data = await readFile(filePath, "utf8");
    if (Buffer.byteLength(data) > limit) throw invalid("Oversized ingress configuration");
    return JSON.parse(data);
  } catch {
    // No path or secret data is reflected back to the caller or logs.
    throw invalid("Private ingress configuration unavailable");
  }
}

/**
 * Opt-in v0.3 startup wiring. No external service is contacted and NO
 * lease is acquired here; an independent fenced leader/standby supervisor
 * must atomically write a current claim to the private claim file.
 *
 * Configuration format:
 * {
 *   "version": 1,
 *   "installationId": "<Router private installation UUID>",
 *   "publicDomain": "https://fixed-domain.example",
 *   "role": "leader" | "follower",
 *   "witness": { "endpoint": "https://...workers.dev", "secret": "<hex64>" },
 *   "claimFile": "/private/lease-claim.json",
 *   "authStateFile": "/private/auth-state.json"
 * }
 *
 * The file MUST be mode 0600 and contain no long-term Router admin token.
 */
export async function loadPublicRequestFenceFromFile({
  filePath, installationId, publicIssuer, clock = () => Date.now(),
  fetchImpl = fetch
} = {}) {
  const configuration = await privateJson(filePath);
  if (configuration?.version !== 1 ||
      configuration.installationId !== installationId ||
      configuration.publicDomain !== publicIssuer ||
      !["leader", "follower"].includes(configuration.role) ||
      !absolute(configuration.claimFile) ||
      !absolute(configuration.authStateFile) ||
      configuration.claimFile === configuration.authStateFile ||
      configuration.witness == null ||
      typeof configuration.witness !== "object") {
    throw invalid("Ingress issuer, identity, role or state paths do not match");
  }
  let witness;
  try {
    witness = new CloudflareWitnessAuthority({
      endpoint: configuration.witness.endpoint,
      publicDomain: configuration.publicDomain,
      installationId, secret: configuration.witness.secret,
      fetchImpl
    });
  } catch {
    throw invalid("Invalid independent witness configuration");
  }
  const authority = new LocalRefreshAuthority({
    filePath: configuration.authStateFile
  });
  const committedState = configuration.role === "leader"
    ? createCommittedAuthStateReader(authority)
    : createFollowerCommittedAuthStateReader(new AuthReplicaStore({
        filePath: configuration.authStateFile
      }));

  const currentClaim = async () => {
    const claim = await privateJson(configuration.claimFile, 2_048);
    if (claim?.ownerId !== installationId ||
        !Number.isSafeInteger(claim.epoch) || claim.epoch <= 0 ||
        !Number.isSafeInteger(claim.expiresAt) ||
        typeof claim.fencingToken !== "string" ||
        claim.fencingToken.length < 32) {
      throw invalid("Ingress lease claim has no valid installation binding");
    }
    return claim;
  };
  return new PublicRequestFence({
    authority: witness,
    installationId,
    publicDomain: publicIssuer,
    currentClaim, committedState, clock
  });
}
