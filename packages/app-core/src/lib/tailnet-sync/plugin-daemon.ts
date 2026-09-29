/**
 * The daemon a person paired over the tailnet (ADR 0144), as the port the
 * plugin capabilities ask about their plugins (ADR 0150 §7).
 *
 * It is the tailnet capability's own pairing, reused: the address a pasted
 * code named — a tailnet name or this machine, never the open internet — and
 * the key sealed with the vault. The key goes in one header, on one request,
 * to that address and nowhere else; it is never in a URL, never returned,
 * never logged. Every request goes through the capability's egress port, so
 * a revoked plan, an undeclared destination or a redirect is refused before
 * a socket opens.
 *
 * With nothing paired, a guest, or the vault locked, there is no daemon and
 * nothing is sent.
 */

import type { CapabilityId } from "@opensesame/capability-composition";
import { PLUGIN_DAEMON_PURPOSE } from "../capabilities/catalog-optional-plugins.js";
import type { EgressPort } from "../capabilities/runtime-contract.js";
import type {
  PluginDaemon,
  PluginDaemonRequest,
  PluginDaemonTarget,
} from "../plugins/client.js";
import { PluginError } from "../plugins/client.js";
import { pairedDrive, subscribeTailnetSync } from "./observer.js";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Seams a test replaces: where the pairing comes from, and who says it moved. */
export const pluginDaemonSeams = {
  pairing: pairedDrive,
  subscribe: subscribeTailnetSync,
};

export function tailnetPluginDaemon(
  egress: EgressPort,
  capability: CapabilityId,
): PluginDaemon {
  return {
    subscribe: (listener) => pluginDaemonSeams.subscribe(listener),
    target(): PluginDaemonTarget | null {
      const drive = pluginDaemonSeams.pairing();
      return drive ? { label: drive.label, host: hostOf(drive.url) } : null;
    },
    async request(path: string, init: PluginDaemonRequest): Promise<Response> {
      const drive = pluginDaemonSeams.pairing();
      if (!drive) throw new PluginError("no-daemon");
      const headers = new Headers({ Authorization: `Bearer ${drive.key}` });
      if (init.body !== undefined)
        headers.set("Content-Type", "application/json");
      return egress.fetch(
        `${drive.url}${path}`,
        {
          method: init.method,
          headers,
          body: init.body,
          credentials: "omit",
          cache: "no-store",
          signal: init.signal,
        },
        { capability, purpose: PLUGIN_DAEMON_PURPOSE },
      );
    },
  };
}
