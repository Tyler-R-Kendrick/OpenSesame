/** Session-held bearer for daemon CLI app-integration (ADR 0186). */

import { sessionStore } from "../../ports.js";

export const CLI_APP_INTEGRATION_BEARER_KEY =
  "opensesame-cli-app-integration-bearer";

/** Same shape as plugin pairing secrets (`plugin-pairing.ts` SECRET). */
const BEARER_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function readCliAppIntegrationBearer(): string | null {
  try {
    const raw = sessionStore().getItem(CLI_APP_INTEGRATION_BEARER_KEY);
    return raw && BEARER_TOKEN.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeCliAppIntegrationBearer(token: string): void {
  if (!BEARER_TOKEN.test(token)) return;
  try {
    sessionStore().setItem(CLI_APP_INTEGRATION_BEARER_KEY, token);
  } catch {
    // session store unavailable
  }
}
