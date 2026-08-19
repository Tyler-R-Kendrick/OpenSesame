/** Shared last-mile guard for text crossing into model-visible tool output. */
export const REDACTED = "[REDACTED]";

const SECRET_MARKERS = [
  "secret://",
  "bearer operator:",
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
  const configured = [
    env.OPENSESAME_OPERATOR_TOKEN,
    env.OPENSESAME_ACCESS_TOKEN,
    env.OPENSESAME_IDENTITY_TOKEN,
    env.OPENSESAME_CLAIM_PEPPER,
  ].map((value) => value?.trim() ?? "");
  const bare = configured
    .map((value) => value.replace(/^opaque-session:/, ""))
    .filter((value) => !configured.includes(value));
  return [...configured, ...bare]
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
