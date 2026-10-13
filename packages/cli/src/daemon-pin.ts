import { cliAppIntegrationPolicy } from "@opensesame/app-core/lib/cli-app-integration/index.js";
import {
  type BoundaryValue,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Remote daemon CLI app-integration requires invite + device flow (not wired yet). */
export function isLoopbackDaemonBase(base: string): boolean {
  try {
    const url = new URL(base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function healthLooksLikeDaemon(base: string): Promise<boolean> {
  const response = await fetch(`${base}/health`, { method: "GET" });
  if (!response.ok) return false;
  const body: BoundaryValue = await response.json();
  if (!isJsonObject(body)) return false;
  return readString(body.status) === "ok";
}

/**
 * Terminal session id the loopback pin probe sends. A real daemon never
 * returns `approved` for it; journey fakes answer `pending` (see fixtures).
 */
export const CLI_APP_DAEMON_PIN_PROBE_SESSION_ID =
  "opensesame-cli-daemon-pin-probe";

/**
 * Real daemon ensure never returns `approved` on a cold probe; impostors that
 * auto-approve are rejected here.
 */
async function ensureProbeRejectsInstantApproval(
  base: string,
): Promise<boolean> {
  const path = cliAppIntegrationPolicy.daemonPaths.ensure;
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      terminalSessionId: CLI_APP_DAEMON_PIN_PROBE_SESSION_ID,
      verb: "read",
    }),
  });
  if (!response.ok) return false;
  const body: BoundaryValue = await response.json();
  if (!isJsonObject(body)) return false;
  const status = readString(body.status);
  if (status === "approved") return false;
  return (
    status === "pending" ||
    status === "denied" ||
    status === "expired" ||
    status === "wrongSession"
  );
}

/** Pin loopback `OPENSESAME_DAEMON_API` to an OpenSesame daemon before trusting ensure. */
export async function verifyLocalDaemonForCliAppIntegration(
  base: string,
): Promise<boolean> {
  if (!isLoopbackDaemonBase(base)) return false;
  try {
    if (!(await healthLooksLikeDaemon(base))) return false;
    return await ensureProbeRejectsInstantApproval(base);
  } catch {
    return false;
  }
}
