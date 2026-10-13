import { readCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import { loadSettings } from "@opensesame/app-core/lib/settings.js";
import { maybePage } from "@opensesame/app-core/ports.js";

export const CLI_AUTHORIZE_ROUTE = "/identity/authorize?cli=1";

export function readDaemonOrigin(): string | null {
  const raw = loadSettings().daemonApi.trim() || "http://127.0.0.1:18790";
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).origin.replace(
      /\/$/,
      "",
    );
  } catch {
    return null;
  }
}

export function readCliAppAuthHeaders(): Record<string, string> | null {
  const token = readCliAppIntegrationBearer();
  const origin = maybePage()?.location.origin ?? null;
  if (!token || !origin) return null;
  return {
    authorization: `Bearer ${token}`,
    Origin: origin,
  };
}
