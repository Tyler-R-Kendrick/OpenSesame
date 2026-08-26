/**
 * Boot-time deployment config — `os-runtime-config.json` beside the bundle.
 *
 * A static Pages deploy cannot bake `VITE_*` endpoints without a rebuild, so
 * deploy-pages.sh writes this small same-origin file instead and the app reads
 * it once before first render. Absence is normal (a dev server, an older
 * deploy); every failure resolves to "no config" rather than blocking boot.
 *
 * The file only carries endpoint URLs for the Settings layer. It can never
 * extend the compiled upstream trust list (ADR 0033 §2) — a hijacked config
 * could at worst point this app at a different Identity API, which is the
 * same power the Settings screen already grants.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { type RuntimeEndpointConfig, applyRuntimeConfig } from "./settings.js";

const RUNTIME_CONFIG_FETCH_MS = 3000;

function readEndpoint(value: BoundaryValue | undefined): string | undefined {
  return isString(value) && value.trim() ? value.trim() : undefined;
}

async function fetchRuntimeConfigDefault(): Promise<RuntimeEndpointConfig | null> {
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
    return {
      hostApi: readEndpoint(body.hostApi),
      identityApi: readEndpoint(body.identityApi),
      daemonApi: readEndpoint(body.daemonApi),
      mfaAppUrl: readEndpoint(body.mfaAppUrl),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const runtimeConfigSeams = {
  fetchRuntimeConfig: fetchRuntimeConfigDefault,
};

/** Load and apply the deployment config; safe to call on every boot. */
export async function loadRuntimeConfig(): Promise<void> {
  const config = await runtimeConfigSeams.fetchRuntimeConfig();
  if (config) applyRuntimeConfig(config);
}
