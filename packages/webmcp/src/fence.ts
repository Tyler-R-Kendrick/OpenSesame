/**
 * Browser-safe port of the agent-payload fence in
 * `@opensesame/observability` (`packages/observability/src/agent-payload.ts`).
 * The original types its env as `NodeJS.ProcessEnv` and reads the `process`
 * global unconditionally, so it cannot be imported from a page. The scrub
 * logic is ported verbatim; `fence.characterization.test.ts` runs both
 * implementations against the same fixtures to keep them identical.
 */

import {
  type BoundaryObject,
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";

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

export type FenceEnv = Record<string, string | undefined>;

function runtimeEnv(): FenceEnv {
  const globals: BoundaryObject = overlapCast(globalThis);
  const processValue = globals.process;
  if (!isJsonObject(processValue)) return {};
  const env = processValue.env;
  if (!isJsonObject(env)) return {};
  const out: FenceEnv = overlapCast(env);
  return out;
}

function localSecrets(env: FenceEnv): string[] {
  const configured = [
    env.OPENSESAME_OPERATOR_TOKEN,
    env.OPENSESAME_ACCESS_TOKEN,
    env.OPENSESAME_IDENTITY_TOKEN,
    env.OPENSESAME_CLAIM_PEPPER,
  ].map((value) => value?.trim() ?? "");
  const bare = configured.flatMap((value) =>
    value.startsWith("opaque-session:") ? [value.slice(15)] : [],
  );
  return [...configured, ...bare]
    .filter((value) => value.length >= 8)
    .sort((a, b) => b.length - a.length);
}

export function scrubLocalSecrets(
  text: string,
  env: FenceEnv = runtimeEnv(),
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

export function forAgent(text: string, env: FenceEnv = runtimeEnv()): string {
  const scrubbed = scrubLocalSecrets(text, env);
  if (looksLikeCredential(scrubbed)) throw new AgentPayloadRefused();
  return scrubbed;
}

/**
 * Serialize a tool payload and run it through the fence. Strings pass as-is;
 * everything else is JSON so structured results stay machine-readable.
 */
export function fenceForAgent(
  payload: BoundaryValue,
  env: FenceEnv = runtimeEnv(),
): string {
  const text = isString(payload) ? payload : JSON.stringify(payload ?? null);
  return forAgent(text, env);
}
