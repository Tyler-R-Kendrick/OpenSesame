// Forgetting a browser node retires its private state before the saved row
// goes: while the device row still shows the node, its credential may still
// exist, but once the row is gone the credential is too.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDeviceRows } from "../device-connector-records.js";
import {
  deferred,
  runtimeFixture,
} from "../secret-backends/runtime.test-support.js";
import * as custody from "../vault-credential-custody.js";
import { vaultStore } from "../vault/store.js";
import {
  forgetBrowserNodeState,
  openBrowserNodeState,
  savedBrowserNodeConfiguration,
} from "./browser-node-store.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.close();
});
function check() {
  if (vaultStore.getSnapshot().status !== "unlocked") throw new Error("locked");
}
const credentials = () =>
  vaultStore.getSnapshot().items.filter((item) => item.kind === "credential");

it("keeps the saved row until the node's credential is discarded", async () => {
  const tomb = vaultStore.getSnapshot().tomb;
  await openBrowserNodeState(
    {
      hostname: "forget-order",
      controlURL: "https://controlplane.tailscale.com",
    },
    tomb,
    check,
  );
  expect(credentials()).toHaveLength(1);
  const discard = custody.discardVaultCredentials;
  const entered = deferred<void>();
  const release = deferred<void>();
  vi.spyOn(custody, "discardVaultCredentials").mockImplementation(
    async (...args) => {
      entered.resolve();
      await release.promise;
      return discard(...args);
    },
  );
  const forgetting = forgetBrowserNodeState(tomb, check);
  await entered.promise;
  expect(savedBrowserNodeConfiguration()).not.toBeNull();
  expect(readDeviceRows()).toHaveLength(1);
  release.resolve();
  await forgetting;
  expect(credentials()).toEqual([]);
  expect(savedBrowserNodeConfiguration()).toBeNull();
  expect(readDeviceRows()).toEqual([]);
});
