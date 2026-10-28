const FAILURE_CODES = new Set([
  'DNS_FAILED', 'TIMEOUT', 'TLS_FAILED', 'CONNECTION_REFUSED',
  'CONNECTION_LOST', 'NETWORK_UNREACHABLE', 'AUTH_REJECTED', 'HTTP_ERROR',
  'INVALID_RESPONSE', 'PROTOCOL_MISMATCH', 'IDENTITY_MISMATCH',
  'CATALOG_REJECTED', 'UNAVAILABLE'
]);

// Do not store or serialize Error.message: network/library messages may carry
// URLs, request bodies or credentials. Only fixed categories leave this module.
export function peerFailureCode(error, phase = 'transport') {
  const code = error?.code || error?.cause?.code;
  if (FAILURE_CODES.has(code)) return code;
  if (error?.statusCode === 401 || error?.statusCode === 403) return 'AUTH_REJECTED';
  if (Number.isInteger(error?.statusCode)) return 'HTTP_ERROR';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'DNS_FAILED';
  if (['ABORT_ERR', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code) || ['AbortError', 'TimeoutError'].includes(error?.name)) return 'TIMEOUT';
  if (['ECONNREFUSED'].includes(code)) return 'CONNECTION_REFUSED';
  if (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) return 'CONNECTION_LOST';
  if (['ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'NETWORK_UNREACHABLE';
  if (typeof code === 'string' && (/^(ERR_TLS_|ERR_SSL_|CERT_)/.test(code) || ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))) return 'TLS_FAILED';
  if (error instanceof SyntaxError) return 'INVALID_RESPONSE';
  return phase === 'catalog' ? 'CATALOG_REJECTED' : 'UNAVAILABLE';
}

export function peerConnectivity(health) {
  if (!health) return null;
  return {
    checkedAt: Number.isFinite(health.checkedAt) ? health.checkedAt : null,
    durationMs: Number.isFinite(health.durationMs) && health.durationMs >= 0 ? health.durationMs : null,
    consecutiveFailures: Number.isSafeInteger(health.consecutiveFailures) && health.consecutiveFailures >= 0 ? health.consecutiveFailures : 0,
    failureCode: health.failureCode == null ? null : FAILURE_CODES.has(health.failureCode) ? health.failureCode : 'UNAVAILABLE'
  };
}
