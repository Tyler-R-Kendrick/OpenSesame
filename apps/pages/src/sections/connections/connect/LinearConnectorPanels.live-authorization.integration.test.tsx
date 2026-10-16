import { listConnections } from "@opensesame/app-core/lib/connections.js";
/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://selfhost.example/"} */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { applyLinearClientId } from "@opensesame/app-core/lib/linear-connectors.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useEffect } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { nativeAuthPopupRuntime } from "../../../modules/connectors.external/native-auth-popup-runtime.js";
import {
  currentTailscaleConnections,
  useTailscaleConnections,
} from "../tailscale/useTailscaleConnectionState.js";
import { ConnectPanels } from "./ConnectPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";

installConnectorIntegration();
const releases: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const release of releases.splice(0).reverse()) release();
  applyLinearClientId(undefined);
});

function LiveLinearSettings() {
  const provider = catalogProvider("linear");
  if (!provider) throw new Error("Missing actual Linear provider");
  const [connections, setConnections] = useTailscaleConnections();
  const reload = useCallback(async () => {
    const rows = await listConnections();
    setConnections(currentTailscaleConnections(rows));
  }, [setConnections]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const matches = (connections ?? []).filter(
    (row) => row.providerId === provider.id,
  );
  const selected = matches.length === 1 ? (matches[0] ?? null) : null;
  return (
    <>
      <output aria-label="Connections loaded">
        {connections === null ? "no" : "yes"}
      </output>
      <output aria-label="Selected Linear ID">
        {selected?.connectionId ?? "none"}
      </output>
      <ConnectPanels
        provider={provider}
        connection={selected}
        online
        onFlash={vi.fn()}
        onChanged={() => void reload()}
      />
    </>
  );
}

function linearFixture() {
  const actual = connectorIntegration();
  applyLinearClientId("registered-linear-live-projection");
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
  const redirectUri = `${window.location.origin}/auth/native-connector.html`;
  const popup = nativeAuthPopupRuntime(actual.activation, redirectUri, () => {
    if (actual.activation.disposed())
      throw new Error("Actual connector activation ended");
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
    <MemoryRouter initialEntries={["/settings/connections/linear"]}>
      <LiveLinearSettings />
    </MemoryRouter>,
  );
  return { ...actual, windows };
}

function currentForm() {
  const form = document.querySelector("#connector form");
  if (!form) throw new Error("Missing actual Linear configuration form");
  return form;
}

it("keeps one originating Cancel after actual Linear creation auto-selects its committed row", async () => {
  const actual = linearFixture();
  await waitFor(() =>
    expect(screen.getByLabelText("Connections loaded").textContent).toBe("yes"),
  );
  expect(readDeviceRows()).toHaveLength(0);
  const originatingForm = currentForm();
  await userEvent.clear(screen.getByLabelText("Connector Name"));
  await userEvent.type(screen.getByLabelText("Connector Name"), "Live Linear");
  await userEvent.click(
    screen.getByRole("button", { name: "Create and authorize Linear" }),
  );
  await waitFor(() =>
    expect(actual.windows[0]?.location.replace).toHaveBeenCalledOnce(),
  );
  expect(readDeviceRows()).toHaveLength(1);
  const saved = readDeviceRows()[0];
  if (!saved) throw new Error("Missing actual committed Linear row");
  await waitFor(() =>
    expect(screen.getByLabelText("Selected Linear ID").textContent).toBe(
      saved.connectionId,
    ),
  );
  expect(readDeviceSecrets()[saved.connectionId]?.linear_pending).toBeTruthy();
  expect(actual.windows).toHaveLength(1);
  expect(actual.windows[0]?.close).not.toHaveBeenCalled();
  expect(actual.requests).toHaveLength(0);
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
  console.info("LINEAR_LIVE_PROJECTION", {
    selectedId: saved.connectionId,
    originatingFormConnected: originatingForm.isConnected,
    sameForm: currentForm() === originatingForm,
    popupCloseCount: actual.windows[0]?.close.mock.calls.length,
    authorizationNavigations:
      actual.windows[0]?.location.replace.mock.calls.length,
    cancelCount: screen.queryAllByRole("button", { name: "Cancel sign-in" })
      .length,
    pending: Boolean(readDeviceSecrets()[saved.connectionId]?.linear_pending),
  });
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: "Cancel sign-in" }),
    ).toHaveLength(1),
  );
  const cancel = screen.getByRole("button", { name: "Cancel sign-in" });
  expect(cancel).toHaveProperty("disabled", false);
  await userEvent.click(cancel);
  await waitFor(() => expect(actual.windows[0]?.close).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      readDeviceSecrets()[saved.connectionId]?.linear_pending,
    ).toBeUndefined(),
  );
  expect(actual.requests).toHaveLength(0);
  expect(readDeviceRows()).toHaveLength(1);
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
});
