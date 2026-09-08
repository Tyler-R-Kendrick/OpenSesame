/** Shared last-mile guard for text crossing into model-visible tool output. */
export const REDACTED = "[REDACTED]";

const transientSecrets = new Map<string, number>();

function pruneSecrets(now: number): void {
  for (const [value, expiry] of transientSecrets) {
    if (expiry <= now) transientSecrets.delete(value);
  }
}

/** Register known short-lived authority for last-mile scrubbing; no readback API. */
export function registerAgentSecret(value: string, expiresAt: number): void {
  const now = Date.now();
  pruneSecrets(now);
  if (
    value.length < 8 ||
    value.length > 4096 ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + 300_000 ||
    (transientSecrets.size >= 64 && !transientSecrets.has(value))
  ) {
    throw new Error("agent secret redaction budget exceeded");
  }
  transientSecrets.set(value, expiresAt);
}

const SECRET_MARKERS = [
  "secret://",
  "bearer operator:",
  "agent-capability:",
  "launch_handle",
  "launchhandle",
  "client_secret",
  "clientsecret",
  "refresh_token",
  "refreshtoken",
  "access_token",
  "accesstoken",
  "private_key",
  "privatekey",
  '"authorization"',
  '"cookie"',
  "-----begin",
  "ghp_",
] as const;

function localSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  pruneSecrets(Date.now());
  const configured = [
    env.OPENSESAME_OPERATOR_TOKEN,
    env.OPENSESAME_ACCESS_TOKEN,
    env.OPENSESAME_IDENTITY_TOKEN,
    env.OPENSESAME_CLAIM_PEPPER,
    env.OPENSESAME_AGENT_LAUNCH_HANDLE,
  ].map((value) => value?.trim() ?? "");
  const bare = configured.flatMap((value) =>
    value.startsWith("opaque-session:") ? [value.slice(15)] : [],
  );
  return [...configured, ...bare, ...transientSecrets.keys()]
    .filter((value) => value.length >= 8)
    .sort((a, b) => b.length - a.length);
}

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

export function looksLikeCredential(text: string): boolean {
  const lower = text.toLowerCase();
  return SECRET_MARKERS.some((marker) => lower.includes(marker));
}

export class AgentPayloadRefused extends Error {
  constructor() {
    super("secret_in_agent_payload");
  }
}

export function forAgent(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const scrubbed = scrubLocalSecrets(text, env);
  if (looksLikeCredential(scrubbed)) throw new AgentPayloadRefused();
  return scrubbed;
}
