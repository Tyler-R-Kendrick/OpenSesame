/**
 * The only module under `lib/` that touches `browser.*` (ADR 0199): it
 * implements `BridgePorts` and normalizes a message sender. The relay is
 * registered per switched-on origin, top frame only; the grants it reads back
 * are the browser's own.
 */
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { browser } from "wxt/browser";
import type { SenderFacts } from "./bridge.js";
import type { BridgePorts, KeyValueStore } from "./ports.js";

/** The built relay script, registered at runtime for one origin. */
export const RELAY_SCRIPT = "relay.js";

function keyValue(area: typeof browser.storage.local): KeyValueStore {
  return {
    async get(key) {
      const found = await area.get(key);
      // SAFETY: extension storage values are JSON boundary values.
      const value = found[key] as BoundaryValue;
      return isString(value) ? value : undefined;
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
  };
}

/** The one session rule that takes the `Origin` header off this extension's own requests to granted hosts. */
const BARE_RULE_ID = 1;

const dnr = browser.declarativeNetRequest;

const hostPattern = (host: string) => `https://${host}/*`;
const originPattern = (origin: string) => `${origin}/*`;

export function browserPorts(): BridgePorts {
  return {
    store: keyValue(browser.storage.local),
    asks: keyValue(browser.storage.session),
    extensionId: browser.runtime.id,
    hasHost: (host) =>
      browser.permissions.contains({ origins: [hostPattern(host)] }),
    removeHost: async (host) => {
      await browser.permissions.remove({ origins: [hostPattern(host)] });
    },
    async heldHosts() {
      const all = await browser.permissions.getAll();
      return (all.origins ?? [])
        .map((pattern) => /^https:\/\/([a-z0-9.-]+)\/\*$/.exec(pattern)?.[1])
        .filter((host): host is string => host !== undefined);
    },
    hasOrigin: (origin) =>
      browser.permissions.contains({ origins: [originPattern(origin)] }),
    removeOrigin: async (origin) => {
      await browser.permissions.remove({ origins: [originPattern(origin)] });
    },
    registeredIds: async () =>
      (await browser.scripting.getRegisteredContentScripts()).map(
        (script) => script.id,
      ),
    register: (id, origin) =>
      browser.scripting.registerContentScripts([
        {
          id,
          matches: [originPattern(origin)],
          js: [RELAY_SCRIPT],
          allFrames: false,
          runAt: "document_start",
          persistAcrossSessions: true,
        },
      ]),
    unregister: (id) =>
      browser.scripting.unregisterContentScripts({ ids: [id] }),
    fetch(url, init) {
      const headers = new Headers();
      for (const [name, value] of init.headers) headers.set(name, value);
      return fetch(url, {
        method: init.method,
        headers,
        body: init.body,
        signal: init.signal,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    },
    setBadge: (text) => browser.action.setBadgeText({ text }),
    setBareHosts: (hosts) =>
      dnr.updateSessionRules({
        removeRuleIds: [BARE_RULE_ID],
        addRules: hosts.length
          ? [
              {
                id: BARE_RULE_ID,
                priority: 1,
                action: {
                  type: dnr.RuleActionType.MODIFY_HEADERS,
                  requestHeaders: [
                    { header: "origin", operation: dnr.HeaderOperation.REMOVE },
                  ],
                },
                condition: {
                  requestDomains: [...hosts],
                  initiatorDomains: [browser.runtime.id],
                  resourceTypes: [dnr.ResourceType.XMLHTTPREQUEST],
                },
              },
            ]
          : [],
      }),
  };
}

type BrowserSender = {
  id?: string;
  tab?: { id?: number };
  frameId?: number;
  url?: string;
};

export function senderFacts(sender: BrowserSender): SenderFacts {
  return {
    id: sender.id,
    tabId: sender.tab?.id,
    frameId: sender.frameId,
    url: sender.url,
  };
}
