/**
 * `@opensesame/ingress-evidence` — the browser-safe half: RFC 9440
 * Client-Cert / Client-Cert-Chain parsing with bounded work and the same
 * error codes as `opensesame-ingress-evidence` (Rust).
 *
 * Nothing exported here trusts a header. A `ForwardedChain` is untrusted
 * input for `verifyOriginatingChain` in `./node`, and that verification is
 * itself only meaningful when the request arrived from an authenticated,
 * explicitly bound ingress on a `trusted_ingress` listener.
 */
export {
  type IngressErrorCode,
  type IngressField,
  IngressEvidenceError,
} from "./error.js";
export { type HeaderPair, hasClientCertFields } from "./fields.js";
export { DEFAULT_INGRESS_LIMITS, type IngressLimits } from "./limits.js";
export {
  type ForwardedChain,
  pairsFromRawHeaders,
  parseClientCertFields,
  stripClientCertFields,
} from "./parse.js";
