/** @vitest-environment jsdom */
import { persistentBrowserOwner } from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import type { LiveHost } from "@opensesame/app-core/lib/live/host.js";
import {
  currentGuest,
  leaveLive,
  liveSeams,
} from "@opensesame/app-core/lib/live/session.js";
import { enrollRetiredCredential } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "@opensesame/app-core/lib/retired-credentials/unlock.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearCopiedSecret, useCopySecret } from "../../lib/vault/hooks.js";
import { releaseConnectorOwner } from "../../sections/settings/connector-owner.test-support.js";
import { LiveCatalog } from "./LiveCatalog.js";
import {
  useLiveCatalogClipboard,
  useLiveRequestClipboard,
} from "./live-copy.js";
import {
  ITEM,
  VALUE,
  clipboardFixture,
  connect,
  makeRequest,
} from "./live-copy.test-support.js";

const originalSeams = { ...liveSeams };
const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const owners: LiveHost[] = [];
beforeEach(() => vaultStore.lock());
afterEach(async () => {
  cleanup();
  leaveLive();
  for (const owner of owners.splice(0)) owner.end("owner");
  await releaseConnectorOwner();
  await Promise.resolve();
  Object.assign(liveSeams, originalSeams);
  vi.restoreAllMocks();
  if (originalClipboard)
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});
async function request() {
  const made = await makeRequest();
  owners.push(made.owner);
  return made;
}

it("copies an owner-authorized joined field while the joining device remains locked", async () => {
  const { owner, guest, code } = await request();
  const catalog = await connect(owner, guest, code);
  const memory = clipboardFixture();
  render(
    <LiveCatalog
      guest={guest}
      catalog={catalog}
      request={(what, item, field) => guest.request(what, item, field)}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy GitHub Password" }));
  await waitFor(() => expect(memory.content).toBe(VALUE));
  expect(vaultStore.getSnapshot().status).not.toBe("unlocked");
  expect(await guest.request("copy", ITEM, "not-shared")).toBeNull();
});

it("refuses a retained request copy after the original guest is replaced", async () => {
  const first = await request();
  const memory = clipboardFixture();
  const hook = renderHook(() =>
    useLiveRequestClipboard(first.guest, first.code),
  );
  const old = hook.result.current.copy;
  await act(async () => {
    await request();
  });
  expect(await old(first.code)).toBe("unavailable");
  expect(memory.writes).toEqual([]);
});

it("withholds and cleans a platform write completing after live-session withdrawal", async () => {
  const { guest, code } = await request();
  const memory = clipboardFixture();
  const entered = deferred<void>();
  const held = deferred<void>();
  const write = navigator.clipboard.writeText.bind(navigator.clipboard);
  vi.spyOn(navigator.clipboard, "writeText").mockImplementationOnce(
    async (value) => {
      entered.finish(undefined);
      await held.promise;
      await write(value);
    },
  );
  const hook = renderHook(() => useLiveRequestClipboard(guest, code));
  const work = hook.result.current.copy(code);
  try {
    await entered.promise;
    await act(async () => leaveLive());
    held.finish(undefined);
    expect(await work).toBe("unavailable");
    expect(memory.content).toBe("");
  } finally {
    held.finish(undefined);
    await work;
  }
});

it("clears an already copied code when its genuine guest leaves", async () => {
  const { guest, code } = await request();
  const memory = clipboardFixture();
  const hook = renderHook(() => useLiveRequestClipboard(guest, code));
  expect(await hook.result.current.copy(code)).toBe("copied");
  await act(async () => leaveLive());
  await waitFor(() => expect(memory.content).toBe(""));
});

it("does not clear a newer same-valued vault copy from delayed live cleanup", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const { guest, code } = await request();
  const memory = clipboardFixture();
  const live = renderHook(() => useLiveRequestClipboard(guest, code));
  const vault = renderHook(() => useCopySecret());
  expect(await live.result.current.copy(code)).toBe("copied");
  const entered = deferred<void>();
  const held = deferred<string>();
  vi.spyOn(navigator.clipboard, "readText").mockImplementationOnce(() => {
    entered.finish(undefined);
    return held.promise;
  });
  const end = act(async () => leaveLive());
  try {
    await entered.promise;
    expect(await vault.result.current(code)).toBe("copied");
    held.finish(code);
    await end;
    expect(memory.content).toBe(code);
  } finally {
    held.finish(code);
    await end;
  }
});

it("does not clear a newer same-valued live copy from delayed vault cleanup", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const { guest, code } = await request();
  const memory = clipboardFixture();
  const live = renderHook(() => useLiveRequestClipboard(guest, code));
  const vault = renderHook(() => useCopySecret());
  expect(await vault.result.current(code)).toBe("copied");
  const entered = deferred<void>();
  const held = deferred<string>();
  vi.spyOn(navigator.clipboard, "readText").mockImplementationOnce(() => {
    entered.finish(undefined);
    return held.promise;
  });
  clearCopiedSecret();
  try {
    await entered.promise;
    expect(await live.result.current.copy(code)).toBe("copied");
    held.finish(code);
    await act(async () => {
      await held.promise;
    });
    expect(memory.content).toBe(code);
  } finally {
    held.finish(code);
  }
});

it("retires a real live callback across genuine synthetic entry and fresh owner recovery", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const retired = "controlled-live-retired-fixture";
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: owner.password,
    retiredPassword: retired,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  const { guest, code } = await request();
  const memory = clipboardFixture();
  const hook = renderHook(() => useLiveRequestClipboard(guest, code));
  const old = hook.result.current.copy;
  await act(async () => {
    vaultStore.lock();
    await unlockWithRetiredCredentialGate(vaultStore, retired);
  });
  expect(vaultStore.getSnapshot().decoy).toBe(true);
  expect(await old(code)).toBe("unavailable");
  await act(async () => {
    vaultStore.lock();
    await vaultStore.unlock(owner.password);
  });
  expect(await old(code)).toBe("unavailable");
  expect(memory.writes).toEqual([]);
});

it("withholds a late write after the copy control unmounts while its guest remains current", async () => {
  const { guest, code } = await request();
  const memory = clipboardFixture();
  const entered = deferred<void>();
  const held = deferred<void>();
  const write = navigator.clipboard.writeText.bind(navigator.clipboard);
  vi.spyOn(navigator.clipboard, "writeText").mockImplementationOnce(
    async (value) => {
      entered.finish(undefined);
      await held.promise;
      await write(value);
    },
  );
  const hook = renderHook(() => useLiveRequestClipboard(guest, code));
  const original = hook.result.current.copy;
  const work = original(code);
  try {
    await entered.promise;
    hook.unmount();
    expect(currentGuest()).toBe(guest);
    expect(guest.status.at).toBe("request");
    held.finish(undefined);
    expect(await work).toBe("unavailable");
    expect(memory.content).toBe("");
    const count = memory.writes.length;
    expect(await original(code)).toBe("unavailable");
    expect(memory.writes).toHaveLength(count);
  } finally {
    held.finish(undefined);
    await work;
  }
});

it("does not copy a genuine owner answer arriving after its original catalog row unmounts", async () => {
  const entered = deferred<void>();
  const held = deferred<void>();
  const made = await makeRequest("read", async () => {
    entered.finish(undefined);
    await held.promise;
    return VALUE;
  });
  owners.push(made.owner);
  const { owner, guest, code } = made;
  const catalog = await connect(owner, guest, code);
  const memory = clipboardFixture();
  const shown = render(
    <LiveCatalog
      guest={guest}
      catalog={catalog}
      request={(what, item, field) => guest.request(what, item, field)}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy GitHub Password" }));
  try {
    await entered.promise;
    shown.unmount();
    expect(currentGuest()).toBe(guest);
    held.finish(undefined);
    await act(async () => {
      await held.promise;
    });
    expect(await guest.request("copy", ITEM, "password")).toBe(VALUE);
    expect(memory.writes).toEqual([]);
  } finally {
    held.finish(undefined);
  }
});

it("refuses expired catalog copying and preserves use-policy copy without reveal", async () => {
  const made = await makeRequest("use");
  owners.push(made.owner);
  const { guest, owner, code } = made;
  const catalog = await connect(owner, guest, code);
  expect(await guest.request("reveal", ITEM, "password")).toBeNull();
  expect(await guest.request("copy", ITEM, "password")).toBe(VALUE);
  const memory = clipboardFixture();
  const hook = renderHook(() => useLiveCatalogClipboard(guest, catalog));
  vi.spyOn(Date, "now").mockReturnValue(catalog.expiresAt);
  expect(await hook.result.current.copy(VALUE)).toBe("unavailable");
  expect(memory.writes).toEqual([]);
});

it("retains foreign clipboard data when a retired live write has no ownership witness", async () => {
  const { guest, code } = await request();
  const memory = clipboardFixture();
  const entered = deferred<void>();
  const held = deferred<void>();
  vi.spyOn(navigator.clipboard, "writeText").mockImplementationOnce(
    async () => {
      entered.finish(undefined);
      await held.promise;
      memory.content = "controlled-foreign-clipboard";
    },
  );
  const hook = renderHook(() => useLiveRequestClipboard(guest, code));
  const work = hook.result.current.copy(code);
  try {
    await entered.promise;
    hook.unmount();
    held.finish(undefined);
    expect(await work).toBe("unavailable");
    expect(memory.content).toBe("controlled-foreign-clipboard");
    expect(memory.writes).toEqual([]);
  } finally {
    held.finish(undefined);
    await work;
  }
});

it("withholds a real live write completing after synthetic entry and fresh owner recovery", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const retired = "controlled-live-held-retired-fixture";
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: owner.password,
    retiredPassword: retired,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  const { guest, code } = await request();
  const memory = clipboardFixture();
  const entered = deferred<void>();
  const held = deferred<void>();
  const write = navigator.clipboard.writeText.bind(navigator.clipboard);
  vi.spyOn(navigator.clipboard, "writeText").mockImplementationOnce(
    async (value) => {
      entered.finish(undefined);
      await held.promise;
      await write(value);
    },
  );
  const hook = renderHook(() => useLiveRequestClipboard(guest, code));
  const work = hook.result.current.copy(code);
  try {
    await entered.promise;
    await act(async () => {
      vaultStore.lock();
      await unlockWithRetiredCredentialGate(vaultStore, retired);
      expect(vaultStore.getSnapshot().decoy).toBe(true);
      vaultStore.lock();
      await vaultStore.unlock(owner.password);
    });
    held.finish(undefined);
    expect(await work).toBe("unavailable");
    expect(memory.content).toBe("");
  } finally {
    held.finish(undefined);
    await work;
  }
});
