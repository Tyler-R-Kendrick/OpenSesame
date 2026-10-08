import { webcrypto } from "node:crypto";
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { startSecurityPanel } from "@opensesame/app-core/browser/security/bootstrap.js";
import { configureHost } from "@opensesame/app-core/host.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { PERSONAL_TOMB } from "@opensesame/app-core/lib/vfs.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { expect, vi } from "vitest";
import type { backgroundBrowser } from "./background-browser.fixture";

let registeredStart: (() => void) | undefined;
const RETIRED = "retired-background-runtime-public-fixture";

function ownerDom(root: HTMLElement) {
  const pending = new Set<Promise<void>>();
  const observers = new Set<MutationObserver>();
  const find = (label: string) => {
    const button = [...root.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    );
    if (!button) throw new Error(`Missing actual owner action: ${label}`);
    return button;
  };
  function click(label: string) {
    const button = find(label);
    const work = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (button.disabled) return;
        observer.disconnect();
        observers.delete(observer);
        resolve();
      });
      observers.add(observer);
      observer.observe(button, {
        attributes: true,
        attributeFilter: ["disabled"],
      });
      button.click();
    });
    pending.add(work);
    void work.then(() => pending.delete(work));
    return work;
  }
  async function unlock(password: string) {
    const input = root.querySelector('input[type="password"]');
    if (!(input instanceof HTMLInputElement))
      throw new Error("Actual owner input missing");
    input.value = password;
    await click("Unlock vault");
    expect(root.textContent).toContain("Vault open");
  }
  return {
    click,
    unlock,
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    dispose() {
      for (const observer of observers) observer.disconnect();
    },
  };
}

async function closeOwner(
  physical: ReturnType<typeof backgroundBrowser>,
  dom: ReturnType<typeof ownerDom>,
  originalHitTest: PropertyDescriptor | undefined,
) {
  await physical.drain();
  await dom.drain();
  physical.security.close();
  await physical.drain();
  dom.dispose();
  vaultStore.lock();
  await kvFlush();
  document.body.replaceChildren();
  if (originalHitTest)
    Object.defineProperty(document, "elementFromPoint", originalHitTest);
  else Reflect.deleteProperty(document, "elementFromPoint");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
}

export async function backgroundOwner(
  physical: ReturnType<typeof backgroundBrowser>,
  sharedBrowser: Record<string, unknown>,
) {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("CryptoKey", webcrypto.CryptoKey);
  const owner = await persistentBrowserOwner();
  Object.assign(sharedBrowser, physical.browser);
  vi.stubGlobal("browser", sharedBrowser);
  vi.stubGlobal("defineBackground", (start: () => void) => {
    registeredStart = start;
    return { main: start };
  });
  await import("../../entrypoints/background");
  if (!registeredStart)
    throw new Error("WXT did not register the actual entrypoint");
  registeredStart();
  const originalHitTest = Object.getOwnPropertyDescriptor(
    document,
    "elementFromPoint",
  );
  const root = document.createElement("section");
  document.body.append(root);
  const security = startSecurityPanel(
    root,
    physical.security.runtime,
    () => {},
  );
  const dom = ownerDom(root);
  const unlock = (password: string = owner.password) => dom.unlock(password);
  const close = () => closeOwner(physical, dom, originalHitTest);
  try {
    await security.ready;
    await unlock();
    await enrollRetiredCredential({
      tomb: PERSONAL_TOMB,
      currentPassword: owner.password,
      retiredPassword: RETIRED,
      response: "synthetic_decoy",
      acknowledgePasswordVerifierRisk: true,
    });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    owner,
    security,
    root,
    click: dom.click,
    unlock,
    async synthetic() {
      await dom.click("Lock vault");
      await unlock(RETIRED);
      expect(root.textContent).toContain("Example account");
      expect(vaultStore.getSnapshot().guest).toBe(true);
    },
    async recover() {
      await dom.click("Lock vault");
      await unlock();
      await security.requireProduction();
    },
    field() {
      const input = document.createElement("input");
      input.type = "password";
      input.style.opacity = "1";
      document.body.append(input);
      input.getBoundingClientRect = () => new DOMRect(20, 40, 200, 30);
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => input,
      });
      input.focus();
      return input;
    },
    close,
  };
}
