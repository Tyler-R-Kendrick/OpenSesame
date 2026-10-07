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
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { releaseConnectorOwner } from "../../sections/settings/connector-owner.test-support.js";
import { LiveCatalog } from "./LiveCatalog.js";
import { EditableRow } from "./LiveFieldEdit.js";
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
afterEach(async () => {
  cleanup();
  leaveLive();
  for (const owner of owners.splice(0)) owner.end("owner");
  await releaseConnectorOwner();
  await Promise.resolve();
  Object.assign(liveSeams, originalSeams);
  if (originalClipboard)
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});
async function request() {
  const made = await makeRequest();
  owners.push(made.owner);
  return made;
}

it("does not reveal an already answered original request after its guest is replaced", async () => {
  const { owner, guest, code } = await request();
  const catalog = await connect(owner, guest, code);
  const entered = deferred<void>();
  const held = deferred<void>();
  render(
    <LiveCatalog
      guest={guest}
      catalog={catalog}
      request={async (what, item, field) => {
        const value = await guest.request(what, item, field);
        expect(value).toBe(VALUE);
        entered.finish(undefined);
        await held.promise;
        return value;
      }}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Reveal GitHub Password" }),
  );
  try {
    await entered.promise;
    await act(async () => {
      await request();
    });
    expect(currentGuest()).not.toBe(guest);
    held.finish(undefined);
    await act(async () => {
      await held.promise;
    });
    expect(screen.queryByText(VALUE)).toBeNull();
  } finally {
    held.finish(undefined);
  }
});

it("does not grant an old guest a new clipboard pin after genuine synthetic and fresh owner transitions", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const retired = "controlled-live-new-pin-retired-fixture";
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: owner.password,
    retiredPassword: retired,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  const { guest, code } = await request();
  await act(async () => {
    vaultStore.lock();
    await unlockWithRetiredCredentialGate(vaultStore, retired);
    expect(vaultStore.getSnapshot().decoy).toBe(true);
    vaultStore.lock();
    await vaultStore.unlock(owner.password);
  });
  expect(currentGuest()).not.toBe(guest);
  expect(guest.status.at).toBe("ended");
  const memory = clipboardFixture();
  const hook = renderHook(() => useLiveRequestClipboard(guest, code));
  expect(await hook.result.current.copy(code)).toBe("unavailable");
  expect(memory.writes).toEqual([]);
});

it("refuses direct protocol reads from an original joined guest after synthetic and fresh owner transitions", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const retired = "controlled-live-direct-retired-fixture";
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: owner.password,
    retiredPassword: retired,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  const { owner: remote, guest, code } = await request();
  await connect(remote, guest, code);
  expect(await guest.request("copy", ITEM, "password")).toBe(VALUE);
  await act(async () => {
    vaultStore.lock();
    await unlockWithRetiredCredentialGate(vaultStore, retired);
    vaultStore.lock();
    await vaultStore.unlock(owner.password);
  });
  expect(await guest.request("copy", ITEM, "password")).toBeNull();
});

it("preserves independent joined guest reads and fresh controls across ordinary real lock and unlock", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const { owner: remote, guest, code } = await request();
  const catalog = await connect(remote, guest, code);
  vaultStore.lock();
  expect(await guest.request("copy", ITEM, "password")).toBe(VALUE);
  await vaultStore.unlock(owner.password);
  const memory = clipboardFixture();
  const shown = render(
    <LiveCatalog
      guest={guest}
      catalog={catalog}
      request={(what, item, field) => guest.request(what, item, field)}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy GitHub Password" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(await guest.request("copy", ITEM, "password")).toBe(VALUE);
  expect(memory.content).toBe(VALUE);
  shown.unmount();
});

it("does not publish an already committed edit reply after the original guest is replaced", async () => {
  const saved = "controlled-edited-value";
  const stored: string[] = [];
  const made = await makeRequest(
    "edit",
    async () => VALUE,
    async (_item, _field, value) => {
      stored.push(value);
      return true;
    },
  );
  owners.push(made.owner);
  const { owner, guest, code } = made;
  const catalog = await connect(owner, guest, code);
  const entered = deferred<void>();
  const held = deferred<void>();
  render(
    <LiveCatalog
      guest={guest}
      catalog={catalog}
      request={(what, item, field) => guest.request(what, item, field)}
      save={async (item, field, value) => {
        const result = await guest.edit(item, field, value);
        expect(result).toBe(saved);
        entered.finish(undefined);
        await held.promise;
        return result;
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit GitHub Password" }));
  fireEvent.change(screen.getByLabelText("New GitHub Password"), {
    target: { value: saved },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save GitHub Password" }));
  try {
    await entered.promise;
    expect(stored).toEqual([saved]);
    await act(async () => {
      await request();
    });
    held.finish(undefined);
    await act(async () => {
      await held.promise;
    });
    expect(screen.queryByText(saved)).toBeNull();
  } finally {
    held.finish(undefined);
  }
});

it("retires a held real edit reply when the original editable control unmounts", async () => {
  const saved = "controlled-unmounted-edit-value";
  const stored: string[] = [];
  const made = await makeRequest(
    "edit",
    async () => VALUE,
    async (_item, _field, value) => {
      stored.push(value);
      return true;
    },
  );
  owners.push(made.owner);
  const { owner, guest, code } = made;
  const catalog = await connect(owner, guest, code);
  const entered = deferred<void>();
  const held = deferred<void>();
  const onSaved = vi.fn();
  function Editor() {
    const clipboard = useLiveCatalogClipboard(guest, catalog);
    return (
      <EditableRow
        fieldLabel="Password"
        editLabel="GitHub Password"
        canEdit
        pin={clipboard.pin}
        onSaved={onSaved}
        save={async (value) => {
          const result = await guest.edit(ITEM, "password", value);
          expect(result).toBe(saved);
          entered.finish(undefined);
          await held.promise;
          return result;
        }}
      >
        Controlled field
      </EditableRow>
    );
  }
  const shown = render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: "Edit GitHub Password" }));
  fireEvent.change(screen.getByLabelText("New GitHub Password"), {
    target: { value: saved },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save GitHub Password" }));
  try {
    await entered.promise;
    expect(stored).toEqual([saved]);
    shown.unmount();
    expect(currentGuest()).toBe(guest);
    held.finish(undefined);
    await act(async () => {
      await held.promise;
    });
    expect(onSaved).not.toHaveBeenCalled();
  } finally {
    held.finish(undefined);
  }
});

it("lets the same original live control copy after an ordinary real vault lock", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  const { guest, code } = await request();
  const memory = clipboardFixture();
  const hook = renderHook(() => useLiveRequestClipboard(guest, code));
  await act(async () => {
    vaultStore.lock();
  });
  expect(currentGuest()).toBe(guest);
  expect(guest.status).toMatchObject({ at: "request", code });
  hook.rerender();
  expect(await hook.result.current.copy(code)).toBe("copied");
  expect(memory.content).toBe(code);
});

it("refuses an in-flight live copy crossing ordinary lock while allowing the next copy", async () => {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
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
  const pending = hook.result.current.copy(code);
  try {
    await entered.promise;
    await act(async () => {
      vaultStore.lock();
    });
    hook.rerender();
    expect(currentGuest()).toBe(guest);
    held.finish(undefined);
    expect(await pending).toBe("unavailable");
    expect(memory.content).toBe("");
    expect(await hook.result.current.copy(code)).toBe("copied");
    expect(memory.content).toBe(code);
  } finally {
    held.finish(undefined);
    await pending;
  }
});
