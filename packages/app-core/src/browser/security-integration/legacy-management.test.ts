/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import {
  LEGACY_CONNECTOR_PUBLIC_KEY,
  LEGACY_CONNECTOR_SECRET_KEY,
} from "../../lib/device-connector-legacy-storage.js";
import { readDeviceSecrets } from "../../lib/device-connector-records.js";
import { kvFlush, kvForgetAll, kvGet, kvSetDurable } from "../../lib/kv.js";
import { vaultStore } from "../../lib/vault/store.js";
import { legacyConnectorPanel } from "../security/legacy-panel.js";
import {
  persistentBrowserOwner,
  persistentManagementBridge,
} from "./management-host.fixture.js";
let bridge: ReturnType<typeof persistentManagementBridge> | undefined;
afterEach(async () => {
  document.body.replaceChildren();
  bridge?.close();
  await bridge?.drain();
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  vi.unstubAllGlobals();
});
it("the shared extension page uses actual worker fresh proof and explicit selected resolution without exposing credentials", async () => {
  const owner = await persistentBrowserOwner();
  const A = "legacy_browser_a";
  const B = "legacy_browser_b";
  const ids = [A, B];
  const stamp = new Date().toISOString();
  await kvSetDurable(
    LEGACY_CONNECTOR_PUBLIC_KEY,
    JSON.stringify(
      ids.map((connectionId) => ({
        connectionId,
        providerId: "anthropic",
        displayName: connectionId,
        scopes: [],
        fields: {},
        createdAt: stamp,
        updatedAt: stamp,
      })),
    ),
  );
  await kvSetDurable(
    LEGACY_CONNECTOR_SECRET_KEY,
    JSON.stringify({
      [A]: { credential: "static-worker-legacy-a" },
      [B]: { credential: "static-worker-legacy-b" },
    }),
  );
  const connected = persistentManagementBridge();
  bridge = connected;
  await expect(connected.client.unlock(owner.password)).resolves.toMatchObject({
    realm: "real",
  });
  const messages: string[] = [];
  document.body.append(
    legacyConnectorPanel(connected.client, (message) => messages.push(message)),
  );
  const password = input("Current vault password for legacy records");
  password.value = owner.password;
  button("Review legacy connector records").click();
  await vi.waitFor(() => expect(input("legacy_browser_a")).toBeTruthy());
  input("legacy_browser_a").click();
  expect(document.body.textContent).not.toContain("static-worker-legacy");
  const before = connected.sent.filter(
    (message) => message.op === "manage",
  ).length;
  button("Resolve selected legacy records").click();
  await connected.drain();
  await vi.waitFor(() => expect(messages.at(-1)).toContain("acknowledge"));
  expect(
    connected.sent.filter((message) => message.op === "manage"),
  ).toHaveLength(before);
  input("I understand original ownership cannot be proven").click();
  await vi.waitFor(() =>
    expect(button("Resolve selected legacy records").disabled).toBe(false),
  );
  password.value = "incorrect-owner-proof";
  button("Resolve selected legacy records").click();
  await connected.drain();
  await vi.waitFor(() =>
    expect(messages.at(-1)).toContain("Owner management failed"),
  );
  expect(kvGet(LEGACY_CONNECTOR_SECRET_KEY)).toContain(
    "static-worker-legacy-a",
  );
  await connected.client.unlock(owner.password);
  await vi.waitFor(() =>
    expect(button("Resolve selected legacy records").disabled).toBe(false),
  );
  password.value = owner.password;
  button("Resolve selected legacy records").click();
  await connected.drain();
  await vi.waitFor(() =>
    expect(messages.at(-1)).toBe(
      "Review up to 16 legacy records at a time; repeat until none remain.",
    ),
  );
  await vi.waitFor(() =>
    expect(
      (document.querySelector("label") &&
        Array.from(document.querySelectorAll("label")).find((node) =>
          node.textContent?.includes("legacy_browser_a"),
        )) ??
        null,
    ).toBeNull(),
  );
  expect(input("legacy_browser_b")).toBeTruthy();
  expect(password).toHaveProperty("value", "");
  expect(document.body.textContent).not.toContain("static-worker-legacy");
  await vaultStore.unlock(owner.password);
  expect(readDeviceSecrets()[A]?.credential).toBe("static-worker-legacy-a");
  expect(readDeviceSecrets()[B]).toBeUndefined();
});

function input(label: string): HTMLInputElement {
  const wrapper = Array.from(document.querySelectorAll("label")).find((node) =>
    node.textContent?.includes(label),
  );
  const field = wrapper?.querySelector("input");
  if (!field) throw new Error(`Missing input ${label}`);
  return field;
}
function button(label: string): HTMLButtonElement {
  const node = Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  );
  if (!node) throw new Error(`Missing button ${label}`);
  return node;
}
