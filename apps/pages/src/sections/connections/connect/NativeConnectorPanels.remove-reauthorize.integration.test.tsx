/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://selfhost.example/"} */
import {
  type Connection,
  listConnections,
} from "@opensesame/app-core/lib/connections.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { completeNativeVaultOidc } from "@opensesame/app-core/lib/native-vault-auth.js";
import {
  authorizeNativeVault,
  configureNativeVault,
} from "@opensesame/app-core/lib/native-vault-session.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { overlapCast } from "@opensesame/os-domain";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { nativeAuthPopupRuntime } from "../../../modules/connectors.external/native-auth-popup-runtime.js";
import { bindNativeCleanupRuntime } from "../../../modules/connectors.external/native-cleanup-runtime.js";
import { bindNativeVaultRuntime } from "../../../modules/connectors.external/native-vault-runtime.js";
import { SettingsPageConnectPanels } from "../SettingsPageConnectPanels.js";
import {
  currentTailscaleConnections,
  useTailscaleConnections,
} from "../tailscale/useTailscaleConnectionState.js";
import { nativeConnectorController } from "./native-connector-controller.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";

installConnectorIntegration();
const releases: (() => void)[] = [];
const redirectUri = "https://selfhost.example/auth/native-connector.html";
const endpoint = "https://vault.example.org";
const token = "hvs.synthetic-remove-reauthorize-token";
const trace: { selected: string | null; rows: string[] }[] = [];
afterEach(async () => {
  cleanup();
  for (const release of releases.splice(0).reverse()) release();
  trace.length = 0;
  vaultStore.lock({ recordLastVault: false });
  await Promise.resolve();
});

function button(name: string) {
  return screen.getByRole("button", { name });
}

function protocolFixture() {
  const actual = connectorIntegration();
  bindNativeVaultRuntime(actual.activation);
  bindNativeCleanupRuntime(actual.activation, ["vault", "openbao"]);
  let authorizations = 0;
  actual.route.respond = async (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/oidc/auth_url")) {
      const authorization = new URL("https://issuer.example.org/authorize");
      authorization.search = new URLSearchParams({
        state: `remove-reauthorize-state-${authorizations++}-0123456789`,
        nonce: "remove-reauthorize-provider-nonce",
        redirect_uri: redirectUri,
        response_type: "code",
      }).toString();
      return Response.json({ data: { auth_url: authorization.href } });
    }
    if (url.pathname.endsWith("/oidc/callback"))
      return Response.json({
        auth: { client_token: token, lease_duration: 300 },
      });
    expect(request.headers.get("X-Vault-Token")).toBe(token);
    if (url.pathname.endsWith("/lookup-self"))
      return Response.json({
        data: {
          entity_id: "fixture-identity",
          display_name: "fixture-reader",
          policies: ["browser-read"],
          ttl: 300,
          renewable: true,
        },
      });
    if (url.pathname.endsWith("/revoke-self"))
      return new Response(null, { status: 204 });
    throw new Error("Unexpected typed Vault fixture request");
  };
  return actual;
}

async function configuredRecord() {
  return configureNativeVault({
    providerId: "vault",
    endpoint,
    namespace: "engineering",
    authMount: "oidc",
    role: "browser-read",
  });
}

async function connectedRecord() {
  const id = await configuredRecord();
  const authorization = await authorizeNativeVault(id, redirectUri);
  await completeNativeVaultOidc(id, {
    state: authorization.state,
    code: "approved-fixture-code",
  });
  expect(readNativeConnector(id)?.status).toBe("connected");
  return id;
}

function ProductionSelection({
  initialId,
  otherId,
}: { initialId?: string; otherId?: string }) {
  const [connections, setConnections] = useTailscaleConnections();
  const [selectedId, setSelectedId] = useState(initialId);
  const reload = useCallback(async () => {
    const next = await listConnections();
    setConnections(currentTailscaleConnections(next));
  }, [setConnections]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const provider = catalogProvider("vault");
  if (!provider) throw new Error("Missing compiled Vault provider");
  const matches = (connections ?? []).filter(
    (item) => item.providerId === provider.id && item.status !== "revoked",
  );
  const connection: Connection | null = selectedId
    ? (matches.find((item) => item.connectionId === selectedId) ?? null)
    : matches.length === 1
      ? (matches[0] ?? null)
      : null;
  useLayoutEffect(() => {
    trace.push({
      selected: connection?.connectionId ?? null,
      rows: readDeviceRows().map((row) => row.connectionId),
    });
  });
  return (
    <>
      <button type="button" onClick={() => void reload()}>
        Reload actual connection list
      </button>
      <button
        type="button"
        onClick={() => setSelectedId(readDeviceRows().at(-1)?.connectionId)}
      >
        Select latest actual connection
      </button>
      {otherId ? (
        <button type="button" onClick={() => setSelectedId(otherId)}>
          Select other actual connection
        </button>
      ) : null}
      <SettingsPageConnectPanels
        provider={provider}
        connection={connection}
        onFlash={vi.fn()}
        onChanged={() => void reload()}
        online
        nativeExperience
        identityExperience={false}
        onConnect={null}
        deviceSeal
      />
    </>
  );
}

function mount(actual: ReturnType<typeof protocolFixture>, ids: string[] = []) {
  const windows: {
    close: ReturnType<typeof vi.fn>;
    location: { href: string; replace: ReturnType<typeof vi.fn> };
  }[] = [];
  vi.spyOn(window, "open").mockImplementation(() => {
    const popup = {
      opener: null,
      close: vi.fn(),
      location: { href: "about:blank", replace: vi.fn() },
    };
    windows.push(popup);
    return overlapCast<typeof popup, Window>(popup);
  });
  const popup = nativeAuthPopupRuntime(actual.activation, redirectUri, () => {
    if (actual.activation.disposed()) throw new Error("Activation ended");
  });
  releases.push(
    bindNativeOAuthBrowserPort({
      ...popup,
      redirectUri,
      navigate: vi.fn(),
      scrubCallback: vi.fn(),
    }),
  );
  render(
    <MemoryRouter initialEntries={["/settings/connections/vault"]}>
      <ProductionSelection initialId={ids[0]} otherId={ids[1]} />
    </MemoryRouter>,
  );
  return windows;
}

function authorizationRequests(actual: ReturnType<typeof protocolFixture>) {
  return actual.requests.filter((request) =>
    new URL(request.url).pathname.endsWith("/oidc/auth_url"),
  );
}

async function signIn() {
  await userEvent.clear(screen.getByLabelText("Instance HTTPS origin"));
  await userEvent.type(
    screen.getByLabelText("Instance HTTPS origin"),
    endpoint,
  );
  await userEvent.click(button("Sign in to HashiCorp Vault"));
}

it("keeps a fresh sign-in live after real connected cleanup and both remove controls", async () => {
  const actual = protocolFixture();
  const oldId = await connectedRecord();
  const windows = mount(actual);
  await waitFor(() => expect(trace.at(-1)?.selected).toBe(oldId));
  await userEvent.click(button("Remove connector"));
  await userEvent.click(button("Confirm remove connector"));
  await waitFor(() => expect(readNativeConnector(oldId)).toBeNull());
  expect(authorizationRequests(actual)).toHaveLength(1);
  expect(
    actual.requests.filter((request) =>
      new URL(request.url).pathname.endsWith("/revoke-self"),
    ),
  ).toHaveLength(1);
  expect(trace.some((entry) => !entry.rows.includes(oldId))).toBe(true);
  await signIn();
  await waitFor(() => expect(windows).toHaveLength(1));
  await waitFor(() =>
    expect(windows[0]?.location.replace).toHaveBeenCalledOnce(),
  );
  const [fresh] = readDeviceRows();
  expect(fresh?.connectionId).toBeTruthy();
  expect(fresh?.connectionId).not.toBe(oldId);
  expect(authorizationRequests(actual)).toHaveLength(2);
  expect(windows[0]?.close).not.toHaveBeenCalled();
  expect(button("Cancel sign-in")).toHaveProperty("disabled", false);
  await userEvent.click(button("Cancel sign-in"));
  await waitFor(() => expect(windows[0]?.close).toHaveBeenCalled());
});

it("withdraws fresh sign-in after removed A when selection changes to actual B", async () => {
  const actual = protocolFixture();
  const a = await connectedRecord();
  const b = await connectedRecord();
  const windows = mount(actual, [a, b]);
  await waitFor(() => expect(trace.at(-1)?.selected).toBe(a));
  await userEvent.click(button("Remove connector"));
  await userEvent.click(button("Confirm remove connector"));
  await waitFor(() => expect(readNativeConnector(a)).toBeNull());
  await signIn();
  await waitFor(() => expect(windows).toHaveLength(1));
  await waitFor(() =>
    expect(windows[0]?.location.replace).toHaveBeenCalledOnce(),
  );
  expect(windows[0]?.close).not.toHaveBeenCalled();
  expect(trace.at(-1)?.selected).toBeNull();
  await userEvent.click(button("Select other actual connection"));
  await waitFor(() => expect(trace.at(-1)?.selected).toBe(b));
  await waitFor(() => expect(windows[0]?.close).toHaveBeenCalled());
  expect(readNativeConnector(b)?.status).toBe("connected");
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  await act(async () => Promise.resolve());
  expect(readNativeConnector(b)?.status).toBe("connected");
});

it("withdraws existing A consent when selecting existing same-provider B", async () => {
  const actual = protocolFixture();
  const a = await configuredRecord();
  const b = await connectedRecord();
  const windows = mount(actual, [a, b]);
  await waitFor(() => expect(trace.at(-1)?.selected).toBe(a));
  await signIn();
  await waitFor(() => expect(windows).toHaveLength(1));
  await waitFor(() =>
    expect(windows[0]?.location.replace).toHaveBeenCalledOnce(),
  );
  expect(windows[0]?.close).not.toHaveBeenCalled();
  expect(readDeviceRows().some((row) => row.connectionId === a)).toBe(true);
  await userEvent.click(button("Select other actual connection"));
  await waitFor(() => expect(trace.at(-1)?.selected).toBe(b));
  await waitFor(() => expect(windows[0]?.close).toHaveBeenCalled());
  expect(readNativeConnector(b)?.status).toBe("connected");
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
});

function heldConfigure() {
  const driver = nativeConnectorDriver("oidc", "vault");
  const configure = driver.configure;
  let resume = () => {};
  let entered = (_id: string) => {};
  const committed = new Promise<string>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.spyOn(driver, "configure").mockImplementationOnce(async (draft) => {
    const view = await configure(draft);
    entered(view.connectionId);
    await gate;
    return view;
  });
  releases.push(resume);
  return { committed, resume };
}

it.each(["own", "existing B", "new B", "removed"] as const)(
  "correlates %s selection between actual configure commit and return",
  async (selection) => {
    const actual = protocolFixture();
    const ids =
      selection === "existing B"
        ? [await configuredRecord(), await connectedRecord()]
        : [];
    const windows = mount(actual, ids);
    if (ids[0]) {
      await waitFor(() => expect(trace.at(-1)?.selected).toBe(ids[0]));
      await userEvent.click(button("Remove connector"));
      await userEvent.click(button("Confirm remove connector"));
      await waitFor(() => expect(readNativeConnector(ids[0] ?? "")).toBeNull());
    }
    const before = authorizationRequests(actual).length;
    const held = heldConfigure();
    await signIn();
    const id = await held.committed;
    expect(windows).toHaveLength(1);
    expect(authorizationRequests(actual)).toHaveLength(before);
    if (selection === "existing B") {
      await userEvent.click(button("Select other actual connection"));
      await waitFor(() => expect(trace.at(-1)?.selected).toBe(ids[1]));
      expect(windows[0]?.close).toHaveBeenCalled();
    } else if (selection === "new B") {
      const b = await act(async () => configuredRecord());
      await userEvent.click(button("Reload actual connection list"));
      await userEvent.click(button("Select latest actual connection"));
      await waitFor(() => expect(trace.at(-1)?.selected).toBe(b));
      expect(windows[0]?.close).not.toHaveBeenCalled();
    } else {
      await userEvent.click(button("Reload actual connection list"));
      await waitFor(() => expect(trace.at(-1)?.selected).toBe(id));
      expect(windows[0]?.close).not.toHaveBeenCalled();
      if (selection === "removed") {
        const removing = nativeConnectorController(
          { id: "vault", refused: false },
          id,
        );
        removing.load();
        await act(async () => removing.remove());
        expect(readNativeConnector(id)).toBeNull();
      }
    }
    await act(async () => held.resume());
    if (selection === "own") {
      await waitFor(() =>
        expect(windows[0]?.location.replace).toHaveBeenCalledOnce(),
      );
      expect(authorizationRequests(actual)).toHaveLength(before + 1);
      expect(windows[0]?.close).not.toHaveBeenCalled();
      await userEvent.click(button("Cancel sign-in"));
    } else {
      await waitFor(() => expect(windows[0]?.close).toHaveBeenCalled());
      expect(windows[0]?.location.replace).not.toHaveBeenCalled();
      expect(authorizationRequests(actual)).toHaveLength(before);
      if (ids[1]) expect(readNativeConnector(ids[1])?.status).toBe("connected");
    }
  },
);
