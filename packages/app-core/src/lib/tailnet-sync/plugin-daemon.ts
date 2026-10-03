/**
 * The daemon a person paired this page with for plugin settings (ADR 0150 §7),
 * as the port the plugin capabilities ask about their plugins.
 *
 * A person runs `opensesame plugins pair --origin <this page's origin>` on
 * the daemon's machine and pastes the code it prints. The page trades that
 * code, once, for a key the daemon bound to this origin and to the plugin
 * routes alone, and seals the key in the open vault (`plugin-pairing.ts`).
 * The address is a tailnet name or this machine, never the open internet.
 *
 * The key goes in one header, on one request, to that address and nowhere
 * else; it is never in a URL, never returned, never logged. Every request
 * goes through the capability's egress port, so a revoked plan, an
 * undeclared destination or a redirect is refused before a socket opens.
 * With nothing paired, a guest, or the vault locked, there is no daemon and
 * nothing is sent.
 */

import type { CapabilityId } from "@opensesame/capability-composition";
import { isJsonObject, isString } from "@opensesame/os-domain";
import { pageOrigin } from "../../ports.js";
import { readBoundedObject } from "../bounded-response.js";
import { PLUGIN_DAEMON_PURPOSE } from "../capabilities/catalog-optional-plugins.js";
import type { EgressPort } from "../capabilities/runtime-contract.js";
import { localNetworkFetchSeams } from "../local-network-fetch.js";
import type {
  PluginDaemon,
  PluginDaemonRequest,
  PluginDaemonTarget,
} from "../plugins/client.js";
import { PluginError } from "../plugins/client.js";
import {
  currentPluginPairing,
  dropPluginPairing,
  keepPluginPairing,
  pluginPairingPossible,
  subscribePluginPairing,
} from "./plugin-daemon-store.js";
import {
  PLUGIN_PAIRING_EXCHANGE_PATH,
  type PluginDaemonPairing,
  SECRET,
  parsePluginPairingCode,
} from "./plugin-pairing.js";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Seams a test replaces: the stored pairing, who says it moved, this page. */
export const pluginDaemonSeams = {
  pairing: currentPluginPairing,
  subscribe: subscribePluginPairing,
  /** An open vault to seal the key in, on a deployment that may hold local authority. */
  possible: (): boolean =>
    pluginPairingPossible() && localNetworkFetchSeams.eligible(),
  keep: keepPluginPairing,
  drop: dropPluginPairing,
  pageOrigin: (): string => pageOrigin(),
};

const EXCHANGE_BYTES = 4096;
const EXCHANGE_MS = 8000;

/** The daemon's answer to a traded code: a key for exactly this origin. */
async function issuedToken(
  response: Response,
  origin: string,
): Promise<string> {
  if (response.status === 403 || response.status === 429)
    throw new PluginError("pairing-refused");
  if (!response.ok) throw new PluginError("refused");
  const body = await readBoundedObject(
    response,
    EXCHANGE_BYTES,
    EXCHANGE_MS,
  ).catch(() => null);
  if (!isJsonObject(body)) throw new PluginError("malformed");
  const { token } = body;
  if (!isString(token) || !SECRET.test(token) || body.origin !== origin)
    throw new PluginError("malformed");
  return token;
}

export function tailnetPluginDaemon(
  egress: EgressPort,
  capability: CapabilityId,
): PluginDaemon {
  const meta = { capability, purpose: PLUGIN_DAEMON_PURPOSE };

  function send(
    pairing: Pick<PluginDaemonPairing, "url">,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    return egress.fetch(
      `${pairing.url}${path}`,
      { ...init, credentials: "omit", cache: "no-store" },
      meta,
    );
  }

  return {
    subscribe: (listener) => pluginDaemonSeams.subscribe(listener),
    target(): PluginDaemonTarget | null {
      const pairing = pluginDaemonSeams.pairing();
      return pairing
        ? { label: pairing.label, host: hostOf(pairing.url) }
        : null;
    },
    canPair: () => pluginDaemonSeams.possible(),
    async request(path: string, init: PluginDaemonRequest): Promise<Response> {
      const pairing = pluginDaemonSeams.pairing();
      if (!pairing) throw new PluginError("no-daemon");
      const headers = new Headers({ Authorization: `Bearer ${pairing.token}` });
      if (init.body !== undefined)
        headers.set("Content-Type", "application/json");
      return send(pairing, path, {
        method: init.method,
        headers,
        body: init.body,
        signal: init.signal,
      });
    },
    async pair(raw: string, signal: AbortSignal): Promise<void> {
      const parsed = parsePluginPairingCode(raw);
      if (!parsed) throw new PluginError("not-a-code");
      if (parsed.origin !== pluginDaemonSeams.pageOrigin())
        throw new PluginError("other-origin");
      if (!pluginDaemonSeams.possible()) throw new PluginError("locked");
      const response = await send(parsed, PLUGIN_PAIRING_EXCHANGE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: parsed.code }),
        signal,
      }).catch(() => {
        throw new PluginError("unreachable");
      });
      const token = await issuedToken(response, parsed.origin);
      const { url, origin, label } = parsed;
      await pluginDaemonSeams.keep({ url, token, origin, label }).catch(() => {
        throw new PluginError("locked");
      });
    },
    async forget(signal: AbortSignal): Promise<void> {
      const pairing = pluginDaemonSeams.pairing();
      if (!pairing) return;
      // The daemon drops the key when it answers; the page forgets it either way.
      await send(pairing, PLUGIN_PAIRING_EXCHANGE_PATH, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${pairing.token}` },
        signal,
      }).catch(() => null);
      await pluginDaemonSeams.drop();
    },
  };
}
