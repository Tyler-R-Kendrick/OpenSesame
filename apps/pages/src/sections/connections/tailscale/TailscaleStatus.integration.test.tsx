/** @vitest-environment jsdom */
import {
  type Connection,
  type Provider,
  connectionSeams,
} from "@opensesame/app-core/lib/connections.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import {
  readDeviceRows,
  removeDeviceConfigurationDurable,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { embeddedCatalogSeams } from "@opensesame/app-core/lib/embedded-catalog.js";
import {
  forgetAllLocalGitRemotes,
  rememberLocalGitRemote,
} from "@opensesame/app-core/lib/git-remote-local.js";
import { deferred } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vercelCatalogSeams } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../../bindings/identity.js";
import {
  resetConnectionsNavigation,
  useConnectionsNavigation,
} from "../../../components/ConnectionsNavigation.js";
import { useOnlineSeams } from "../../../lib/use-online.js";
import { statusFixture } from "../../../modules/networking.tailnet/browser/authorization.test-support.js";
import { ConnectionsSection } from "../../ConnectionsSection.js";
import { ConnectionCard } from "../ConnectionCard.js";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import { nativeConnectorHeaderStatus } from "../SettingsPageNativeStatus.js";
import { connectedPageItems } from "../page-tree.js";
import { makeConnection } from "../section-fixtures.test-support.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";
import { TailscaleBrowserNode } from "./TailscaleBrowserNode.js";
import { currentTailscaleConnections } from "./useTailscaleConnectionState.js";
const catalog = catalogProvider("tailscale");
if (!catalog) throw new Error("Missing Tailscale catalog entry");
const provider: Provider = {
  ...catalog,
  configured: true,
  autoConfigurable: false,
  missingConfig: [],
  callbackUrl: null,
};
let fixture: Awaited<ReturnType<typeof statusFixture>>;
declareConnectionsTutorial();
beforeEach(async () => {
  fixture = await statusFixture();
});
afterEach(async () => {
  cleanup();
  resetConnectionsNavigation();
  vi.restoreAllMocks();
  await fixture.close();
});
function header(connection: Connection | null = null) {
  const result = render(
    <MemoryRouter>
      <ConnectorSettingsPage
        provider={provider}
        providerId="tailscale"
        connection={connection}
        connections={connection ? [connection] : []}
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
  const node = result.container.querySelector<HTMLElement>(
    "header.conn-settings__head",
  );
  if (!node) throw new Error("Missing actual settings header");
  return within(node);
}
function Navigation() {
  const state = useConnectionsNavigation();
  return (
    <output aria-label="Connected navigation">
      {connectedPageItems(state.providers ?? [], state.connections ?? [])
        .map((item) => item.id)
        .join("|")}
    </output>
  );
}
function home(list: () => Promise<Connection[]>) {
  vi.spyOn(connectionSeams, "listConnections").mockImplementation(list);
  vi.spyOn(connectionSeams, "listIntegrations").mockResolvedValue([]);
  vi.spyOn(embeddedCatalogSeams, "readEmbeddedProviders").mockResolvedValue([
    provider,
  ]);
  vi.spyOn(embeddedCatalogSeams, "writeEmbeddedProviders").mockResolvedValue(
    undefined,
  );
  vi.spyOn(vercelCatalogSeams, "providers").mockReturnValue([provider]);
  vi.spyOn(identityHookSeams, "useIdentitySession").mockReturnValue(null);
  vi.spyOn(useOnlineSeams, "useOnline").mockReturnValue(true);
  render(
    <MemoryRouter initialEntries={["/connections"]}>
      <Navigation />
      <Routes>
        <Route path="/connections" element={<ConnectionsSection />} />
      </Routes>
    </MemoryRouter>,
  );
  return connectionSeams.listConnections;
}
function connected() {
  const panel = screen
    .getByRole("heading", { name: "Connected" })
    .closest("section");
  if (!panel) throw new Error("Missing actual home Connected panel");
  return within(panel);
}
it("updates a fresh settings header from the current browser node without reload or probe", async () => {
  const title = header();
  expect(title.getByLabelText("Browser node not connected")).toBeTruthy();
  await act(async () => {
    await fixture.connect();
  });
  expect(title.getByLabelText("Browser node connected")).toBeTruthy();
  expect(fixture.fetcher).not.toHaveBeenCalled();
  act(() => fixture.node.stop());
  expect(title.getByLabelText("Browser node not connected")).toBeTruthy();
  expect(title.queryByLabelText("Browser node connected")).toBeNull();
});
it("does not borrow authority for an explicit imported connection with a colliding ID", async () => {
  await fixture.connect();
  const local = fixture.connection();
  const imported = { ...local, connectionRef: "imported/other-authority" };
  expect(nativeConnectorHeaderStatus(imported, provider)).toBeNull();
  expect(currentTailscaleConnections([imported])).toContain(imported);
  const other = makeConnection({
    providerId: "tailscale",
    connectionId: "other-id",
    connectionRef: "local/connector/other-id",
  });
  expect(nativeConnectorHeaderStatus(other, provider)?.tone).not.toBe("ok");
});
it("uses the real two-step Forget control to remove metadata and retire the private state", async () => {
  const worker = await fixture.connect();
  const id = fixture.connection().connectionId;
  render(<TailscaleBrowserNode ready online />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Forget local browser node" }),
  );
  expect(worker.terminated).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm forget local browser node" }),
  );
  await waitFor(() =>
    expect(readDeviceRows().some((row) => row.connectionId === id)).toBe(false),
  );
  expect(worker.terminated).toBe(true);
  expect(
    vaultStore
      .getSnapshot()
      .items.some(
        (item) => item.kind === "credential" && item.method.type === "token",
      ),
  ).toBe(false);
});
it("observes the real generic Revoke path even when the encrypted Token is unchanged", async () => {
  const worker = await fixture.connect();
  const connection = fixture.connection();
  const token = JSON.stringify(vaultStore.getSnapshot().items);
  render(
    <MemoryRouter>
      <ConnectionCard
        connection={connection}
        provider={provider}
        online
        onFlash={vi.fn()}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke it" }));
  await waitFor(() =>
    expect(
      readDeviceRows().some(
        (row) => row.connectionId === connection.connectionId,
      ),
    ).toBe(false),
  );
  expect(worker.terminated).toBe(true);
  expect(JSON.stringify(vaultStore.getSnapshot().items)).toBe(token);
});
it("keeps home and its navigation current using only local SDK notifications", async () => {
  await fixture.start();
  const pending = fixture.connection();
  const ordinary = makeConnection({
    connectionId: "ordinary-connection",
    displayName: "Ordinary sibling",
  });
  const imported = makeConnection({
    connectionId: "imported-tail",
    providerId: "tailscale",
    displayName: "Imported sibling",
    connectionRef: "imported/tailscale",
  });
  const list = home(async () => [pending, ordinary, imported]);
  await waitFor(() =>
    expect(connected().getByText("Ordinary sibling")).toBeTruthy(),
  );
  expect(connected().queryByText(pending.displayName)).toBeNull();
  const count = vi.mocked(list).mock.calls.length;
  await act(async () => {
    await fixture.connect();
  });
  await waitFor(() =>
    expect(connected().getByText(pending.displayName)).toBeTruthy(),
  );
  expect(screen.getByLabelText("Connected navigation").textContent).toContain(
    pending.connectionId,
  );
  expect(connected().getByText("Imported sibling")).toBeTruthy();
  act(() => fixture.node.stop());
  await waitFor(() =>
    expect(connected().queryByText(pending.displayName)).toBeNull(),
  );
  expect(
    screen.getByLabelText("Connected navigation").textContent,
  ).not.toContain(pending.connectionId);
  expect(connected().getByText("Ordinary sibling")).toBeTruthy();
  expect(connected().getByText("Imported sibling")).toBeTruthy();
  expect(vi.mocked(list).mock.calls).toHaveLength(count);
});
it("reprojects an older async list result and removes deleted local rows without erasing imports", async () => {
  await fixture.connect();
  const old = fixture.connection();
  const delayed = deferred<Connection[]>();
  home(() => delayed.promise);
  await act(async () => {
    fixture.node.stop();
    await removeDeviceConfigurationDurable(old.connectionId);
  });
  const imported = {
    ...old,
    connectionRef: "imported/retained",
    displayName: "Imported retained",
  };
  await act(async () => {
    delayed.resolve([old, imported]);
  });
  await waitFor(() =>
    expect(connected().getByText("Imported retained")).toBeTruthy(),
  );
  expect(connected().queryByText(old.displayName)).toBeNull();
  expect(
    screen.getByLabelText("Connected navigation").textContent,
  ).not.toContain(`connected-${old.connectionId}`);
  expect(currentTailscaleConnections([old, imported])).toEqual([imported]);
});
it("updates header and home while a real encrypted SDK write is pending, then recovers on settlement", async () => {
  const worker = await fixture.connect();
  const title = header();
  home(async () => [fixture.connection()]);
  await waitFor(() =>
    expect(
      connected().getByText(fixture.connection().displayName),
    ).toBeTruthy(),
  );
  const held = fixture.holdReceipt();
  await act(async () => {
    worker.emit({ kind: "storage", state: { key: "next-status-state" } });
    await held.ready;
  });
  expect(title.getByLabelText("Browser node not connected")).toBeTruthy();
  expect(connected().queryByText(fixture.connection().displayName)).toBeNull();
  await act(async () => {
    held.release();
  });
  await waitFor(() =>
    expect(title.getByLabelText("Browser node connected")).toBeTruthy(),
  );
  expect(connected().getByText(fixture.connection().displayName)).toBeTruthy();
});

it.each(["lock", "lease", "dispose"])(
  "withdraws a mounted fresh header on %s",
  async (cause) => {
    await fixture.connect();
    const title = header();
    expect(title.getByLabelText("Browser node connected")).toBeTruthy();
    act(() => {
      if (cause === "lock") vaultStore.lock();
      if (cause === "lease") fixture.revoke();
      if (cause === "dispose") fixture.activation.dispose();
    });
    expect(title.getByLabelText("Browser node not connected")).toBeTruthy();
    expect(title.queryByLabelText("Browser node connected")).toBeNull();
  },
);

it("keeps current live browser and local Git entries when an older asynchronous listing fails", async () => {
  await fixture.connect();
  const connection = fixture.connection();
  const git = await rememberLocalGitRemote({
    displayName: "Retained local Git",
    configuration: {
      remote_url: "ssh://git@git.example/repo.git",
      auth_mode: "ssh_agent",
    },
  });
  let reject = (_error: Error) => {};
  const promise = new Promise<Connection[]>((_resolve, fail) => {
    reject = fail;
  });
  try {
    home(() => promise);
    await act(async () => {
      reject(new Error("Old list request failed"));
    });
    await waitFor(() =>
      expect(connected().getByText(connection.displayName)).toBeTruthy(),
    );
    expect(connected().getByText(git.displayName)).toBeTruthy();
    expect(screen.getByLabelText("Connected navigation").textContent).toContain(
      connection.connectionId,
    );
  } finally {
    await forgetAllLocalGitRemotes();
  }
});
