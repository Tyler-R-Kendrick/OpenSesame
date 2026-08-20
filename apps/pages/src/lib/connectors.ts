/**
 * Core connector status — what the connectivity bar shows.
 *
 * Five things have to be true before OpenSesame can authorize anything: the
 * Host and Identity planes answer, this machine's daemon is paired, encrypted
 * history has a git remote, and a key vault is bound. Settings used to state
 * all five as endpoint forms; they are states, so they read as glyphs and are
 * repaired by a ceremony instead.
 *
 * Everything here is derived. Host and Identity come from `usePlaneStatus`,
 * history and keys from the persisted capability bindings, and only the daemon
 * needs a probe of its own — the plane status never had one.
 */

import { useEffect, useState } from "react";
import {
  type CapabilityConnectorBinding,
  type CapabilityId,
  capabilityDef,
  connectorLabel,
} from "./capabilities.js";
import { probeDaemon } from "./daemon.js";
import {
  type HostPlane,
  type IdentityPlane,
  type PlaneStatus,
  usePlaneStatus,
} from "./planes.js";
import {
  type PagesSettings,
  loadSettings,
  pageIsLoopback,
  subscribeSettings,
} from "./settings.js";
import { isLoopbackUrl, normalizeTailnetBase } from "./urls.js";

export type ConnectorId = "host" | "identity" | "machine" | "history" | "keys";

/**
 * Three states, because a status glyph can only carry three:
 * `live` is green with a pip, `attn` is amber with a pip, `off` is a ghosted
 * glyph with no pip at all. A probe still in flight reads `live` rather than
 * flashing amber on every route remount — same call `RailPlaneStatus` made.
 */
export type ConnectorTone = "live" | "attn" | "off";

export type ConnectorStatus = {
  id: ConnectorId;
  /** Short name, used in the tile and the glyph's accessible name. */
  name: string;
  tone: ConnectorTone;
  /** One line of truth: an origin, a principal, or what is missing. */
  detail: string;
  /** Required connectors are the ones a ceremony can be blocked on. */
  required: boolean;
};

/** Bar order, left to right. Also the tile order in Settings. */
export const CONNECTOR_IDS: readonly ConnectorId[] = [
  "host",
  "identity",
  "machine",
  "history",
  "keys",
] as const;

/** Origins are long and the glyph row is not; show host:port where we can. */
export function briefOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return `${url.host}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return trimmed;
  }
}

export function classifyHostConnector(status: PlaneStatus): ConnectorStatus {
  const base = briefOrigin(status.hostBase);
  const byPlane: Record<HostPlane, { tone: ConnectorTone; detail: string }> = {
    live: { tone: "live", detail: base },
    pending: { tone: "live", detail: base ? `Checking ${base}` : "Checking" },
    loopback: {
      tone: "attn",
      // `loopback` only ever means the probe failed. On a loopback page that
      // is an ordinary "nothing is listening"; anywhere else it also means the
      // address is one this page could never have called.
      detail: pageIsLoopback()
        ? `Unreachable · ${base}`
        : `${base} is loopback — unreachable from this page`,
    },
    down: { tone: "attn", detail: base ? `Unreachable · ${base}` : "Down" },
    unset: { tone: "off", detail: "Not configured" },
  };
  return { id: "host", name: "Host", required: true, ...byPlane[status.host] };
}

export function classifyIdentityConnector(
  status: PlaneStatus,
): ConnectorStatus {
  const base = briefOrigin(status.identityBase);
  if (!base) {
    return {
      id: "identity",
      name: "Identity",
      required: true,
      tone: "off",
      detail: "Not configured",
    };
  }
  const byPlane: Record<
    IdentityPlane,
    { tone: ConnectorTone; detail: string }
  > = {
    connected: { tone: "live", detail: base },
    none: { tone: "attn", detail: "No identity session" },
    down: { tone: "attn", detail: `Unreachable · ${base}` },
  };
  return {
    id: "identity",
    name: "Identity",
    required: true,
    ...byPlane[status.identity],
  };
}

export type DaemonReach = "unset" | "checking" | "paired" | "unreachable";

export function classifyMachineConnector(
  reach: DaemonReach,
  daemonApi: string,
): ConnectorStatus {
  const base = briefOrigin(daemonApi);
  const byReach: Record<DaemonReach, { tone: ConnectorTone; detail: string }> =
    {
      unset: { tone: "off", detail: "Not paired" },
      checking: {
        tone: "live",
        detail: base ? `Checking ${base}` : "Checking",
      },
      paired: { tone: "live", detail: base },
      unreachable: { tone: "attn", detail: `No answer from ${base}` },
    };
  return {
    id: "machine",
    name: "This machine",
    required: true,
    ...byReach[reach],
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

/** `https://github.com/org/store.git` reads as `org/store` in a status line. */
export function repoHint(remote: string): string {
  const trimmed = remote.trim().replace(/\.git$/, "");
  if (!trimmed) return "";
  try {
    const path = new URL(trimmed).pathname.replace(/^\/+/, "");
    return path || trimmed;
  } catch {
    return trimmed;
  }
}

export function classifyHistoryConnector(
  settings: PagesSettings,
): ConnectorStatus {
  return {
    id: "history",
    name: "Git history",
    required: true,
    ...classifyCapability("history", settings.capabilityConnectors.history),
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
      settings.capabilityConnectors.encryption,
    ),
  };
}

/**
 * Whether this page may even try `${daemonApi}/health`.
 *
 * github.io cannot call 127.0.0.1, and probing it anyway costs a console error
 * and a mixed-content warning on every mount. `assertDaemonReachableFromPage`
 * makes the same judgement for the pairing path; this is the read-only half.
 */
export function daemonIsProbable(daemonApi: string): boolean {
  const base = normalizeTailnetBase(daemonApi);
  if (!base) return false;
  return pageIsLoopback() || !isLoopbackUrl(base);
}

/** Probe the paired daemon, re-probing whenever Settings change the address. */
export function useDaemonReach(): { reach: DaemonReach; daemonApi: string } {
  const [daemonApi, setDaemonApi] = useState(() => loadSettings().daemonApi);
  const [reach, setReach] = useState<DaemonReach>("checking");

  useEffect(
    () => subscribeSettings(() => setDaemonApi(loadSettings().daemonApi)),
    [],
  );

  useEffect(() => {
    if (!daemonApi.trim() || !daemonIsProbable(daemonApi)) {
      setReach("unset");
      return;
    }
    let cancelled = false;
    setReach("checking");
    void probeDaemon(daemonApi).then(
      () => {
        if (!cancelled) setReach("paired");
      },
      () => {
        if (!cancelled) setReach("unreachable");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [daemonApi]);

  return { reach, daemonApi };
}

export function useConnectors(): ConnectorStatus[] {
  const plane = usePlaneStatus();
  const { reach, daemonApi } = useDaemonReach();
  const [settings, setSettings] = useState<PagesSettings>(() => loadSettings());

  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), []);

  return [
    classifyHostConnector(plane),
    classifyIdentityConnector(plane),
    classifyMachineConnector(reach, daemonApi),
    classifyHistoryConnector(settings),
    classifyKeysConnector(settings),
  ];
}

/** How many required connectors are asking for something. */
export function needsAttention(connectors: ConnectorStatus[]): number {
  return connectors.filter((c) => c.required && c.tone !== "live").length;
}
