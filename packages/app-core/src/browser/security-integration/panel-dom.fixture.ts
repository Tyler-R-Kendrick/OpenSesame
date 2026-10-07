import { afterEach, expect, vi } from "vitest";
import { configureHost } from "../../host.js";
import { kvFlush, kvForgetAll } from "../../lib/kv.js";
import { flushRetiredCredentialTelemetry } from "../../lib/retired-credentials/telemetry-queue.js";
import { vaultStore } from "../../lib/vault/store.js";
import { vfsFlush } from "../../lib/vfs.js";
import { createTestHost } from "../../test-host.js";
import { persistentBrowserOwner } from "./management-host.fixture.js";
import { panelRuntime } from "./panel-runtime.fixture.js";

const bridges: ReturnType<typeof panelRuntime>[] = [];
const disposals: Array<() => void> = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    bridge.close();
    await bridge.drain();
  }
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await flushRetiredCredentialTelemetry();
  for (const dispose of disposals.splice(0)) dispose();
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});
export function onPanelCleanup(dispose: () => void) {
  disposals.push(dispose);
}
export async function ownerPanel() {
  const owner = await persistentBrowserOwner();
  const bridge = panelRuntime();
  bridges.push(bridge);
  await expect(bridge.client.unlock(owner.password)).resolves.toMatchObject({
    realm: "real",
  });
  const messages: string[] = [];
  return { owner, bridge, messages };
}
export function field(label: string): HTMLInputElement {
  const wrapper = Array.from(document.querySelectorAll("label")).find((node) =>
    node.textContent?.includes(label),
  );
  const input = wrapper?.querySelector("input");
  if (!input) throw new Error(`Missing rendered field ${label}`);
  return input;
}
export function button(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  );
  if (!button) throw new Error(`Missing rendered button ${label}`);
  return button;
}
export async function click(label: string) {
  const control = button(label);
  expect(control.disabled).toBe(false);
  const completed = new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      if (control.disabled) return;
      observer.disconnect();
      resolve();
    });
    onPanelCleanup(() => observer.disconnect());
    observer.observe(control, {
      attributes: true,
      attributeFilter: ["disabled"],
    });
  });
  control.click();
  await completed;
}
export function selectFile(file?: Pick<File, "size" | "text">) {
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement))
    throw new Error("Missing pairing file control");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: file ? [file] : [],
  });
  input.dispatchEvent(new Event("change"));
}
