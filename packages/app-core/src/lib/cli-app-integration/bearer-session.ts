/**
 * CLI app-integration session bearer (ADR 0186).
 * Kept separate from `pairing.ts` so authorize UI can read the token without
 * loading pairing wire exchange code.
 */

import { sessionStore } from "../../ports.js";

export const CLI_APP_INTEGRATION_BEARER_KEY =
  "opensesame-cli-app-integration-bearer";

/** 32 random bytes, unpadded base64url — same as pairing `code` / daemon `token`. */
const BEARER_SECRET = /^[A-Za-z0-9_-]{43}$/;

export function readCliAppIntegrationBearer(): string | null {
  try {
    const raw = sessionStore().getItem(CLI_APP_INTEGRATION_BEARER_KEY);
    return raw && BEARER_SECRET.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeCliAppIntegrationBearer(token: string): void {
  if (!BEARER_SECRET.test(token)) return;
  try {
    sessionStore().setItem(CLI_APP_INTEGRATION_BEARER_KEY, token);
  } catch {
    // session store unavailable
  }
}

export function clearCliAppIntegrationBearer(): void {
  try {
    sessionStore().removeItem(CLI_APP_INTEGRATION_BEARER_KEY);
  } catch {
    // session store unavailable
  }
}
