import { webcrypto } from "node:crypto";
import {
  holdGenuineRead,
  persistentBrowserOwner,
  persistentManagementBridge,
} from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { startSecurityPanel } from "@opensesame/app-core/browser/security/bootstrap.js";
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import { configureHost } from "@opensesame/app-core/host.js";
import { kvFileName, kvFlush } from "@opensesame/app-core/lib/kv.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  HEADER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
} from "@opensesame/app-core/lib/vfs.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { popupOperation } from "./operation";
// @vitest-environment jsdom
import { type PanelElements, mountPanel } from "./panel";

function clickAction(action: HTMLButtonElement): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (action.disabled) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(action, {
      attributes: true,
      attributeFilter: ["disabled"],
    });
    action.click();
  });
}

async function fixture() {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("CryptoKey", webcrypto.CryptoKey);
  const owner = await persistentBrowserOwner();
  const bridge = persistentManagementBridge();
  const root = document.createElement("section");
  const security = startSecurityPanel(root, bridge.runtime, () => {});
  function button(label: string) {
    const found = [...root.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    );
    if (!found) throw new Error(`Missing genuine button ${label}`);
    return found;
  }
  async function unlock(password: string) {
    const input = root.querySelector('input[type="password"]');
    if (!(input instanceof HTMLInputElement))
      throw new Error("Missing genuine password field");
    input.value = password;
    const action = button("Unlock vault");
    await clickAction(action);
    expect(root.textContent).toContain("Vault open");
  }
  await security.ready;
  await unlock(owner.password);
  const title = root.querySelector('input[aria-label="Note title"]');
  if (!(title instanceof HTMLInputElement))
    throw new Error("Missing genuine note field");
  title.value = "Original owner fixture";
  await clickAction(button("Add note"));
  const item = vaultStore
    .getSnapshot()
    .items.find(
      (row) =>
        row.name === title.value || row.name === "Original owner fixture",
    );
  if (!item) throw new Error("The actual owner note was not committed.");
  const retired = "retired-autofill-operation-fixture";
  await enrollRetiredCredential({
    tomb: PERSONAL_TOMB,
    currentPassword: owner.password,
    retiredPassword: retired,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  return {
    owner,
    security,
    root,
    async successor() {
      button("Lock vault").click();
      await unlock(retired);
      expect(root.textContent).toContain("Example account");
      expect(
        vaultStore.getSnapshot().items.some((row) => row.id === item.id),
      ).toBe(false);
      button("Lock vault").click();
      await unlock(owner.password);
      expect(
        vaultStore.getSnapshot().items.some((row) => row.id === item.id),
      ).toBe(true);
    },
    async close() {
      bridge.close();
      await bridge.drain();
      vaultStore.lock();
      await kvFlush();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      configureHost(createTestHost());
    },
  };
}

it("does not dispatch an old browser prompt after held authorization crosses synthetic and fresh owner, while current prompts work", async () => {
  const f = await fixture();
  const requested: string[][] = [];
  const transport = {
    sendMessage: async (): Promise<BoundaryValue> => ({ state: "paired" }),
    request: async (origins: readonly string[]) => {
      requested.push([...origins]);
      return true;
    },
  };
  const held = holdGenuineRead(
    f.owner.root,
    kvFileName(tombFileKey(PERSONAL_TOMB, HEADER_PATH)),
  );
  const stale = popupOperation(f.security, transport).request([
    "https://controlled.example/*",
  ]);
  try {
    await held.started;
    await f.successor();
    held.release();
    await stale;
    expect(requested).toEqual([]);
    await expect(
      popupOperation(f.security, transport).request([
        "https://current.example/*",
      ]),
    ).resolves.toBe(true);
    expect(requested).toEqual([["https://current.example/*"]]);
  } finally {
    held.release();
    await Promise.allSettled([stale]);
    await f.close();
  }
}, 20_000);

it("keeps permission and enable on one originating owner, while current operations succeed", async () => {
  const f = await fixture();
  const permission = deferred<boolean>();
  const promptStarted = deferred<void>();
  const messages: string[] = [];
  const transport = {
    sendMessage: async (message: {
      type: string;
      op?: string;
    }): Promise<BoundaryValue> => {
      messages.push(message.op ?? message.type);
      return {
        origin: "https://controlled.example",
        enabled: true,
        references: [],
        passkey: false,
      };
    },
    request: async () => {
      promptStarted.finish();
      return permission.promise;
    },
  };
  const operation = popupOperation(f.security, transport);
  const stale = (async () => {
    if (await operation.request(["https://controlled.example/*"]))
      await operation.enable("https://controlled.example");
  })();
  try {
    await promptStarted.promise;
    await f.successor();
    permission.finish(true);
    await stale;
    expect(messages).toEqual([]);
    await popupOperation(f.security, transport).enable(
      "https://controlled.example",
    );
    expect(messages).toEqual(["enable"]);
  } finally {
    permission.finish(false);
    await Promise.allSettled([stale]);
    await f.close();
  }
}, 20_000);

it("withholds a held predecessor pairing reply while a fresh owner's pairing response is available", async () => {
  const f = await fixture();
  const reply = deferred<BoundaryValue>();
  const dispatched = deferred<void>();
  let held = true;
  const transport = {
    request: async () => true,
    sendMessage: async (): Promise<BoundaryValue> => {
      if (held) {
        dispatched.finish();
        return reply.promise;
      }
      return { state: "pending", code: "CURRENT1" };
    },
  };
  const stale = popupOperation(f.security, transport).pair();
  try {
    await dispatched.promise;
    await f.successor();
    reply.finish({ state: "pending", code: "OLDPAIR1" });
    await expect(stale).resolves.toEqual({ error: "background_unavailable" });
    held = false;
    await expect(popupOperation(f.security, transport).pair()).resolves.toEqual(
      { state: "pending", code: "CURRENT1" },
    );
  } finally {
    reply.finish(null);
    await Promise.allSettled([stale]);
    await f.close();
  }
}, 20_000);

it("withholds mounted predecessor status after genuine synthetic recovery and accepts current status", async () => {
  const f = await fixture();
  const elements: PanelElements = {
    origin: document.createElement("p"),
    site: document.createElement("button"),
    pair: document.createElement("button"),
    code: document.createElement("output"),
    refs: document.createElement("fieldset"),
    go: document.createElement("button"),
    mark: document.createElement("span"),
  };
  const reached = deferred<void>();
  const release = deferred<void>();
  let held = false;
  const panel = await mountPanel(elements, () => {
    const operation = popupOperation(f.security, {
      request: async () => true,
      sendMessage: async () => ({
        origin: "https://controlled.example",
        enabled: true,
        references: ["Controlled/reference"],
        passkey: false,
      }),
    });
    return {
      ...operation,
      status: async () => {
        const answer = await operation.status();
        if (held) {
          reached.finish();
          await release.promise;
        }
        return answer;
      },
    };
  });
  held = true;
  const stale = panel.refresh();
  try {
    await reached.promise;
    await f.successor();
    elements.origin.textContent = "";
    release.finish();
    await stale;
    expect(elements.origin.textContent).toBe("");
    held = false;
    await panel.refresh();
    expect(elements.origin.textContent).toBe("https://controlled.example");
  } finally {
    release.finish();
    await Promise.allSettled([stale]);
    await f.close();
  }
}, 20_000);

it("does not publish a mounted predecessor pairing code after owner recovery", async () => {
  const f = await fixture();
  const els: PanelElements = {
    origin: document.createElement("p"),
    site: document.createElement("button"),
    pair: document.createElement("button"),
    code: document.createElement("output"),
    refs: document.createElement("fieldset"),
    go: document.createElement("button"),
    mark: document.createElement("span"),
  };
  const dispatched = deferred<void>();
  const release = deferred<BoundaryValue>();
  const completed = deferred<void>();
  let held = true;
  let released = false;
  const panel = await mountPanel(els, () => {
    const operation = popupOperation(f.security, {
      request: async () => true,
      sendMessage: async (message) => {
        if ("op" in message)
          return {
            origin: "https://controlled.example",
            enabled: false,
            references: [],
            passkey: false,
          };
        if (held) {
          dispatched.finish();
          return release.promise;
        }
        return { state: "pending", code: "CURRENT1" };
      },
    });
    return {
      ...operation,
      check: () => {
        try {
          operation.check();
        } finally {
          if (released) completed.finish();
        }
      },
    };
  });
  els.pair.click();
  try {
    await dispatched.promise;
    await f.successor();
    panel.invalidate();
    released = true;
    release.finish({ state: "pending", code: "OLDPAIR1" });
    await completed.promise;
    expect(els.code.value).toBe("");
    expect(els.origin.textContent).toBe("");
    const p = popupOperation(f.security, {
      request: async () => true,
      sendMessage: async () => null,
    });
    panel.invalidate();
    els.site.click();
    expect(els.site.hidden).toBe(true);
    p.check();
    held = false;
    await panel.refresh();
    const code = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (els.code.value === "CURR-ENT1") {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(els.code, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    els.pair.click();
    await code;
    expect(els.code.value).toBe("CURR-ENT1");
  } finally {
    released = true;
    release.finish(null);
    await completed.promise;
    await f.close();
  }
}, 20_000);
