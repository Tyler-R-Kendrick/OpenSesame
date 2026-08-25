import {
  type BoundaryValue,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type CapabilityConnectorBinding,
  type CapabilityConnectorMap,
  type CapabilityId,
  defaultCapabilityConnectors,
  normalizeCapabilityConnectors,
} from "./capabilities.js";
import { kvGet, kvSet, kvSetDurable } from "./kv.js";
import { isLoopbackUrl, normalizeTailnetBase } from "./urls.js";

export type PagesSettings = {
  hostApi: string;
  identityApi: string;
  daemonApi: string;
  tursoUrl: string;
  /** Optional Mobile MFA PWA URL for passkey ceremony handoff QR. */
  mfaAppUrl: string;
  /** Capability → Host connector bindings (encryption, git history, …). */
  capabilityConnectors: CapabilityConnectorMap;
  /**
   * Active Host project id for secrets/env scope (outside the encrypted vault).
   * Empty until personal/ensure or the operator picks a project.
   */
  activeProjectId?: string;
};

const PERSIST_KEY = "settings.v1";

type PersistedSettings = {
  hostApi: string;
  identityApi: string;
  daemonApi: string;
  tursoUrl: string;
  mfaAppUrl: string;
  capabilityConnectors: CapabilityConnectorMap;
  activeProjectId: string;
};

/** Local Host for `pages-dev.sh` — avoids the common :8787 collision. */
export const shippedHostApi = "http://127.0.0.1:18787";
/** Local Identity for `pages-dev.sh` — avoids the common :8788 collision. */
export const shippedIdentityApi = "http://127.0.0.1:18788";
export const shippedDaemonApi = "http://127.0.0.1:18790";
export const shippedMfaAppUrl = "http://127.0.0.1:5177";

/** Legacy loopback endpoints we replace when VITE_* is set at runtime. */
const LEGACY_HOST_APIS = [
  shippedHostApi,
  "http://127.0.0.1:8787",
  "http://localhost:8787",
  "http://localhost:18787",
] as const;
const LEGACY_IDENTITY_APIS = [
  shippedIdentityApi,
  "http://127.0.0.1:8788",
  "http://localhost:8788",
  "http://localhost:18788",
] as const;

const builtHostApi = import.meta.env.VITE_HOST_API?.trim();
const builtIdentityApi = import.meta.env.VITE_IDENTITY_API?.trim();
const builtDaemonApi = import.meta.env.VITE_DAEMON_API?.trim();
const builtMfaAppUrl = import.meta.env.VITE_MFA_APP_URL?.trim();

/**
 * Deployment-provided endpoints, loaded at boot from a same-origin
 * `os-runtime-config.json` beside the bundle (written by deploy-pages.sh).
 *
 * `VITE_*` values are baked at build time, which a static Pages deploy never
 * sets — that gap is exactly how the deployed vault shipped with no Identity
 * API and every sign-in silently dead-ended. This layer carries the same
 * values without a rebuild. It feeds `identityBase()` and friends only; the
 * compiled `TRUSTED_UPSTREAMS` allowlist is deliberately out of its reach
 * (ADR 0033 §2).
 */
export type RuntimeEndpointConfig = {
  hostApi?: string;
  identityApi?: string;
  daemonApi?: string;
  mfaAppUrl?: string;
};

let deployedConfig: RuntimeEndpointConfig = {};

export function applyRuntimeConfig(config: RuntimeEndpointConfig): void {
  deployedConfig = {
    ...(config.hostApi?.trim() ? { hostApi: config.hostApi.trim() } : {}),
    ...(config.identityApi?.trim()
      ? { identityApi: config.identityApi.trim() }
      : {}),
    ...(config.daemonApi?.trim() ? { daemonApi: config.daemonApi.trim() } : {}),
    ...(config.mfaAppUrl?.trim() ? { mfaAppUrl: config.mfaAppUrl.trim() } : {}),
  };
  emitSettings();
}

function runtimeHostApiValue(): string | undefined {
  return deployedConfig.hostApi || builtHostApi;
}

function runtimeIdentityApiValue(): string | undefined {
  return deployedConfig.identityApi || builtIdentityApi;
}

function runtimeDaemonApiValue(): string | undefined {
  return deployedConfig.daemonApi || builtDaemonApi;
}

function runtimeMfaAppUrlValue(): string | undefined {
  return deployedConfig.mfaAppUrl || builtMfaAppUrl;
}

const listeners = new Set<() => void>();

/** Bumped on every write so a component can re-render for a changed base URL. */
let epoch = 0;

export function settingsEpoch(): number {
  return epoch;
}

/** True when this tab is served from the same machine it can reach on loopback. */
function pageIsLoopbackDefault(hostname?: string): boolean {
  const host =
    hostname ??
    (globalThis.location === undefined
      ? "127.0.0.1"
      : globalThis.location.hostname);
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

function localDefaults(): PersistedSettings {
  return {
    hostApi: runtimeHostApiValue() || shippedHostApi,
    identityApi: runtimeIdentityApiValue() || shippedIdentityApi,
    daemonApi: runtimeDaemonApiValue() || shippedDaemonApi,
    tursoUrl: "",
    mfaAppUrl: runtimeMfaAppUrlValue() || shippedMfaAppUrl,
    capabilityConnectors: defaultCapabilityConnectors(),
    activeProjectId: "",
  };
}

function remoteDefaults(): PersistedSettings {
  return {
    hostApi: runtimeHostApiValue() || "",
    identityApi: runtimeIdentityApiValue() || "",
    // github.io cannot reach loopback — leave empty so the pairing UI asks for
    // the Tailscale Serve FQDN instead of looking like localhost will work.
    daemonApi: runtimeDaemonApiValue() || "",
    tursoUrl: "",
    // Remote Pages: operator must point at a reachable MFA PWA.
    mfaAppUrl: runtimeMfaAppUrlValue() || "",
    capabilityConnectors: defaultCapabilityConnectors(),
    activeProjectId: "",
  };
}

function defaultsForPage(): PersistedSettings {
  return pageIsLoopback() ? localDefaults() : remoteDefaults();
}

function optionalString(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isString(value)) throw new Error("invalid persisted string");
  return value;
}

function readCapabilityConnectors(
  value: JsonValue | undefined,
):
  | Partial<Record<CapabilityId, Partial<CapabilityConnectorBinding>>>
  | undefined {
  if (!isJsonObject(value)) return undefined;
  const connectors: Partial<
    Record<CapabilityId, Partial<CapabilityConnectorBinding>>
  > = {};
  for (const id of ["encryption", "history"] as const) {
    const candidate = value[id];
    if (!isJsonObject(candidate)) continue;
    connectors[id] = {
      ...(isString(candidate.providerId)
        ? { providerId: candidate.providerId }
        : undefined),
      ...(isString(candidate.connectionId)
        ? { connectionId: candidate.connectionId }
        : undefined),
      ...(isString(candidate.remote)
        ? { remote: candidate.remote }
        : undefined),
    };
  }
  return connectors;
}

function loadPersisted(): PersistedSettings {
  const defaults = defaultsForPage();
  try {
    const raw = kvGet(PERSIST_KEY);
    if (!raw) return { ...defaults };
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) throw new Error("invalid persisted settings");
    const hostApi = optionalString(parsed.hostApi)?.trim() ?? "";
    const identityApi = optionalString(parsed.identityApi)?.trim() ?? "";
    const daemonApi = optionalString(parsed.daemonApi)?.trim() ?? "";
    const tursoUrl = optionalString(parsed.tursoUrl)?.trim() ?? "";
    const mfaAppUrl = optionalString(parsed.mfaAppUrl);
    return {
      hostApi:
        hostApi &&
        !(
          runtimeHostApiValue() &&
          LEGACY_HOST_APIS.some((legacy) => legacy === hostApi)
        )
          ? hostApi
          : defaults.hostApi,
      identityApi:
        identityApi &&
        !(
          runtimeIdentityApiValue() &&
          LEGACY_IDENTITY_APIS.some((legacy) => legacy === identityApi)
        )
          ? identityApi
          : defaults.identityApi,
      daemonApi: daemonApi || defaults.daemonApi,
      tursoUrl,
      mfaAppUrl:
        mfaAppUrl !== undefined ? mfaAppUrl.trim() : defaults.mfaAppUrl,
      capabilityConnectors: normalizeCapabilityConnectors(
        readCapabilityConnectors(parsed.capabilityConnectors),
      ),
      activeProjectId: isString(parsed.activeProjectId)
        ? parsed.activeProjectId.trim()
        : defaults.activeProjectId,
    };
  } catch {
    return { ...defaults };
  }
}

function loadSettingsDefault(): PagesSettings {
  return loadPersisted();
}

function emitSettings(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

function subscribeSettingsDefault(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function persistRecord(next: PagesSettings): PersistedSettings {
  const defaults = defaultsForPage();
  return {
    hostApi: next.hostApi.trim() || defaults.hostApi,
    identityApi: next.identityApi.trim() || defaults.identityApi,
    daemonApi: next.daemonApi.trim() || defaults.daemonApi,
    tursoUrl: next.tursoUrl?.trim() ?? "",
    mfaAppUrl: next.mfaAppUrl?.trim() ?? "",
    capabilityConnectors: normalizeCapabilityConnectors(
      next.capabilityConnectors ?? defaults.capabilityConnectors,
    ),
    activeProjectId: next.activeProjectId?.trim() ?? "",
  };
}

function saveSettingsDefault(next: PagesSettings): void {
  kvSet(PERSIST_KEY, JSON.stringify(persistRecord(next)));
  emitSettings();
}

/** Persist pairing and wait for OPFS so a reload in this browser keeps Host. */
export async function saveSettingsDurable(next: PagesSettings): Promise<void> {
  await kvSetDurable(PERSIST_KEY, JSON.stringify(persistRecord(next)));
  emitSettings();
}

/**
 * Host/daemon already pointed at a reachable-from-github.io endpoint — do not
 * demand "Connect this machine" again until the operator clears Settings.
 */
export function hasRemoteHostPairing(
  settings: PagesSettings = loadSettings(),
): boolean {
  const host = settings.hostApi.trim();
  if (host && !isLoopbackUrl(host)) return true;
  const daemon = settings.daemonApi.trim();
  if (!daemon || isLoopbackUrl(daemon)) return false;
  return normalizeTailnetBase(daemon) !== null;
}

/** Auto-connect Identity only when this page can actually reach it. */
function shouldAutoConnectDefault(
  settings: PagesSettings = loadSettings(),
  hostname?: string,
): boolean {
  const identity = settings.identityApi.trim();
  if (!identity) return false;
  if (pageIsLoopback(hostname)) return true;
  return !isLoopbackUrl(identity);
}

export const settingsSeams = {
  loadSettings: loadSettingsDefault,
  saveSettings: saveSettingsDefault,
  subscribeSettings: subscribeSettingsDefault,
  pageIsLoopback: pageIsLoopbackDefault,
  shouldAutoConnect: shouldAutoConnectDefault,
  shippedDaemonApi,
};

export function loadSettings(): PagesSettings {
  return settingsSeams.loadSettings();
}

export function saveSettings(next: PagesSettings): void {
  settingsSeams.saveSettings(next);
}

export function subscribeSettings(listener: () => void): () => void {
  return settingsSeams.subscribeSettings(listener);
}

export function pageIsLoopback(hostname?: string): boolean {
  return hostname === undefined
    ? settingsSeams.pageIsLoopback()
    : settingsSeams.pageIsLoopback(hostname);
}

export function shouldAutoConnect(
  settings?: PagesSettings,
  hostname?: string,
): boolean {
  if (settings === undefined) return settingsSeams.shouldAutoConnect();
  return settingsSeams.shouldAutoConnect(settings, hostname);
}
