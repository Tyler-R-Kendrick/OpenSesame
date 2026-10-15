/** @vitest-environment jsdom */
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { kvFlush, kvForgetAll, kvSeams } from "@opensesame/app-core/lib/kv.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  PERSONAL_PROJECT_ID,
  createProject,
  setActiveProject,
} from "@opensesame/app-core/lib/projects.js";
import {
  deferred,
  runtimePassword,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { tailscaleNodeAuthorization } from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { enrollTotp } from "@opensesame/app-core/lib/vault/store-totp.fixture.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  StatusWorker,
  netmap,
  statusFixture,
} from "../../../modules/networking.tailnet/browser/authorization.test-support.js";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";
import { TailscalePanels } from "./TailscalePanels.js";
import { tailscaleAppDependencies as oauth } from "./tailscale-dependencies.js";
let fixture: Awaited<ReturnType<typeof statusFixture>>;
const catalog = catalogProvider("tailscale");
if (!catalog) throw new Error("Missing Tailscale provider");
const provider: Provider = {
  ...catalog,
  configured: true,
  autoConfigurable: false,
  missingConfig: [],
  callbackUrl: null,
};
declareConnectionsTutorial();
beforeEach(async () => {
  fixture = await statusFixture();
  clearNotices();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vaultStore.lock();
  await setActiveProject(PERSONAL_PROJECT_ID);
  vaultStore.loadActiveProjectScope();
  await fixture.close();
  clearNotices();
});
function primary(online = true) {
  return render(<TailscalePanels online={online} />);
}
function button() {
  return screen.getByRole("button", { name: "Connect browser node" });
}
async function ready() {
  await waitFor(() => expect(button().hasAttribute("disabled")).toBe(false));
}
function prohibitOAuth() {
  return [
    vi.spyOn(oauth, "hydrateTailscaleApps"),
    vi.spyOn(oauth, "optionalBrowser"),
    vi.spyOn(oauth, "transport"),
    vi.spyOn(oauth, "browser"),
    vi.spyOn(oauth, "session"),
  ];
}
function actualPage() {
  return render(
    <MemoryRouter>
      <ConnectorSettingsPage
        provider={provider}
        providerId="tailscale"
        connection={null}
        connections={[]}
        loading={false}
        online
        canConfigure
        configureHint=""
        flash={null}
        rememberOffer={null}
        onFlash={vi.fn()}
        onRememberOffer={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
}
it("mounts only the browser peering panel at the actual settings entry without OAuth dependencies", async () => {
  const spies = prohibitOAuth();
  actualPage();
  await ready();
  expect(
    screen.getByRole("region", { name: "Tailscale browser node" }),
  ).toBeTruthy();
  expect(
    screen.getByLabelText("Browser node hostname").getAttribute("value"),
  ).toMatch(/^opensesame-/);
  expect(
    screen.getByLabelText("Tailscale control server").getAttribute("value"),
  ).toBe("https://controlplane.tailscale.com");
  for (const name of [
    "App name",
    "Tailscale API base URL",
    "Redirect URI to register",
    "Returned OAuth app JSON",
    "Admin API access token",
    "Issued device auth key",
  ])
    expect(screen.queryByLabelText(name)).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: /Register app|Download registration|Save returned Tailscale|Prepare device key handoff/,
    }),
  ).toBeNull();
  expect(
    screen.queryByText(
      /currently restricts direct browser CORS|completed by that device's Tailscale client/,
    ),
  ).toBeNull();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(fixture.fetcher).not.toHaveBeenCalled();
});
it("starts the real controller through the primary form and admits only the actual authenticated browser node", async () => {
  const spies = prohibitOAuth();
  primary();
  await ready();
  fireEvent.change(screen.getByLabelText("Browser node hostname"), {
    target: { value: "primary-browser" },
  });
  fireEvent.change(screen.getByLabelText("Optional node auth key"), {
    target: { value: "transient-primary-key" },
  });
  fireEvent.click(button());
  await waitFor(() => expect(fixture.node.snapshot().status).toBe("starting"));
  await screen.findByRole("button", { name: "Forget local browser node" });
  const worker = StatusWorker.current;
  expect(readDeviceRows()).toHaveLength(1);
  expect(tailscaleNodeAuthorization()?.connected).toBe(false);
  await act(async () => {
    worker.emit({ kind: "state", state: "NeedsLogin" });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Sign in to Tailscale" }),
  );
  expect(worker.sent).toContainEqual({ kind: "login" });
  await act(async () => {
    worker.emit({ kind: "auth", url: "https://login.tailscale.com/a/primary" });
  });
  expect(
    await screen.findByRole("link", {
      name: "Continue signing in with Tailscale",
    }),
  ).toHaveProperty("href", "https://login.tailscale.com/a/primary");
  await act(async () => {
    worker.emit({
      kind: "storage",
      state: { key: "sealed-primary-private-node-state" },
    });
    netmap(worker);
    worker.emit({ kind: "state", state: "Running" });
  });
  await waitFor(() =>
    expect(tailscaleNodeAuthorization()?.connected).toBe(true),
  );
  expect(fixture.connection().status).toBe("active");
  expect(
    vaultStore
      .getSnapshot()
      .items.some(
        (item) => item.kind === "credential" && item.method.type === "token",
      ),
  ).toBe(true);
  expect(
    screen.getByLabelText("Optional node auth key").getAttribute("value"),
  ).toBe("");
  expect(document.body.textContent).not.toContain(
    "sealed-primary-private-node-state",
  );
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(fixture.fetcher).not.toHaveBeenCalled();
});
it("restores the actual encrypted durable node metadata after its in-memory KV cache is empty", async () => {
  await fixture.connect();
  fixture.node.stop();
  await kvFlush();
  kvForgetAll();
  expect(readDeviceRows()).toEqual([]);
  const spies = prohibitOAuth();
  primary();
  await ready();
  expect(
    screen.getByLabelText("Browser node hostname").getAttribute("value"),
  ).toBe("status-browser");
  expect(readDeviceRows()).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Forget local browser node" }),
  ).toBeTruthy();
  expect(tailscaleNodeAuthorization()).toBeNull();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});
it("waits for actual metadata hydration before allowing Connect", async () => {
  const hydrate = kvSeams.kvHydrate;
  const gate = deferred<void>();
  const spy = vi
    .spyOn(kvSeams, "kvHydrate")
    .mockImplementationOnce(async (keys) => {
      await gate.promise;
      await hydrate(keys);
    });
  primary();
  expect(button().hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByLabelText("Browser node hostname").hasAttribute("disabled"),
  ).toBe(false);
  expect(spy).toHaveBeenCalledWith([...DEVICE_CONNECTOR_KEYS]);
  await act(async () => {
    gate.resolve();
  });
  await ready();
});
it("reports a real storage-load failure without enabling Connect or invoking OAuth fallback", async () => {
  vi.spyOn(kvSeams, "kvHydrate").mockRejectedValueOnce(
    new Error("Cannot read encrypted storage"),
  );
  const spies = prohibitOAuth();
  primary();
  await waitFor(() =>
    expect(
      listNotices().some((notice) => notice.id === "tailscale-browser-storage"),
    ).toBe(true),
  );
  expect(button().hasAttribute("disabled")).toBe(true);
  expect(screen.getByLabelText("Tailscale control server")).toBeTruthy();
  expect(tailscaleNodeAuthorization()).toBeNull();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});
it.each(["Networking off", "offline"])(
  "keeps configuration fields usable with %s",
  async (mode) => {
    if (mode === "Networking off") fixture.activation.dispose();
    primary(mode !== "offline");
    fireEvent.change(screen.getByLabelText("Browser node hostname"), {
      target: { value: "configured-offline" },
    });
    expect(
      screen.getByLabelText("Browser node hostname").getAttribute("value"),
    ).toBe("configured-offline");
    expect(button().hasAttribute("disabled")).toBe(true);
    expect(readDeviceRows()).toHaveLength(0);
    expect(fixture.fetcher).not.toHaveBeenCalled();
  },
);
it("withdraws readiness on the actual vault lock and restores it after owner unlock", async () => {
  primary();
  await ready();
  act(() => vaultStore.lock());
  expect(button().hasAttribute("disabled")).toBe(true);
  await act(async () => {
    await vaultStore.unlock(runtimePassword);
  });
  await ready();
});
it("does not enable Connect in an actual guest vault", async () => {
  vaultStore.lock();
  await vaultStore.createGuest();
  primary();
  await waitFor(() => expect(vaultStore.getSnapshot().guest).toBe(true));
  expect(button().hasAttribute("disabled")).toBe(true);
  expect(fixture.fetcher).not.toHaveBeenCalled();
});
it("keeps actual second-step unlock pending", async () => {
  await enrollTotp(vaultStore);
  const selfId = vaultStore.getSnapshot().header?.unlocks?.totp?.selfItemId;
  if (!selfId) throw new Error("Missing real self authenticator");
  await vaultStore.trashItem(selfId);
  vaultStore.lock();
  await vaultStore.unlock(runtimePassword);
  expect(vaultStore.getSnapshot().awaitingSecondStep).toBe(true);
  primary();
  expect(button().hasAttribute("disabled")).toBe(true);
});
it.each(["success", "failure"])(
  "discards a former owner's late hydration %s while the actual new owner's storage is pending",
  async (outcome) => {
    const hydrate = kvSeams.kvHydrate;
    const first = deferred<void>();
    const second = deferred<void>();
    let fail = (_error: Error) => {};
    const failure = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    vi.spyOn(kvSeams, "kvHydrate")
      .mockImplementationOnce(async (keys) => {
        await Promise.race([first.promise, failure]);
        await hydrate(keys);
      })
      .mockImplementationOnce(async (keys) => {
        await second.promise;
        await hydrate(keys);
      });
    primary();
    const previous = vaultStore.getSnapshot().tomb;
    const project = await createProject("Different node owner");
    await act(async () => {
      await setActiveProject(project.id);
      vaultStore.loadActiveProjectScope();
      await vaultStore.create(runtimePassword);
    });
    expect(vaultStore.getSnapshot().tomb).not.toBe(previous);
    await act(async () => {
      if (outcome === "success") first.resolve();
      else fail(new Error("Old owner storage failed"));
    });
    expect(button().hasAttribute("disabled")).toBe(true);
    expect(
      listNotices().some((notice) => notice.id === "tailscale-browser-storage"),
    ).toBe(false);
    await act(async () => {
      second.resolve();
    });
    await ready();
  },
);
it("ignores an unmounted primary page's late storage failure", async () => {
  let fail = (_error: Error) => {};
  const pending = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  vi.spyOn(kvSeams, "kvHydrate").mockReturnValueOnce(pending);
  const view = primary();
  view.unmount();
  await act(async () => {
    fail(new Error("Late unmounted storage failure"));
  });
  expect(
    listNotices().some((notice) => notice.id === "tailscale-browser-storage"),
  ).toBe(false);
});
