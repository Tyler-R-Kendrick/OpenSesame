import { webcrypto } from "node:crypto";
// Pure definitions preload; actual popup entry starts only after DOM/runtime setup.
import "@opensesame/app-core/browser/security/bootstrap.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  persistentBrowserOwner,
  persistentManagementBridge,
} from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { configureHost } from "@opensesame/app-core/host.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { useClientAtRestKeys } from "@opensesame/browser-at-rest";
import { expect, vi } from "vitest";
import { clickSecurityAction } from "./test-support/security-action";

export function signal<T>() {
  let finish: (value: T) => void = () => {
    throw new Error("Signal not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}
const observations = new Set<MutationObserver>();
export function rendered(condition: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!condition()) return;
      observer.disconnect();
      observations.delete(observer);
      resolve();
    });
    observations.add(observer);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
    if (condition()) {
      observer.disconnect();
      observations.delete(observer);
      resolve();
    }
  });
}
export function node<T extends HTMLElement>(id: string, type: new () => T): T {
  const value = document.getElementById(id);
  if (!(value instanceof type))
    throw new Error(`Missing actual popup control ${id}`);
  return value;
}
export function button(name: string): HTMLButtonElement {
  const value = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === name,
  );
  if (!value) throw new Error(`Missing actual popup button ${name}`);
  return value;
}
export async function hintAfter(
  buttonValue: HTMLButtonElement,
  expected: string,
) {
  const hint = node("hint", HTMLParagraphElement);
  const finished = new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      if (hint.textContent !== expected || hint.hidden) return;
      observer.disconnect();
      observations.delete(observer);
      resolve();
    });
    observations.add(observer);
    // Observe only a new mutation of this actual result element. The prior
    // same-text error or an unrelated Security-panel render cannot finish it.
    observer.observe(hint, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    buttonValue.click();
  });
  await finished;
  expect(hint.hidden).toBe(false);
}
interface PopupTransport {
  response: {
    health?: { ok?: boolean };
    daemon?: { available?: boolean };
    cursor?: { deviceId?: string; epoch?: number };
    hostBase?: string;
    error?: string;
  };
  reject: Error | string | undefined;
  storageFailure: boolean;
}
function wireBrowser(bridge: ReturnType<typeof persistentManagementBridge>) {
  const rows = new Map<string, string>();
  const gets: string[] = [];
  const writes: { hostApiBase: string }[] = [];
  const opened: string[] = [];
  const requests: { type: string; securityPermit?: string }[] = [];
  const pending = new Set<Promise<unknown>>();
  const transport: PopupTransport = {
    response: {
      health: { ok: true },
      daemon: { available: true },
      cursor: { deviceId: "public-device", epoch: 4 },
    },
    reject: undefined,
    storageFailure: false,
  };
  let optionsOpened = 0;
  const optionsCalled = signal<void>();
  const tabCreated = signal<string>();
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: (name: string) =>
          track(
            (async () => {
              gets.push(name);
              if (transport.storageFailure)
                throw new Error("Controlled physical storage read failure");
              return Object.fromEntries(
                [...rows].filter(([keyName]) => keyName === name),
              );
            })(),
          ),
        set: (value: { hostApiBase: string }) =>
          track(
            (async () => {
              writes.push(value);
              rows.set("hostApiBase", value.hostApiBase);
            })(),
          ),
      },
    },
    runtime: {
      ...bridge.runtime,
      // This doubles delivery of public health metadata only. Owner permits and
      // authorization come exclusively from the production panel/broker above.
      sendMessage: (request: { type: string; securityPermit?: string }) =>
        track(
          (async () => {
            requests.push(request);
            if (transport.reject !== undefined) {
              const error = transport.reject;
              transport.reject = undefined;
              throw error;
            }
            return transport.response;
          })(),
        ),
      openOptionsPage: async () => {
        optionsOpened += 1;
        optionsCalled.finish();
      },
    },
    tabs: {
      create: async ({ url }: { url: string }) => {
        opened.push(url);
        tabCreated.finish(url);
      },
    },
  });
  return {
    rows,
    gets,
    writes,
    opened,
    requests,
    transport,
    pending,
    optionsOpened: () => optionsOpened,
    optionsCalled,
    tabCreated,
  };
}
export async function popupFixture() {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("CryptoKey", webcrypto.CryptoKey);
  const owner = await persistentBrowserOwner();
  const bridge = persistentManagementBridge();
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  useClientAtRestKeys(() => Promise.resolve(key));
  const {
    rows,
    gets,
    writes,
    opened,
    requests,
    transport,
    pending,
    optionsOpened,
    optionsCalled,
    tabCreated,
  } = wireBrowser(bridge);
  const html = new DOMParser().parseFromString(
    readFileSync(join(__dirname, "../entrypoints/popup/index.html"), "utf8"),
    "text/html",
  );
  document.replaceChild(
    document.importNode(html.documentElement, true),
    document.documentElement,
  );
  // Import the real entrypoint only after genuine owner/runtime/DOM setup.
  await import("../entrypoints/popup/main");
  await rendered(
    () => document.querySelector('#security input[type="password"]') !== null,
  );
  const lock = async () => {
    const control = [...document.querySelectorAll("#security button")].find(
      (b) => b.textContent === "Lock vault",
    );
    if (control instanceof HTMLButtonElement)
      await clickSecurityAction(control);
    await bridge.drain();
    expect(node("production-controls", HTMLDivElement).hidden).toBe(true);
  };
  const unlock = async (password: string = owner.password) => {
    const requestCount = requests.length;
    const input = document.querySelector('#security input[type="password"]');
    if (!(input instanceof HTMLInputElement))
      throw new Error("Missing genuine owner password input");
    input.value = password;
    await clickSecurityAction(button("Unlock vault"));
    expect(document.querySelector("#security")?.textContent).toContain(
      "Vault open",
    );
    if (!vaultStore.getSnapshot().guest)
      await rendered(
        () =>
          requests.length > requestCount &&
          node("status", HTMLUListElement).textContent !== "Checking…",
      );
  };
  return {
    owner,
    bridge,
    key,
    rows,
    gets,
    writes,
    opened,
    requests,
    transport,
    lock,
    unlock,
    optionsOpened,
    optionsCalled: optionsCalled.promise,
    tabCreated: tabCreated.promise,
    async drain() {
      await bridge.drain();
      while (pending.size) await Promise.allSettled([...pending]);
    },
    async close() {
      bridge.close();
      await bridge.drain();
      while (pending.size) await Promise.allSettled([...pending]);
      vaultStore.lock();
      await kvFlush();
      for (const observer of observations) observer.disconnect();
      observations.clear();
      useClientAtRestKeys(() => Promise.reject(new Error("Fixture closed")));
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      configureHost(createTestHost());
    },
  };
}
