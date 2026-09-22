/**
 * Log sanitizer for the mTLS evidence manifest (AT-EVIDENCE-LOGS).
 *
 * Everything captured from a test step goes through `sanitize` before it is
 * written under artifacts/mtls/. The patterns are deliberately broad: a false
 * positive costs a few characters of a log, a false negative leaks a key.
 * Each pattern has a matching case in mtls-manifest.test.mjs.
 */

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
// Any remaining line that still mentions a private key (a lone BEGIN marker,
// a base64 continuation that lost its END, a debug print of the struct).
const PRIVATE_KEY_LINE = /^(?!.*\[REDACTED PRIVATE KEY\]).*PRIVATE KEY.*$/gm;
// A bare base64 line of key length (a body whose BEGIN/END markers were lost
// to interleaved output). Hex digests are 64 chars too, so require a
// non-hex character; real DER never lacks one.
const BASE64_BLOB_LINE = /^(?=[A-Za-z0-9+/=]{64,}$)(?=.*[G-Zg-z+/=]).*$/gm;
const BEARER = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g;
const AUTHORIZATION_HEADER = /^(\s*"?authorization"?\s*[:=]\s*).*$/gim;
// header.payload.signature, each segment base64url and long enough to be a
// real token rather than a version string like 1.2.3.
const JWT = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g;
// nkey seed: 'S' + 55 base32 characters (user/account/server/operator seeds).
const NKEY_SEED = /\bS[A-Z2-7]{55}\b/g;
// Our own token-bearing headers, however they are spelled in a log or curl line.
const OPENSESAME_HEADER = /(x-opensesame-[a-z0-9-]*\s*[:=]\s*)\S+/gi;
// Shell-visible secret material: OPENSESAME_OPERATOR_TOKEN=…, *_SEED_FILE is a path (keep).
const SECRET_ENV =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PEPPER|PASSWORD|SEED|API_KEY)=)[^\s'"]+/g;
// TLS session secrets (SSLKEYLOGFILE lines).
const KEYLOG =
  /^(CLIENT_RANDOM|SERVER_HANDSHAKE_TRAFFIC_SECRET|CLIENT_HANDSHAKE_TRAFFIC_SECRET|CLIENT_TRAFFIC_SECRET_0|SERVER_TRAFFIC_SECRET_0|EXPORTER_SECRET|CLIENT_EARLY_TRAFFIC_SECRET)\b.*$/gm;

export const REDACTIONS = Object.freeze([
  ["private_key_block", PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]"],
  ["private_key_line", PRIVATE_KEY_LINE, "[REDACTED PRIVATE KEY LINE]"],
  ["base64_blob_line", BASE64_BLOB_LINE, "[REDACTED BASE64 BLOB]"],
  ["bearer", BEARER, "Bearer [REDACTED]"],
  ["authorization_header", AUTHORIZATION_HEADER, "$1[REDACTED]"],
  ["jwt", JWT, "[REDACTED JWT]"],
  ["nkey_seed", NKEY_SEED, "[REDACTED NKEY SEED]"],
  ["opensesame_header", OPENSESAME_HEADER, "$1[REDACTED]"],
  ["secret_env", SECRET_ENV, "$1[REDACTED]"],
  ["tls_keylog", KEYLOG, "[REDACTED TLS SECRET]"],
]);

/**
 * @param {string} text
 * @returns {{ text: string, redactions: Record<string, number> }}
 */
export function sanitize(text) {
  const counts = {};
  let out = String(text ?? "");
  for (const [name, pattern, replacement] of REDACTIONS) {
    let n = 0;
    out = out.replace(pattern, (...m) => {
      n += 1;
      // Support "$1" in the replacement without re-parsing regex groups.
      return replacement.replace("$1", typeof m[1] === "string" ? m[1] : "");
    });
    if (n > 0) counts[name] = n;
  }
  return { text: out, redactions: counts };
}

/** True when `text` still carries something a sanitizer must have caught. */
export function looksSensitive(text) {
  const { redactions } = sanitize(text);
  return Object.keys(redactions).length > 0;
}
