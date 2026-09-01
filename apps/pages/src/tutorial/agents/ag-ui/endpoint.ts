/**
 * Where — if anywhere — this vault may send a support question.
 *
 * The remote transport is off unless a deployment turns it on, and there is no
 * fallback destination to fall back to: `readAgUiEndpoint` returns `null` for
 * absent config, for malformed config, and for every URL that is not either
 * https or http on a development origin this page already trusts. A vault that
 * nobody configured therefore answers support questions on-device or not at
 * all.
 *
 * Headers are a constant, not a setting. A browser cannot hold a bearer token
 * for a third-party endpoint — anything checked into config or typed into
 * Settings is readable by anyone who can read the deploy, and anything held in
 * storage is readable by any script that reaches this origin. So this file
 * offers no place to put one: authenticate by putting the endpoint on this
 * deployment's own origin behind a reverse proxy that holds the credential
 * server-side, or run it unauthenticated on localhost. See README.md.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { isLoopbackUrl, isSameOrigin } from "../../../lib/urls.js";

export type AgUiEndpoint = {
  readonly url: string;
  /** Content negotiation only. Never a credential — see the file comment. */
  readonly headers: ReadonlyMap<string, string>;
};

/**
 * The deploy-config key that turns the remote transport on. One key, one
 * destination: there is no header map, no token field and no second endpoint.
 */
export const AG_UI_CONFIG_KEY = "supportAgentUrl";

export type AgUiEndpointConfig = {
  readonly supportAgentUrl?: string | undefined;
};

const AG_UI_HEADERS: ReadonlyMap<string, string> = new Map([
  ["content-type", "application/json"],
  ["accept", "text/event-stream"],
]);

/**
 * Absolute http(s) with nothing smuggled in the authority or the tail.
 *
 * Parsing without a base is what rejects `//evil.example`: a scheme-relative
 * reference has no origin of its own, and resolving it against this page would
 * silently inherit ours and call an attacker's host "configured".
 */
function parseAbsoluteHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  return url;
}

/**
 * Validate one configured URL into an endpoint, or refuse it.
 *
 * https anywhere; http only where a development server legitimately lives —
 * loopback, or this page's own origin when the page itself is being served
 * over http. Cleartext to any other host would put the question and the page
 * vocabulary on the wire in the open.
 */
export function readAgUiEndpointUrl(raw: string): AgUiEndpoint | null {
  const url = parseAbsoluteHttpUrl(raw);
  if (url === null) return null;
  const normalized = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  if (url.protocol !== "https:") {
    if (!isLoopbackUrl(normalized) && !isSameOrigin(normalized)) return null;
  }
  return { url: normalized, headers: AG_UI_HEADERS };
}

/**
 * Read the endpoint out of deployment config. Absence — no config, no key, an
 * empty string, a key holding something that is not a string — is the default
 * and is not an error.
 */
export function readAgUiEndpoint(
  config: AgUiEndpointConfig | null,
): AgUiEndpoint | null {
  const raw = config?.supportAgentUrl;
  if (raw === undefined || !raw.trim()) return null;
  return readAgUiEndpointUrl(raw);
}

const RUNTIME_CONFIG_FETCH_MS = 3000;

/**
 * The same same-origin `os-runtime-config.json` the app already reads at boot
 * (`src/lib/runtime-config.ts`), read for the one key that file's typed
 * `RuntimeEndpointConfig` does not yet carry. Every failure resolves to "no
 * endpoint" rather than blocking anything.
 */
async function fetchAgUiConfigDefault(): Promise<AgUiEndpointConfig | null> {
  const base = import.meta.env.BASE_URL || "/";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNTIME_CONFIG_FETCH_MS);
  try {
    const response = await fetch(`${base}os-runtime-config.json`, {
      credentials: "omit",
      cache: "no-cache",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: BoundaryValue = await response.json();
    if (!isJsonObject(body)) return null;
    const record: JsonObject = body;
    const raw = record[AG_UI_CONFIG_KEY];
    return isString(raw) ? { supportAgentUrl: raw } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const agUiEndpointSeams = {
  fetchAgUiConfig: fetchAgUiConfigDefault,
};

/**
 * Baked at build time. A static Pages deploy never sets `VITE_*`, which is why
 * the runtime file above exists; a `pnpm dev` session or a self-hosted build
 * can use this instead and needs no boot fetch at all.
 */
const builtSupportAgentUrl = import.meta.env.VITE_SUPPORT_AGENT_URL?.trim();

let appliedEndpoint: AgUiEndpoint | null = null;

/** Apply deployment config; returns what was accepted, which may be nothing. */
export function applyAgUiEndpoint(
  config: AgUiEndpointConfig | null,
): AgUiEndpoint | null {
  appliedEndpoint = readAgUiEndpoint(config);
  return appliedEndpoint;
}

/**
 * The endpoint this deployment is currently configured for, synchronously.
 * Null — the default — means the remote transport stays off.
 */
export function currentAgUiEndpoint(): AgUiEndpoint | null {
  if (appliedEndpoint !== null) return appliedEndpoint;
  return builtSupportAgentUrl
    ? readAgUiEndpointUrl(builtSupportAgentUrl)
    : null;
}

/** Test-only: forget an applied endpoint so a case starts from the default. */
export function resetAgUiEndpointForTest(): void {
  appliedEndpoint = null;
}

/** Boot-time: read the deploy config, validate it, and remember the result. */
export async function loadAgUiEndpoint(): Promise<AgUiEndpoint | null> {
  return applyAgUiEndpoint(await agUiEndpointSeams.fetchAgUiConfig());
}
