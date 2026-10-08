// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import {
  holdGenuineRead,
  persistentBrowserOwner,
} from "@opensesame/app-core/browser/security-integration/management-host.fixture.js";
import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import { configureHost } from "@opensesame/app-core/host.js";
import { kvFileName, kvFlush } from "@opensesame/app-core/lib/kv.js";
import { linkRoutes } from "@opensesame/app-core/lib/live/routes.js";
import {
  currentHost,
  endHosting,
} from "@opensesame/app-core/lib/live/session.js";
import {
  TRANSPORT_PATH,
  readLiveTransport,
  writeLiveTransport,
} from "@opensesame/app-core/lib/live/transport-store.js";
import { DIRECT_TRANSPORT } from "@opensesame/app-core/lib/live/transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { PERSONAL_TOMB, tombFileKey } from "@opensesame/app-core/lib/vfs.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { createItem } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { LiveSettings } from "./LiveSettings.js";
import { liveUiSeams } from "./live-hooks.js";
import { transportSeams } from "./live-transport-hooks.js";

const profile = (relay: boolean, username = "fixture") => ({
  ...DIRECT_TRANSPORT,
  ice: [
    {
      urls: ["turn:127.0.0.1:3478?transport=tcp"],
      username,
      credential: "controlled-test-credential",
    },
  ],
  relay,
});

function holdPhysicalWrite(
  root: Awaited<ReturnType<typeof persistentBrowserOwner>>["root"],
  target: string,
) {
  const started = deferred<void>();
  const resume = deferred<void>();
  const get = root.getFileHandle.bind(root);
  let armed = true;
  vi.spyOn(root, "getFileHandle").mockImplementation(async (name, options) => {
    const handle = await get(name, options);
    if (name !== target || !options?.create || !armed) return handle;
    armed = false;
    const create = handle.createWritable.bind(handle);
    return {
      ...handle,
      createWritable: async () => {
        const writable = await create();
        return {
          ...writable,
          write: async (ciphertext) => {
            started.finish();
            await resume.promise;
            await writable.write(ciphertext);
          },
        };
      },
    };
  });
  return { started: started.promise, release: () => resume.finish() };
}

async function ownerSettings(withServer = true) {
  const owner = await persistentBrowserOwner();
  await vaultStore.unlock(owner.password);
  await vaultStore.saveItem(createItem("account", "GitHub"));
  await writeLiveTransport(
    PERSONAL_TOMB,
    withServer ? profile(false) : DIRECT_TRANSPORT,
  );
  const view = render(
    <MemoryRouter>
      <LiveSettings />
    </MemoryRouter>,
  );
  const hostElement = view.container.querySelector("#live-session");
  if (!hostElement) throw new Error("Expected the actual host panel");
  const host = within(hostElement as HTMLElement);
  expect(
    host.getByRole("img", { name: "Reading this vault's routes" }),
  ).toBeTruthy();
  fireEvent.change(host.getByLabelText("Session name"), {
    target: { value: "Team" },
  });
  fireEvent.click(host.getByRole("checkbox", { name: "GitHub" }));
  await host.findByRole("img", {
    name: withServer ? /^Direct, with 1 TURN server$/ : /^Direct only$/,
  });
  const relay = withServer
    ? await view.findByRole("checkbox", { name: "Relay only, through TURN" })
    : null;
  const start = host.getByRole("button", { name: "Start the live session" });
  const form = start.closest("form");
  if (!form) throw new Error("Expected the actual host form");
  return { owner, view, host, relay, start, form };
}

it("withholds the host form until a queued relay edit is sealed and its own view reloads", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const original = { ...liveUiSeams };
  const peers = vi.fn(() => {
    throw new Error("No peer is needed to construct a host link");
  });
  liveUiSeams.peers = peers;
  let held: ReturnType<typeof holdPhysicalWrite> | undefined;
  try {
    const { owner, view, host, start, form } = await ownerSettings(false);
    const file = kvFileName(tombFileKey(PERSONAL_TOMB, TRANSPORT_PATH));
    const before = owner.root.files.get(file);
    expect(before).toBeDefined();
    held = holdPhysicalWrite(owner.root, file);
    fireEvent.change(await view.findByLabelText("STUN or TURN server"), {
      target: { value: profile(true).ice[0]?.urls[0] },
    });
    fireEvent.change(view.getByLabelText("TURN username"), {
      target: { value: "fixture" },
    });
    fireEvent.change(view.getByLabelText("TURN credential"), {
      target: { value: "controlled-test-credential" },
    });
    fireEvent.click(view.getByRole("button", { name: "Add the server" }));
    const relay = await view.findByRole("checkbox", {
      name: "Relay only, through TURN",
    });
    await held.started;
    fireEvent.click(relay);
    expect(relay).toHaveProperty("checked", true);
    expect(owner.root.files.get(file)).toBe(before);
    // On the unchanged implementation this constructs an actual direct-only
    // link while the real encrypted write is still held. Record that result
    // before asserting; a disabled view alone would not demonstrate the bug.
    let prematureRoutes: ReturnType<typeof linkRoutes> = null;
    if (!(start as HTMLButtonElement).disabled) {
      fireEvent.submit(form);
      await waitFor(() => expect(currentHost()).not.toBeNull());
      const premature = currentHost();
      if (!premature) throw new Error("Expected the observed premature host");
      prematureRoutes = linkRoutes(premature.link);
    }
    expect(prematureRoutes).toBeNull();
    expect(start).toHaveProperty("disabled", true);
    // A forged submit must also hit the production readiness guard.
    fireEvent.submit(form);
    expect(currentHost()).toBeNull();
    expect(peers).not.toHaveBeenCalled();
    held.release();
    await host.findByRole("img", {
      name: /^Relay only, with 1 TURN server$/,
    });
    expect((await readLiveTransport(PERSONAL_TOMB)).relay).toBe(true);
    await waitFor(() => expect(start).toHaveProperty("disabled", false));
    fireEvent.submit(form);
    await waitFor(() => expect(currentHost()).not.toBeNull());
    const actual = currentHost();
    if (!actual)
      throw new Error("Expected the cryptographically constructed host");
    expect(linkRoutes(actual.link)).toEqual({
      ice: profile(true).ice,
      relay: true,
      carriers: [],
    });
    expect(peers).not.toHaveBeenCalled();
  } finally {
    held?.release();
    await kvFlush();
    endHosting();
    cleanup();
    vaultStore.lock();
    Object.assign(liveUiSeams, original);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    configureHost(createTestHost());
  }
}, 20_000);

it("does not retarget either queued relay gesture into a freshly authenticated owner", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const original = { ...liveUiSeams };
  const peers = vi.fn(() => {
    throw new Error("A retired edit must never construct a peer");
  });
  liveUiSeams.peers = peers;
  let held: ReturnType<typeof holdGenuineRead> | undefined;
  try {
    const { owner, relay } = await ownerSettings();
    if (!relay) throw new Error("Expected the actual configured relay choice");
    const file = kvFileName(tombFileKey(PERSONAL_TOMB, TRANSPORT_PATH));
    const writes = vi.spyOn(transportSeams, "write");
    held = holdGenuineRead(owner.root, file);
    fireEvent.click(relay);
    await held.started;
    expect(relay).toHaveProperty("checked", true);
    fireEvent.click(relay);
    expect(relay).toHaveProperty("checked", false);
    vaultStore.lock();
    await vaultStore.unlock(owner.password);
    await writeLiveTransport(PERSONAL_TOMB, profile(true, "fresh-owner"));
    const successorBytes = owner.root.files.get(file);
    held.release();
    await waitFor(() => expect(relay).toHaveProperty("checked", true));
    await kvFlush();
    expect(writes).not.toHaveBeenCalled();
    expect(await readLiveTransport(PERSONAL_TOMB)).toEqual(
      profile(true, "fresh-owner"),
    );
    expect(owner.root.files.get(file)).toBe(successorBytes);
    expect(currentHost()).toBeNull();
    expect(peers).not.toHaveBeenCalled();
  } finally {
    held?.release();
    await kvFlush();
    endHosting();
    cleanup();
    vaultStore.lock();
    Object.assign(liveUiSeams, original);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    configureHost(createTestHost());
  }
}, 20_000);
