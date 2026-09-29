/**
 * The companion's ports, bound to the real extension APIs. Everything with a
 * decision in it lives in `service.ts` and `lib/sites`; this file only
 * translates, and decodes whatever the browser hands back (`wire.ts`).
 *
 * - The guard is registered per switched-on site with
 *   `scripting.registerContentScripts`, top frame only, and injected with
 *   `executeScript` only as a fallback into a tab that loaded before its site
 *   was switched on — which the site's own host grant permits.
 * - Messages to the guard go to frame 0 only.
 * - The pairing token lives in `storage.local`; a person's per-origin choice
 *   of entry lives in `storage.session` and is a reference, never a value.
 */
import { browser } from "wxt/browser";
import { type SitePorts, createSiteRegistry } from "../sites/sites";
import { type KeyValueStore, createDaemonClient, pairingToken } from "./daemon";
import type { FillPorts, RuntimeSender } from "./ports";
import { GUARD_SCRIPT, type Outcome } from "./protocol";
import { guardReply, storedString } from "./wire";

function keyValue(area: typeof browser.storage.local): KeyValueStore {
  return {
    get: async (key) => storedString.parse((await area.get(key))[key]),
    set: (key, value) => area.set({ [key]: value }),
  };
}

/** A per-process map where `storage.session` is missing (Firefox < 115). */
function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
  };
}

/** The browser's grants and the runtime registrations, for `lib/sites`. */
export function browserSitePorts(): SitePorts {
  return {
    hasPermission: (pattern) =>
      browser.permissions.contains({ origins: [pattern] }),
    removePermission: async (pattern) => {
      await browser.permissions.remove({ origins: [pattern] });
    },
    registeredIds: async () =>
      (await browser.scripting.getRegisteredContentScripts()).map((s) => s.id),
    register: (id, pattern) =>
      browser.scripting.registerContentScripts([
        {
          id,
          matches: [pattern],
          js: [GUARD_SCRIPT],
          allFrames: false,
          runAt: "document_idle",
          persistAcrossSessions: true,
        },
      ]),
    unregister: (id) =>
      browser.scripting.unregisterContentScripts({ ids: [id] }),
    store: keyValue(browser.storage.local),
  };
}

export function browserFillPorts(): FillPorts {
  const local = keyValue(browser.storage.local);
  const session = browser.storage.session
    ? keyValue(browser.storage.session)
    : memoryStore();
  const random = (bytes: Uint8Array) => crypto.getRandomValues(bytes);
  return {
    ownId: browser.runtime.id,
    ownBase: browser.runtime.getURL("/"),
    async activeTab() {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      return tab?.id === undefined ? null : { id: tab.id, url: tab.url };
    },
    async inject(tabId) {
      await browser.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: [GUARD_SCRIPT],
      });
    },
    send: async (tabId, message) => {
      const reply = guardReply.safeParse(
        await browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
      );
      return reply.success ? reply.data : { outcome: "guard_unavailable" };
    },
    sites: createSiteRegistry(browserSitePorts()),
    daemon: createDaemonClient({ token: () => pairingToken(local, random) }),
    choices: session,
    now: () => Date.now(),
    nonce: () => crypto.randomUUID(),
  };
}

/** The fields of the browser's `MessageSender` the background reads. */
export interface BrowserSender {
  readonly id?: string;
  readonly tab?: { readonly id?: number };
  readonly frameId?: number;
  readonly origin?: string;
  readonly url?: string;
}

/** What the browser says about a message's sender, and nothing the page says. */
export function runtimeSender(sender: BrowserSender): RuntimeSender {
  return {
    id: sender.id,
    tab: sender.tab ? { id: sender.tab.id } : undefined,
    frameId: sender.frameId,
    origin: sender.origin,
    url: sender.url,
  };
}

/** Show a command's outcome on the toolbar: nothing when filled, `!` when not. */
export async function signalOutcome(outcome: Outcome): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  const filled = outcome === "filled";
  await browser.action.setBadgeText({ tabId: tab.id, text: filled ? "" : "!" });
  await browser.action.setTitle({
    tabId: tab.id,
    title: filled
      ? "OpenSesame autofill"
      : `OpenSesame autofill: ${outcome.replaceAll("_", " ")}`,
  });
}
