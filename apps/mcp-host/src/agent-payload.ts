/**
 * The last fence before a payload reaches the model.
 *
 * Every tool here relays a Host API or daemon response body straight back as tool
 * content. That is fine until something upstream echoes what it received — a 401
 * that quotes the Authorization header, a validation error that prints the request,
 * a debug field — because this process is the one holding
 * `OPENSESAME_OPERATOR_TOKEN`. A model that reads that token stops needing the
 * tools: it can call the daemon itself.
 *
 * The Rust side has `assert_no_secret_in_agent_payload` at the same boundary. This
 * is its counterpart, and it does two different jobs:
 *
 * - Secrets this process actually holds are scrubbed by value. No pattern guessing
 *   and no false positives: if the exact token appears, it is removed.
 * - Payloads carrying the shape of a credential are refused outright rather than
 *   redacted, because nothing these tools legitimately return contains one, so its
 *   presence means the response is not what we think it is.
 */

export const REDACTED = "[REDACTED]";

/**
 * Markers that make a payload one an agent must not see. Deliberately the same
 * list the Rust host enforces, so both boundaries agree on what a secret looks
 * like.
 */
const SECRET_MARKERS = [
  "secret://",
  "bearer operator:",
  "client_secret",
  "refresh_token",
  "access_token",
  "private_key",
  "-----begin",
  "ghp_",
] as const;

/** Secret values this process holds, longest first so overlaps scrub cleanly. */
function localSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = [
    env.OPENSESAME_OPERATOR_TOKEN,
    env.OPENSESAME_ACCESS_TOKEN,
    env.OPENSESAME_CLAIM_PEPPER,
  ].map((value) => value?.trim() ?? "");
  // `hostAuthHeaders` accepts a session token with or without its
  // `opaque-session:` prefix, so the bare value is a secret in its own right and
  // is what an upstream echo of the token alone would contain.
  const bare = configured
    .map((value) => value.replace(/^opaque-session:/, ""))
    .filter((value) => !configured.includes(value));
  return (
    [...configured, ...bare]
      // A one- or two-character "secret" would scrub half the payload; a real token
      // is long, and refusing to act on a short one is safer than mangling output.
      .filter((value) => value.length >= 8)
      .sort((a, b) => b.length - a.length)
  );
}

/** Remove any secret this process holds from text bound for the model. */
export function scrubLocalSecrets(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let out = text;
  for (const secret of localSecrets(env)) {
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Whether a payload carries the shape of a credential. */
export function looksLikeCredential(text: string): boolean {
  const lower = text.toLowerCase();
  return SECRET_MARKERS.some((marker) => lower.includes(marker));
}

export class AgentPayloadRefused extends Error {
  constructor() {
    super("secret_in_agent_payload");
  }
}

/**
 * Prepare an upstream body for the model, or refuse it.
 *
 * Scrubbing happens first: a response that merely echoed our own operator token is
 * usable once the token is gone, and refusing it would turn a leak into an outage.
 * What remains is checked for credential shape, and a payload that still looks
 * like one is not handed over at all.
 */
export function forAgent(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const scrubbed = scrubLocalSecrets(text, env);
  if (looksLikeCredential(scrubbed)) {
    throw new AgentPayloadRefused();
  }
  return scrubbed;
}
