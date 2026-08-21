/**
 * Core connector status — what the connectivity bar shows.
 *
 * Host, Identity, and this machine have to answer before OpenSesame can
 * authorize anything. Git history is optional persistence on top of the
 * in-browser vault; the key vault defaults to WebCrypto on this device.
 * Settings used to state all five as endpoint forms; they are states, so they
 * read as glyphs and are repaired by a ceremony instead.
 *
 * Nothing here probes. Reachability arrives from the connectivity monitor,
 * which owns the schedule for the whole tab; history and keys are derived from
 * the persisted capability bindings. This file's only job is turning both into
 * something a glyph can say.
 */

import { briefOrigin, repoHint } from "@opensesame/os-domain";
import {
  type CapabilityConnectorBinding,
  type CapabilityId,
  capabilityDef,
  connectorLabel,
} from "./capabilities.js";
import {
  type MonitorSnapshot,
  type TargetState,
  daemonIsProbable,
  useConnectivityMonitor,
} from "./connectivity-monitor.js";
import {
  type HostPlane,
  type IdentityPlane,
  type PlaneStatus,
  usePlaneStatus,
} from "./planes.js";
import { type FailureClass, failureLabel } from "./probe-failure.js";
import {
  type PagesSettings,
  loadSettings,
  pageIsLoopback,
} from "./settings.js";
import { useSettingsEpoch } from "./use-settings.js";

export { briefOrigin, repoHint };

export type ConnectorId = "host" | "identity" | "machine" | "history" | "keys";

/**
 * `live` is green with a pip, `attn` is amber with a pip, `off` is a ghosted
 * glyph with no pip, and `offline` is the browser having no network at all.
 *
 * `offline` earns its own tone because the alternative is a lie: with the
 * radio off, every remote connector would go amber and blame an endpoint that
 * is probably fine. One cause, said once, beats four wrong diagnoses.
 *
 * A probe in flight never changes the tone — it shows as a pulse instead, so
 * the bar does not flicker every cadence.
 */
export type ConnectorTone = "live" | "attn" | "off" | "offline";

export type ConnectorStatus = {
  id: ConnectorId;
  /** Short name, used in the tile and the glyph's accessible name. */
  name: string;
  tone: ConnectorTone;
  /** One line of truth: an origin, a principal, or what is missing. */
  detail: string;
  /** Required connectors are the ones a ceremony can be blocked on. */
  required: boolean;
  /** Why it is failing, when we can tell. Null for anything not probed. */
  failure: FailureClass | null;
  /** Epoch ms of the last completed probe; null for settings-derived state. */
  lastCheckedAt: number | null;
  /** A probe is in flight — shown as a pulse, never as a tone change. */
  checking: boolean;
};

/** Bar order, left to right. Also the tile order in Settings. */
export const CONNECTOR_IDS: readonly ConnectorId[] = [
  "host",
  "identity",
  "machine",
  "history",
  "keys",
] as const;

/**
 * The label for a failing probe.
 *
 * An `offline` failure class only makes sense while the browser is actually
 * offline. A probe that failed during a momentary blip can resolve after the
 * radio is back, and rendering its stamp would pair an amber glyph with the
 * word "Offline" — a warning to go fix an endpoint beside copy saying there is
 * nothing to fix. Once we are online, that stamp is stale, not informative.
 */
function labelFor(target: TargetState, base: string, offline: boolean): string {
  const failure =
    !offline && target.failure === "offline"
      ? "unreachable"
      : (target.failure ?? "unreachable");
  return failureLabel(failure, base);
}

/** Fields every probed connector carries, whatever its tone works out to be. */
function probed(
  target: TargetState,
): Pick<ConnectorStatus, "failure" | "lastCheckedAt" | "checking"> {
  return {
    failure: target.failure,
    lastCheckedAt: target.lastCheckedAt,
    checking: target.checking,
  };
}

/** Settings-derived connectors are never probed, so they have no freshness. */
const UNPROBED = {
  failure: null,
  lastCheckedAt: null,
  checking: false,
} as const;

export function classifyHostConnector(
  status: PlaneStatus,
  target: TargetState,
  offline: boolean,
): ConnectorStatus {
  const base = briefOrigin(status.hostBase);
  const shell = { id: "host", name: "Host", required: true } as const;
  if (status.host === "unset") {
    return {
      ...shell,
      tone: "off",
      detail: "Not configured",
      ...probed(target),
    };
  }
  if (offline) {
    return { ...shell, tone: "offline", detail: "Offline", ...probed(target) };
  }
  const byPlane: Record<HostPlane, { tone: ConnectorTone; detail: string }> = {
    live: { tone: "live", detail: base },
    pending: { tone: "live", detail: base ? `Checking ${base}` : "Checking" },
    loopback: {
      tone: "attn",
      // `loopback` only ever means the probe failed. On a loopback page that
      // is an ordinary "nothing is listening"; anywhere else it also means the
      // address is one this page could never have called.
      detail: pageIsLoopback()
        ? labelFor(target, base, offline)
        : `${base} is loopback — unreachable from this page`,
    },
    down: {
      tone: "attn",
      detail: base ? labelFor(target, base, offline) : "Down",
    },
    unset: { tone: "off", detail: "Not configured" },
  };
  return { ...shell, ...byPlane[status.host], ...probed(target) };
}

export function classifyIdentityConnector(
  status: PlaneStatus,
  target: TargetState,
  offline: boolean,
): ConnectorStatus {
  const base = briefOrigin(status.identityBase);
  const shell = { id: "identity", name: "Identity", required: true } as const;
  if (!base) {
    return {
      ...shell,
      tone: "off",
      detail: "Not configured",
      ...probed(target),
    };
  }
  if (offline) {
    return { ...shell, tone: "offline", detail: "Offline", ...probed(target) };
  }
  const byPlane: Record<
    IdentityPlane,
    { tone: ConnectorTone; detail: string }
  > = {
    connected: { tone: "live", detail: base },
    none: { tone: "attn", detail: "No identity session" },
    down: { tone: "attn", detail: labelFor(target, base, offline) },
  };
  return { ...shell, ...byPlane[status.identity], ...probed(target) };
}

export function classifyMachineConnector(
  target: TargetState,
  daemonApi: string,
  offline: boolean,
): ConnectorStatus {
  const base = briefOrigin(daemonApi);
  const shell = {
    id: "machine",
    name: "This machine",
    required: true,
  } as const;
  if (!daemonApi.trim() || !daemonIsProbable(daemonApi, pageIsLoopback())) {
    return { ...shell, tone: "off", detail: "Not paired", ...probed(target) };
  }
  if (offline) {
    return { ...shell, tone: "offline", detail: "Offline", ...probed(target) };
  }
  if (target.health === "unknown") {
    return {
      ...shell,
      tone: "live",
      detail: `Checking ${base}`,
      ...probed(target),
    };
  }
  if (target.health === "reachable") {
    return { ...shell, tone: "live", detail: base, ...probed(target) };
  }
  return {
    ...shell,
    tone: "attn",
    detail: labelFor(target, base, offline),
    ...probed(target),
  };
}

/**
 * History and keys are the same shape: a capability bound to a catalog
 * connector, which may or may not still need Host to authorize it.
 */
function classifyCapability(
  id: CapabilityId,
  binding: CapabilityConnectorBinding,
): { tone: ConnectorTone; detail: string } {
  const label = connectorLabel(binding.providerId);
  if (capabilityDef(id).requiresAuth(binding.providerId)) {
    if (!binding.connectionId) {
      return { tone: "attn", detail: `${label} not authorized` };
    }
    const remote = binding.remote ? repoHint(binding.remote) : "";
    return { tone: "live", detail: remote ? `${label} · ${remote}` : label };
  }
  return { tone: "live", detail: label };
}

export function classifyHistoryConnector(
  settings: PagesSettings,
): ConnectorStatus {
  const binding = settings.capabilityConnectors?.history ?? {
    providerId: "github",
  };
  const shell = {
    id: "history",
    name: "Git history",
    // The vault already lives on this device. Git is optional persistence,
    // so a missing remote is a connectable off state, not an amber error.
    required: false,
    ...UNPROBED,
  } as const;
  const def = capabilityDef("history");
  if (def.requiresAuth(binding.providerId) && !binding.connectionId) {
    return { ...shell, tone: "off", detail: "Not connected" };
  }
  if (def.requiresAuth(binding.providerId) && !binding.remote) {
    return { ...shell, tone: "off", detail: "No repository selected" };
  }
  return {
    ...shell,
    ...classifyCapability("history", binding),
  };
}

export function classifyKeysConnector(
  settings: PagesSettings,
): ConnectorStatus {
  return {
    id: "keys",
    name: "Key vault",
    // WebCrypto on this device is the built-in default and always satisfies
    // the capability, so there is nothing here a ceremony must repair.
    required: false,
    ...classifyCapability(
      "encryption",
      settings.capabilityConnectors?.encryption ?? { providerId: "webcrypto" },
    ),
    ...UNPROBED,
  };
}

/** Build all five from one monitor reading. Pure, so it is easy to test. */
export function buildConnectors(
  plane: PlaneStatus,
  monitor: MonitorSnapshot,
  settings: PagesSettings,
): ConnectorStatus[] {
  return [
    classifyHostConnector(plane, monitor.host, monitor.offline),
    classifyIdentityConnector(plane, monitor.identity, monitor.offline),
    classifyMachineConnector(
      monitor.machine,
      settings.daemonApi,
      monitor.offline,
    ),
    classifyHistoryConnector(settings),
    classifyKeysConnector(settings),
  ];
}

export function useConnectors(): ConnectorStatus[] {
  const plane = usePlaneStatus();
  const monitor = useConnectivityMonitor();
  // Capability bindings and the daemon address live in settings, and change
  // without any probe result changing.
  useSettingsEpoch();
  return buildConnectors(plane, monitor, loadSettings());
}

/** How many required connectors are asking for something. */
export function needsAttention(connectors: ConnectorStatus[]): number {
  return connectors.filter((c) => c.required && c.tone !== "live").length;
}

/** True when the browser itself has no network, so no endpoint is to blame. */
export function isOfflineSet(connectors: ConnectorStatus[]): boolean {
  return connectors.some((c) => c.tone === "offline");
}
