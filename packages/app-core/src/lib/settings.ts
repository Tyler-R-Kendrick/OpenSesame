import {
  type BoundaryValue,
  ENDPOINTS,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { type RuntimeEnv, env } from "../host.js";
import { maybePage, page } from "../ports.js";
import { noteSettingsUpdated } from "./activity-log.js";
import {
  type CapabilityConnectorMap,
  defaultCapabilityConnectors,
} from "./capabilities.js";
import {
  SETTINGS_PERSIST_KEY as PERSIST_KEY,
  bindingsFromStored,
  scopeCapabilityConnectorsForSave,
} from "./capability-connector-scope.js";
import { kvGet, kvSet } from "./kv.js";
import { isLoopbackUrl } from "./urls.js";

/** Operator-configured IdP (browser OIDC + PKCE, ADR 0078) — not Identity API. */
export type OperatorIdp = {
  /** Preset id that brands the sign-in button ("google", "okta", …). */
  providerId: string;
  /** The OIDC issuer, as published in its discovery document. */
  issuer: string;
  /** The public client id the operator registered for this origin. */
  clientId: string;
  /** What the sign-in button calls it. */
  label: string;
};

/** Allowlist of sign-in roads; the screen renders exactly this. */
export type SignInMethods = {
  /** Keep the compiled-in broker as a way in until an operator turns it off. */
  builtin: boolean;
  /** Providers the operator configured, in the order they were added. */
  providers: OperatorIdp[];
};

export type PagesSettings = {
  hostApi: string;
  identityApi: string;
  daemonApi: string;
  /** Capability → connector bindings for the vault that is open. */
  capabilityConnectors: CapabilityConnectorMap;
  /**
   * Every way into this deployment. Absent means nobody has answered first-run
   * setup, which reads as the shipped default: the compiled-in broker and
   * nothing else. Optional so every existing settings literal stays valid.
   */
  signIn?: SignInMethods;
  /**
   * Active Host project id for secrets/env scope (outside the encrypted vault).
   * Empty until personal/ensure or the operator picks a project.
   */
  activeProjectId?: string;
};

const TRAILING_SLASHES = /\/+$/;

type PersistedSettings = {
  hostApi: string;
  identityApi: string;
  daemonApi: string;
  capabilityConnectors: CapabilityConnectorMap;
  /** Present once a record is per-vault. Legacy records omit it. */
  capabilityConnectorsByVault: Record<string, CapabilityConnectorMap>;
  activeProjectId: string;
  signIn: SignInMethods;
};

/**
 * Default service addresses (`spec/config/endpoints.json`): suggestions a
 * loopback tab may offer in a pairing field, never assumed (ADR 0090).
 */
export const shippedHostApi = ENDPOINTS.host.default;
export const shippedIdentityApi = ENDPOINTS.identity.default;
export const shippedDaemonApi = ENDPOINTS.daemon.default;

/** Legacy loopback endpoints we replace when VITE_* is set at runtime. */
const LEGACY_HOST_APIS = [
  shippedHostApi,
  "http://localhost:8787",
  "http://127.0.0.1:18787",
  "http://localhost:18787",
] as const;
const LEGACY_IDENTITY_APIS = [
  shippedIdentityApi,
  "http://localhost:8788",
  "http://127.0.0.1:18788",
  "http://localhost:18788",
] as const;

const built = (key: Extract<keyof RuntimeEnv, `VITE_${string}`>) =>
  env()[key]?.trim();

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
  /**
   * Optional remote support endpoint (ADR 0087). A destination, never a
   * credential: the browser sends no authorization header to it, so an
   * operator who needs one puts a same-origin proxy in front.
   */
  supportAgentUrl?: string;
};

let deployedConfig: RuntimeEndpointConfig = {};

export function applyRuntimeConfig(config: RuntimeEndpointConfig): void {
  const next: RuntimeEndpointConfig = {};
  if (config.hostApi?.trim()) next.hostApi = config.hostApi.trim();
  if (config.identityApi?.trim()) next.identityApi = config.identityApi.trim();
  if (config.daemonApi?.trim()) next.daemonApi = config.daemonApi.trim();
  if (config.supportAgentUrl?.trim()) {
    next.supportAgentUrl = config.supportAgentUrl.trim();
  }
  deployedConfig = next;
  emitSettings();
}

function runtimeHostApiValue(): string | undefined {
  return deployedConfig.hostApi || built("VITE_HOST_API");
}

function runtimeIdentityApiValue(): string | undefined {
  return deployedConfig.identityApi || built("VITE_IDENTITY_API");
}

function runtimeDaemonApiValue(): string | undefined {
  return deployedConfig.daemonApi || built("VITE_DAEMON_API");
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
    (maybePage() === undefined ? "127.0.0.1" : page().location.hostname);
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/**
 * An OpenSesame Identity API is optional. First-run sign-in is the compiled
 * Shoo/Google broker. Loopback URLs baked by `pages-dev.sh` (`VITE_IDENTITY_API`
 * / `shippedIdentityApi`) must not become a requirement just because this tab
 * is on localhost.
 */
export function defaultIdentityApi(): string {
  const deployed = deployedConfig.identityApi?.trim();
  if (deployed) return deployed;
  const baked = built("VITE_IDENTITY_API");
  if (!baked || isLoopbackUrl(baked)) return "";
  return baked;
}

/**
 * What this app talks to when nobody has said: nothing.
 *
 * Host / Identity / daemon are not Pages backends (ADR 0090; Tyler
 * 2026-10-08). Empty defaults are honest on every origin. A static deploy
 * ships `{}` in `os-runtime-config.json`. Full-stack local tabs may still
 * bake `VITE_*` via `pages-dev.sh`; that is operator tooling, not the
 * shipped PWA. The shipped loopback values remain *suggestions* only where
 * a loopback tab explicitly asks (`shippedHostApi` and friends).
 */
function defaultsForPage(): PersistedSettings {
  return {
    hostApi: runtimeHostApiValue() || "",
    identityApi: defaultIdentityApi(),
    daemonApi: runtimeDaemonApiValue() || "",
    capabilityConnectors: defaultCapabilityConnectors(),
    capabilityConnectorsByVault: {},
    activeProjectId: "",
    signIn: defaultSignInMethods(),
  };
}

function optionalString(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isString(value)) throw new Error("invalid persisted string");
  return value;
}

/** What a deployment nobody has set up offers: the compiled-in broker. */
export function defaultSignInMethods(): SignInMethods {
  return { builtin: true, providers: [] };
}

/**
 * A provider is admitted only whole: an absolute https issuer (or loopback
 * http, for a local IdP) and a non-empty client id. A half-written record
 * would otherwise become a trusted issuer with nothing behind it — see
 * `isOperatorIdpIssuer` in `federation.ts`, which reads this.
 */
export function normalizeOperatorIdp(
  providerId: string,
  issuer: string,
  clientId: string,
  label?: string,
): OperatorIdp | null {
  const trimmedIssuer = issuer.trim().replace(TRAILING_SLASHES, "");
  const trimmedClientId = clientId.trim();
  if (!trimmedIssuer || !trimmedClientId) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmedIssuer);
  } catch {
    return null;
  }
  // https, or loopback http for a local IdP. Anything else would send an
  // authorization code over the wire in the clear.
  if (parsed.protocol !== "https:" && !isLoopbackUrl(trimmedIssuer)) {
    return null;
  }
  return {
    providerId: providerId.trim(),
    issuer: trimmedIssuer,
    clientId: trimmedClientId,
    label: label?.trim() || parsed.hostname,
  };
}

function readOperatorIdp(value: JsonValue | undefined): OperatorIdp | null {
  if (!isJsonObject(value)) return null;
  const { providerId, issuer, clientId, label } = value;
  if (!isString(issuer) || !isString(clientId)) return null;
  return normalizeOperatorIdp(
    isString(providerId) ? providerId : "",
    issuer,
    clientId,
    isString(label) ? label : undefined,
  );
}

/**
 * The ways in, read back whole.
 *
 * A provider is admitted only if it could actually run a flow, and only once
 * per issuer: two entries for one issuer would put the same button on the
 * sign-in screen twice and make "remove" ambiguous.
 */
function readSignInMethods(value: JsonValue | undefined): SignInMethods {
  if (!isJsonObject(value)) return defaultSignInMethods();
  const providers: OperatorIdp[] = [];
  const seen = new Set<string>();
  const listed = value.providers;
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      const idp = readOperatorIdp(entry);
      if (!idp || seen.has(idp.issuer)) continue;
      seen.add(idp.issuer);
      providers.push(idp);
    }
  }
  return { builtin: value.builtin !== false, providers };
}

/** Every way into this deployment, defaults filled in. */
export function signInMethods(
  settings: PagesSettings = loadSettings(),
): SignInMethods {
  return settings.signIn ?? defaultSignInMethods();
}

/**
 * True when nothing here could sign anybody in.
 *
 * Not the same as "no identity service": the compiled-in broker and every
 * provider the operator brought run in the browser and need no service at all
 * (ADR 0078). The unlock screen used to equate the two and offer setup above a
 * working Google button.
 */
export function noWayIn(settings: PagesSettings = loadSettings()): boolean {
  const methods = signInMethods(settings);
  if (methods.builtin || methods.providers.length > 0) return false;
  return settings.identityApi.trim().length === 0;
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
    return {
      hostApi:
        hostApi &&
        !(
          runtimeHostApiValue() &&
          LEGACY_HOST_APIS.some((legacy) => legacy === hostApi)
        )
          ? hostApi
          : defaults.hostApi,
      identityApi: (() => {
        const rewriteLegacy =
          Boolean(identityApi) &&
          Boolean(runtimeIdentityApiValue()) &&
          LEGACY_IDENTITY_APIS.some((legacy) => legacy === identityApi);
        if (rewriteLegacy) return runtimeIdentityApiValue() ?? "";
        return identityApi || defaults.identityApi;
      })(),
      daemonApi: daemonApi || defaults.daemonApi,
      ...bindingsFromStored(parsed),
      activeProjectId: isString(parsed.activeProjectId)
        ? parsed.activeProjectId.trim()
        : defaults.activeProjectId,
      signIn: readSignInMethods(parsed.signIn),
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
  noteSettingsUpdated();
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
    ...scopeCapabilityConnectorsForSave(
      next.capabilityConnectors ?? defaults.capabilityConnectors,
    ),
    activeProjectId: next.activeProjectId?.trim() ?? "",
    signIn: readSignInMethods({
      builtin: next.signIn?.builtin !== false,
      providers: (next.signIn?.providers ?? []).map((idp) => ({ ...idp })),
    }),
  };
}

function saveSettingsDefault(next: PagesSettings): void {
  kvSet(PERSIST_KEY, JSON.stringify(persistRecord(next)));
  emitSettings();
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
