/**
 * Core connector status — what the connectivity bar shows.
 *
 * Identity names who is signed in; the key vault is the WebCrypto default
 * on this device. Both are states, so they read as glyphs and are repaired
 * by a ceremony instead of an endpoint form.
 *
 * Nothing here probes. Reachability arrives from the connectivity monitor,
 * which owns the schedule for the whole tab. This file's only job is
 * turning a monitor reading into something a glyph can say.
 */

import { briefOrigin, repoHint } from "@opensesame/os-domain";
import {
  type CapabilityConnectorBinding,
  type CapabilityId,
  capabilityDef,
  connectorLabel,
} from "./capabilities.js";
import type { MonitorSnapshot, TargetState } from "./connectivity-monitor.js";
import type { IdentityPlane, PlaneStatus } from "./planes.js";
import { type FailureClass, failureLabel } from "./probe-failure.js";
import { type PagesSettings, loadSettings } from "./settings.js";

export { briefOrigin, repoHint };

export type ConnectorId = "identity" | "keys";

/**
 * `live` is green with a pip, `attn` is amber with a pip, `off` is a ghosted
 * glyph with no pip, and `offline` is the browser having no network at all.
 *
 * `offline` earns its own tone because the alternative is a lie: with the
 * radio off, every remote connector would go amber and blame an endpoint that
 * is probably fine. One cause, said once, beats two wrong diagnoses.
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
  /** Why it is failing, when we can tell. Null for anything not probed. */
  failure: FailureClass | null;
  /** Epoch ms of the last completed probe; null for settings-derived state. */
  lastCheckedAt: number | null;
  /** A probe is in flight — shown as a pulse, never as a tone change. */
  checking: boolean;
  /** Round trip of the last good probe, in ms. Null when unprobed or failing. */
  rttMs: number | null;
};

/** Bar order, left to right. Also the tile order in Settings. */
export const CONNECTOR_IDS: readonly ConnectorId[] = [
  "identity",
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
): Pick<ConnectorStatus, "failure" | "lastCheckedAt" | "checking" | "rttMs"> {
  return {
    failure: target.failure,
    lastCheckedAt: target.lastCheckedAt,
    checking: target.checking,
    rttMs: target.rttMs,
  };
}

/** Settings-derived connectors are never probed, so they have no freshness. */
const UNPROBED = {
  failure: null,
  lastCheckedAt: null,
  checking: false,
  rttMs: null,
} as const;

export function classifyIdentityConnector(
  status: PlaneStatus,
  target: TargetState,
  offline: boolean,
  /** Settings Identity URL — empty means the plane status is the device. */
  remoteIdentityApi = "",
): ConnectorStatus {
  const shell = { id: "identity", name: "Identity" } as const;
  // No remote URL: Pages is the identity plane whenever the plane status
  // names an issuer. An empty status is still "not configured".
  if (!remoteIdentityApi.trim() && status.identityBase.trim()) {
    if (offline) {
      return {
        ...shell,
        tone: "offline",
        detail: "Offline",
        ...probed(target),
      };
    }
    return {
      ...shell,
      tone: "live",
      detail: "This device",
      ...probed(target),
    };
  }
  const base = briefOrigin(status.identityBase);
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
  const byPlane = {
    connected: { tone: "live", detail: base },
    none: { tone: "attn", detail: "No identity session" },
    down: { tone: "attn", detail: labelFor(target, base, offline) },
  } satisfies Record<IdentityPlane, { tone: ConnectorTone; detail: string }>;
  return { ...shell, ...byPlane[status.identity], ...probed(target) };
}

/**
 * History and keys are the same shape: a capability bound to a catalog
 * connector, which may or may not still need authorization to finish.
 */
type CapabilityClassification = { tone: ConnectorTone; detail: string };

function classifyCapability(
  id: CapabilityId,
  binding: CapabilityConnectorBinding,
): CapabilityClassification {
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

export function classifyKeysConnector(
  settings: PagesSettings,
): ConnectorStatus {
  return {
    id: "keys",
    name: "Key vault",
    // WebCrypto on this device is the built-in default and always satisfies
    // the capability, so there is nothing here a ceremony must repair.
    ...classifyCapability(
      "encryption",
      settings.capabilityConnectors?.encryption ?? { providerId: "webcrypto" },
    ),
    ...UNPROBED,
  };
}

/** Build both from one monitor reading. Pure, so it is easy to test. */
export function buildConnectors(
  plane: PlaneStatus,
  monitor: MonitorSnapshot,
  settings: PagesSettings,
): ConnectorStatus[] {
  return [
    classifyIdentityConnector(
      plane,
      monitor.identity,
      monitor.offline,
      settings.identityApi,
    ),
    classifyKeysConnector(settings),
  ];
}

/**
 * The connectors that are an address somebody typed: Identity when remote.
 * A local vault and the built-in key vault carry no address to break.
 */
const ENDPOINT_CONNECTORS: ReadonlySet<ConnectorId> = new Set(["identity"]);

/**
 * How many connectors are asking for something.
 *
 * Exactly one thing counts: an endpoint that was configured and is not
 * answering. Somebody typed that address, so its silence is a fault worth a
 * number. An endpoint nobody configured is not a fault at all — every plane is
 * optional (ADR 0090), so "nothing connected" is a description of a complete
 * deployment.
 */
export function needsAttention(connectors: ConnectorStatus[]): number {
  return connectors.filter(
    (c) => c.tone === "attn" && ENDPOINT_CONNECTORS.has(c.id),
  ).length;
}

/** True when the browser itself has no network, so no endpoint is to blame. */
export function isOfflineSet(connectors: ConnectorStatus[]): boolean {
  return connectors.some((c) => c.tone === "offline");
}
