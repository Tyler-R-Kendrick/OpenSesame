/**
 * The origins a person switched the bridge on for (ADR 0199): the Pages app,
 * wherever it is served. The manifest declares no content script and no host
 * permission. Switching an origin on is the person's click in the popup, which
 * asks the browser for that one origin; only once the browser reports the
 * grant does this register the relay for it with `scripting.registerContentScripts`.
 * Switching it off unregisters the relay and gives the grant back. An origin is
 * on only while the list here, the browser's grant and the live registration
 * all agree.
 */
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import type { BridgePorts } from "./ports.js";

export const SITES_KEY = "bridgeSites";

/** An origin a page can be served from: HTTPS anywhere, or plain HTTP only on this machine. */
export function webOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    return null;
  if (url.username || url.password) return null;
  return url.origin;
}

/** A registration id per origin: hex, so no origin character reaches it. */
export function relayId(origin: string): string {
  const hex = [...new TextEncoder().encode(origin)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `relay-${hex}`;
}

export type EnableOutcome =
  | "enabled"
  | "invalid_origin"
  | "permission_not_granted";

export function createSiteRegistry(ports: BridgePorts) {
  async function list(): Promise<string[]> {
    const raw = await ports.store.get(SITES_KEY);
    if (raw === undefined) return [];
    try {
      const parsed: BoundaryValue = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((entry) => (isString(entry) ? webOrigin(entry) : null))
        .filter((origin): origin is string => origin !== null);
    } catch {
      return [];
    }
  }

  async function save(origins: readonly string[]): Promise<void> {
    await ports.store.set(SITES_KEY, JSON.stringify([...new Set(origins)]));
  }

  async function isEnabled(origin: string): Promise<boolean> {
    if (!webOrigin(origin) || !(await list()).includes(origin)) return false;
    if (!(await ports.hasOrigin(origin))) return false;
    return (await ports.registeredIds()).includes(relayId(origin));
  }

  async function enable(requested: string): Promise<EnableOutcome> {
    const origin = webOrigin(requested);
    if (!origin) return "invalid_origin";
    if (!(await ports.hasOrigin(origin))) return "permission_not_granted";
    const id = relayId(origin);
    if (!(await ports.registeredIds()).includes(id))
      await ports.register(id, origin);
    await save([...(await list()), origin]);
    return "enabled";
  }

  async function disable(origin: string): Promise<void> {
    await save((await list()).filter((other) => other !== origin));
    if ((await ports.registeredIds()).includes(relayId(origin)))
      await ports.unregister(relayId(origin));
    if (await ports.hasOrigin(origin)) await ports.removeOrigin(origin);
  }

  /** Drop every origin whose grant or registration is gone. */
  async function reconcile(): Promise<void> {
    for (const origin of await list())
      if (!(await isEnabled(origin))) await disable(origin);
  }

  return { list, isEnabled, enable, disable, reconcile };
}

export type SiteRegistry = ReturnType<typeof createSiteRegistry>;
