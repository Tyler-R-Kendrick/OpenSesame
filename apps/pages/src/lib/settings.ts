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

/**
 * An identity provider the operator configured, which this deployment runs
 * itself — the whole OIDC code flow, in the browser, with PKCE (ADR 0078).
 *
 * This is the answer to "who signs people in here?" for a deployment that
 * brings its own IdP. It is NOT an address for an OpenSesame identity service:
 * a Google project, an Okta org, an Auth0 tenant, an Entra directory or a
 * Better Auth deployment IS the identity service once it is named here, and
 * the app needs nothing else to sign somebody in against it.
 *
 * `clientId` is a public client id — the redirect URI and PKCE are what bind
 * the flow, and there is no secret to hold. Both fields are configuration, not
 * credentials.
 */
export type OperatorIdp = {
  /**
   * The preset this came through ("google", "microsoft", "okta", …). It is
   * what brands the button on the sign-in screen; an id with no brand gets the
   * house treatment rather than a wrong logo.
   */
  providerId: string;
  /** The OIDC issuer, as published in its discovery document. */
  issuer: string;
  /** The public client id the operator registered for this origin. */
  clientId: string;
  /** What the sign-in button calls it. */
  label: string;
};

/**
 * Every way into this deployment, as first-run setup left it.
 *
 * This is an allowlist, not a hint. The sign-in screen renders exactly what is
 * here and nothing else: a provider nobody configured is not a road, and
 * offering it would be the dead end the whole first-run rework exists to
 * remove. An OpenSesame identity service is the third way in and lives in
 * `identityApi` — where it is set, its own catalog, magic links, guest
 * sessions and org SSO come with it.
 */
export type SignInMethods = {
  /**
   * Keep the browser-capable upstream compiled into this build as a way in.
   * True until an operator says otherwise, so a deployment nobody has set up
   * can still sign somebody in.
   */
  builtin: boolean;
  /** Providers the operator configured, in the order they were added. */
  providers: OperatorIdp[];
};

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

const PERSIST_KEY = "settings.v1";

const TRAILING_SLASHES = /\/+$/;

type PersistedSettings = {
  hostApi: string;
  identityApi: string;
  daemonApi: string;
  tursoUrl: string;
  mfaAppUrl: string;
  capabilityConnectors: CapabilityConnectorMap;
  activeProjectId: string;
  signIn: SignInMethods;
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
  if (config.mfaAppUrl?.trim()) next.mfaAppUrl = config.mfaAppUrl.trim();
  if (config.supportAgentUrl?.trim()) {
    next.supportAgentUrl = config.supportAgentUrl.trim();
  }
  deployedConfig = next;
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

/**
 * An OpenSesame Identity API is optional. First-run sign-in is the compiled
 * Shoo/Google broker. Loopback URLs baked by `pages-dev.sh` (`VITE_IDENTITY_API`
 * / `shippedIdentityApi`) must not become a requirement just because this tab
 * is on localhost.
 */
function defaultIdentityApi(): string {
  const deployed = deployedConfig.identityApi?.trim();
  if (deployed) return deployed;
  const built = builtIdentityApi?.trim();
  if (!built || isLoopbackUrl(built)) return "";
  return built;
}

function localDefaults(): PersistedSettings {
  return {
    hostApi: runtimeHostApiValue() || shippedHostApi,
    identityApi: defaultIdentityApi(),
    daemonApi: runtimeDaemonApiValue() || shippedDaemonApi,
    tursoUrl: "",
    mfaAppUrl: runtimeMfaAppUrlValue() || shippedMfaAppUrl,
    capabilityConnectors: defaultCapabilityConnectors(),
    activeProjectId: "",
    signIn: defaultSignInMethods(),
  };
}

function remoteDefaults(): PersistedSettings {
  return {
    hostApi: runtimeHostApiValue() || "",
    identityApi: defaultIdentityApi(),
    // github.io cannot reach loopback — leave empty so the pairing UI asks for
    // the Tailscale Serve FQDN instead of looking like localhost will work.
    daemonApi: runtimeDaemonApiValue() || "",
    tursoUrl: "",
    // Remote Pages: operator must point at a reachable MFA PWA.
    mfaAppUrl: runtimeMfaAppUrlValue() || "",
    capabilityConnectors: defaultCapabilityConnectors(),
    activeProjectId: "",
    signIn: defaultSignInMethods(),
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
      identityApi: (() => {
        const rewriteLegacy =
          Boolean(identityApi) &&
          Boolean(runtimeIdentityApiValue()) &&
          LEGACY_IDENTITY_APIS.some((legacy) => legacy === identityApi);
        if (rewriteLegacy) return runtimeIdentityApiValue() ?? "";
        return identityApi || defaults.identityApi;
      })(),
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
