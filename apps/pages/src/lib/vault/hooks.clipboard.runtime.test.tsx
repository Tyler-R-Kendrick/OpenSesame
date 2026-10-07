/** @vitest-environment jsdom */
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "@opensesame/app-core/lib/retired-credentials/unlock.js";
import {
  VaultStore,
  vaultStore,
} from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { releaseConnectorOwner } from "../../sections/settings/connector-owner.test-support.js";
import { clearCopiedSecret, useCopySecret, useSessionGuards } from "./hooks.js";

let password: string;
let content: string;
let writes: string[];
const retired = "controlled-clipboard-retired-fixture";
beforeEach(async () => {
  const owner = await persistentBrowserOwner();
  password = owner.password;
  await vaultStore.unlock(password);
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: password,
    retiredPassword: retired,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  content = "";
  writes = [];
  Object.assign(navigator, {
    clipboard: {
      readText: async () => content,
      writeText: async (value: string) => {
        writes.push(value);
        content = value;
      },
    },
  });
});
afterEach(async () => {
  cleanup();
  await releaseConnectorOwner();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
  return renderHook(() => {
    useSessionGuards();
    return useCopySecret();
  });
}
async function synthetic() {
  await act(async () => {
    vaultStore.lock();
    await unlockWithRetiredCredentialGate(vaultStore, retired);
  });
  expect(vaultStore.getSnapshot().decoy).toBe(true);
}
async function recover() {
  await act(async () => {
    vaultStore.lock();
    await vaultStore.unlock(password);
  });
  expect(vaultStore.getSnapshot().decoy).toBe(false);
}
it("refuses a retained real callback before dispatch in synthetic and fresh owner sessions", async () => {
  const hook = mount();
  const original = hook.result.current;
  await synthetic();
  expect(await original("old-real-secret")).toBe("unavailable");
  expect(writes).toEqual([]);
  expect(await hook.result.current("synthetic-dummy")).toBe("copied");
  await recover();
  const count = writes.length;
  expect(await original("old-real-secret")).toBe("unavailable");
  expect(writes).toHaveLength(count);
  expect(await hook.result.current("fresh-real-secret")).toBe("copied");
  expect(content).toBe("fresh-real-secret");
});
it("clears a held old write after genuine synthetic entry and fresh owner recovery", async () => {
  const hook = mount();
  const held = deferred<void>();
  const entered = deferred<void>();
  const write = navigator.clipboard.writeText.bind(navigator.clipboard);
  vi.spyOn(navigator.clipboard, "writeText").mockImplementationOnce(
    async (value) => {
      entered.finish(undefined);
      await held.promise;
      await write(value);
    },
  );
  const work = hook.result.current("old-real-secret");
  try {
    await entered.promise;
    await synthetic();
    await recover();
    held.finish(undefined);
    expect(await work).toBe("unavailable");
    expect(content).toBe("");
    expect(await hook.result.current("fresh-real-secret")).toBe("copied");
    expect(content).toBe("fresh-real-secret");
  } finally {
    held.finish(undefined);
    await work;
  }
});
it("leaves foreign clipboard content alone after a stale platform write completion", async () => {
  const hook = mount();
  const held = deferred<void>();
  const entered = deferred<void>();
  vi.spyOn(navigator.clipboard, "writeText").mockImplementationOnce(
    async () => {
      entered.finish(undefined);
      await held.promise;
      content = "foreign-content";
    },
  );
  const work = hook.result.current("old-real-secret");
  try {
    await entered.promise;
    await synthetic();
    await recover();
    held.finish(undefined);
    expect(await work).toBe("unavailable");
    expect(content).toBe("foreign-content");
    expect(writes).toEqual([]);
  } finally {
    held.finish(undefined);
    await work;
  }
});
it("does not let a held cleanup read erase a newer same-valued owner copy", async () => {
  const hook = mount();
  expect(await hook.result.current("same-controlled-value")).toBe("copied");
  const held = deferred<string>();
  const entered = deferred<void>();
  vi.spyOn(navigator.clipboard, "readText").mockImplementationOnce(() => {
    entered.finish(undefined);
    return held.promise;
  });
  clearCopiedSecret();
  await entered.promise;
  expect(await hook.result.current("same-controlled-value")).toBe("copied");
  held.finish("same-controlled-value");
  await act(async () => {
    await held.promise;
  });
  expect(content).toBe("same-controlled-value");
  expect(writes).toEqual(["same-controlled-value", "same-controlled-value"]);
});
it("does not erase unknown clipboard ownership when a stale cleanup read is denied", async () => {
  const hook = mount();
  expect(await hook.result.current("controlled-value")).toBe("copied");
  content = "foreign-content";
  vi.spyOn(navigator.clipboard, "readText").mockRejectedValue(
    new Error("denied"),
  );
  clearCopiedSecret();
  await act(async () => {
    await Promise.resolve();
  });
  expect(content).toBe("foreign-content");
  expect(writes).toEqual(["controlled-value"]);
});

it.each(["older-value", "newer-value"])(
  "handles reverse-completed %s without publishing its timer",
  async (older) => {
    const hook = mount();
    const held = deferred<void>();
    const entered = deferred<void>();
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    vi.spyOn(navigator.clipboard, "writeText").mockImplementationOnce(
      async (value) => {
        entered.finish(undefined);
        await held.promise;
        await write(value);
      },
    );
    const first = hook.result.current(older);
    try {
      await entered.promise;
      expect(await hook.result.current("newer-value")).toBe("copied");
      held.finish(undefined);
      expect(await first).toBe("unavailable");
      expect(content).toBe(older === "newer-value" ? "newer-value" : "");
      expect(await hook.result.current("fresh-positive")).toBe("copied");
      expect(content).toBe("fresh-positive");
    } finally {
      held.finish(undefined);
      await first;
    }
  },
);
it("renders safely when another actual store retires the original key's realm", async () => {
  const other = new VaultStore();
  other.rehydrate();
  await other.unlock(password);
  try {
    other.lock();
    await unlockWithRetiredCredentialGate(other, retired);
    expect(other.getSnapshot().decoy).toBe(true);
    expect(vaultStore.getSnapshot().status).toBe("locked");
    const hook = mount();
    expect(await hook.result.current("retired-key-secret")).toBe("unavailable");
    expect(writes).toEqual([]);
  } finally {
    other.lock();
  }
});
