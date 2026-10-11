/**
 * What runs INSIDE each person's page in `verify-quorum-browser.mjs`: the real
 * desk (packages/app-core/src/lib/quorum/desk) over the page's own
 * `navigator.credentials`, with in-memory stores. Bundled for the browser by
 * the rig; nothing here is shipped in the app.
 *
 * The page exposes one dispatcher, `__q.run(step, ...args)`, that calls a desk
 * step with this page's ports and answers with plain data, so a Node script can
 * drive five people at once and pass them nothing but packets.
 */

import { isFunction } from "@opensesame/os-domain";
import { webauthnCeremony } from "../../../../packages/app-core/src/lib/quorum/ceremony.ts";
import * as desk from "../../../../packages/app-core/src/lib/quorum/desk/index.ts";

function memoryPending() {
  const map = new Map();
  const copy = (value) => JSON.parse(JSON.stringify(value));
  return {
    read: async (key) => (map.has(key) ? copy(map.get(key)) : undefined),
    write: async (key, value) => {
      map.set(key, copy(value));
    },
    remove: async (key) => {
      map.delete(key);
    },
    list: async (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
  };
}

function memoryRecords() {
  const owned = new Map();
  const held = new Map();
  return {
    owned: async () => [...owned.values()],
    saveOwned: async (record) => {
      owned.set(record.signedPolicy.policy.circleId, record);
    },
    removeOwned: async (id) => {
      owned.delete(id);
    },
    held: async () => [...held.values()],
    saveHeld: async (record) => {
      held.set(record.seat.signedPolicy.policy.circleId, record);
    },
    removeHeld: async (id) => {
      held.delete(id);
    },
  };
}

let skewMs = 0;

const ports = {
  now: () => new Date(Date.now() + skewMs),
  origin: location.origin,
  rpId: location.hostname,
  // The real thing: this page's own credentials container.
  ceremony: webauthnCeremony(navigator.credentials),
  pending: memoryPending(),
  records: memoryRecords(),
  tomb: "tomb",
};

globalThis.__q = {
  /** Move this page's clock forward, to pass a release delay without waiting. */
  skew(ms) {
    skewMs = ms;
  },
  async run(step, ...args) {
    try {
      const fn = desk[step];
      if (!isFunction(fn)) throw new Error(`no such step: ${step}`);
      return { ok: true, value: await fn(ports, ...args) };
    } catch (error) {
      return {
        ok: false,
        name: error?.name ?? "Error",
        code: error?.code ?? null,
        message: String(error?.message ?? error),
      };
    }
  },
};
