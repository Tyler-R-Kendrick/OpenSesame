/**
 * The sites a person switched autofill on for (ADR 0150 §6.4).
 *
 * The companion's manifest declares no content script and no host
 * permission. Switching a site on is the person's click in the popup, which
 * asks the browser for that one host; only once the browser reports the grant
 * does this register the guard for that host with
 * `scripting.registerContentScripts`. Switching it off unregisters the guard
 * and gives the grant back. A site is on only while all three agree — the
 * list here, the browser's grant, and the live registration — so a grant the
 * person took back in the browser's own settings switches the site off.
 *
 * The list holds origins, never a value.
 */
import type { KeyValueStore } from "../fill/daemon";
import { isWebOrigin } from "../fill/guard";
import { storedOrigins } from "../fill/wire";
import { DAEMON_PATTERN, hostPattern } from "./patterns";

export interface SitePorts {
  hasPermission(pattern: string): Promise<boolean>;
  removePermission(pattern: string): Promise<void>;
  registeredIds(): Promise<readonly string[]>;
  /** Register the guard for `pattern`, top frame only, under `id`. */
  register(id: string, pattern: string): Promise<void>;
  unregister(id: string): Promise<void>;
  readonly store: KeyValueStore;
}

export type EnableOutcome =
  | "enabled"
  | "invalid_origin"
  | "permission_not_granted";

/** Where the switched-on origins are kept, in `storage.local`. */
export const SITES_KEY = "fillSites";

/** A registration id per origin: hex, so no origin character reaches it. */
export function scriptId(origin: string): string {
  const hex = [...new TextEncoder().encode(origin)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `fill-guard-${hex}`;
}

export function createSiteRegistry(ports: SitePorts) {
  async function list(): Promise<string[]> {
    const raw = await ports.store.get(SITES_KEY);
    if (raw === undefined) return [];
    let origins: readonly (string | undefined)[];
    try {
      origins = storedOrigins.parse(JSON.parse(raw));
    } catch {
      return [];
    }
    return origins.filter(
      (origin): origin is string => origin !== undefined && isWebOrigin(origin),
    );
  }

  async function save(origins: readonly string[]): Promise<void> {
    await ports.store.set(SITES_KEY, JSON.stringify([...new Set(origins)]));
  }

  async function isEnabled(origin: string): Promise<boolean> {
    const pattern = isWebOrigin(origin) ? hostPattern(origin) : null;
    if (!pattern || !(await list()).includes(origin)) return false;
    if (!(await ports.hasPermission(pattern))) return false;
    return (await ports.registeredIds()).includes(scriptId(origin));
  }

  async function enable(origin: string): Promise<EnableOutcome> {
    const pattern = isWebOrigin(origin) ? hostPattern(origin) : null;
    if (!pattern) return "invalid_origin";
    if (!(await ports.hasPermission(pattern))) return "permission_not_granted";
    const id = scriptId(origin);
    if (!(await ports.registeredIds()).includes(id)) {
      await ports.register(id, pattern);
    }
    await save([...(await list()), origin]);
    return "enabled";
  }

  async function disable(origin: string): Promise<void> {
    const remaining = (await list()).filter((other) => other !== origin);
    await save(remaining);
    if ((await ports.registeredIds()).includes(scriptId(origin))) {
      await ports.unregister(scriptId(origin));
    }
    const pattern = hostPattern(origin);
    const stillNeeded = remaining.some(
      (other) => hostPattern(other) === pattern,
    );
    // The daemon's loopback grant is what every fill travels over; a
    // loopback site switched off never takes it with it.
    if (pattern && !stillNeeded && pattern !== DAEMON_PATTERN) {
      await ports.removePermission(pattern);
    }
  }

  /** Drop every site whose grant or registration is gone. */
  async function reconcile(): Promise<void> {
    for (const origin of await list()) {
      if (!(await isEnabled(origin))) await disable(origin);
    }
  }

  return { list, isEnabled, enable, disable, reconcile };
}

export type SiteRegistry = ReturnType<typeof createSiteRegistry>;
