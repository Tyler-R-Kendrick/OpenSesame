import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://selfhost.example/"} */
import {
  readDeviceRows,
  subscribeDeviceRows,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { nativeVaultClassification } from "@opensesame/app-core/lib/native-vault-session.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { overlapCast } from "@opensesame/os-domain";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useState } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { nativeAuthPopupRuntime } from "../../../modules/connectors.external/native-auth-popup-runtime.js";
import { bindNativeCleanupRuntime } from "../../../modules/connectors.external/native-cleanup-runtime.js";
import { bindNativeVaultRuntime } from "../../../modules/connectors.external/native-vault-runtime.js";
import { SettingsPageConnectPanels } from "../SettingsPageConnectPanels.js";
import { nativeConnectorController } from "./native-connector-controller.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";
import type { NativeConnectorCallbacks } from "./native-connector-ui.js";

installConnectorIntegration();
const releases: (() => void)[] = [];
afterEach(async () => {
  cleanup();
  for (const release of releases.splice(0).reverse()) release();
  vaultStore.lock({ recordLastVault: false });
  await Promise.resolve();
});
function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function button(name: string | RegExp) {
  return screen.getByRole("button", { name });
}
function currentRecord() {
  const row = readDeviceRows()[0];
  if (!row) throw new Error("Missing actual saved row");
  const record = loadNativeConnectorRecord(row.connectionId);
  if (!record) throw new Error("Missing actual saved record");
  return record;
}
function configurationForm() {
  const form = document.querySelector("#connector form");
  if (!form) throw new Error("Missing native configuration form");
  return form;
}
function SettingsSubscriber({
  onFlash,
}: { onFlash: NativeConnectorCallbacks["onFlash"] }) {
  const [, refresh] = useState(0);
  useLayoutEffect(
    () => subscribeDeviceRows(() => refresh((value) => value + 1)),
    [],
  );
  const location = useLocation();
  const navigate = useNavigate();
  const provider = catalogProvider(
    location.pathname.endsWith("openbao") ? "openbao" : "vault",
  );
  if (!provider) throw new Error("Missing compiled device provider");
  const connection =
    readDeviceRows()
      .map((row) => deviceConnection(row.connectionId))
      .find((item) => item?.providerId === provider.id) ?? null;
  return (
    <>
      <button type="button" onClick={() => navigate("?selected=other")}>
        Change route
      </button>
      <button
        type="button"
        onClick={() => navigate("/settings/integrations/openbao")}
      >
        Change provider
      </button>
      <SettingsPageConnectPanels
        provider={provider}
        connection={connection}
        onFlash={onFlash}
        onChanged={() => {}}
        online
        nativeExperience
        identityExperience={false}
        onConnect={null}
        deviceSeal
      />
    </>
  );
}
function fixture() {
  const actual = connectorIntegration();
  bindNativeVaultRuntime(actual.activation);
  bindNativeCleanupRuntime(actual.activation, ["vault", "openbao"]);
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
      throw new Error("Native activation ended");
  });
  releases.push(
    bindNativeOAuthBrowserPort({
      ...popup,
      redirectUri,
      navigate: vi.fn(),
      scrubCallback: vi.fn(),
    }),
  );
  const requests: { finish(): void }[] = [];
  actual.route.respond = () => {
    const gate = deferred<Response>();
    const url = new URL("https://issuer.example.org/authorize");
    url.search = new URLSearchParams({
      state: `pending-state-${requests.length}-0123456789012345`,
      nonce: `pending-nonce-${requests.length}`,
      redirect_uri: redirectUri,
      response_type: "code",
    }).toString();
    const finish = () =>
      gate.resolve(Response.json({ data: { auth_url: url.href } }));
    requests.push({ finish });
    releases.push(finish);
    return gate.promise;
  };
  const onFlash = vi.fn<NativeConnectorCallbacks["onFlash"]>();
  const mounted = render(
    <MemoryRouter initialEntries={["/settings/integrations/vault"]}>
      <SettingsSubscriber onFlash={onFlash} />
    </MemoryRouter>,
  );
  return { ...actual, windows, requests, onFlash, mounted };
}
async function start() {
  const choice = screen.queryByRole("radio", { name: "Sign in" });
  if (choice) await userEvent.click(choice);
  const endpoint = screen.getByLabelText("Instance HTTPS origin");
  if (!(endpoint instanceof HTMLInputElement))
    throw new Error("Missing instance input");
  if (!endpoint.value)
    await userEvent.type(endpoint, "https://vault.example.org");
  await userEvent.click(button(/^Sign in to /));
}
async function reachConsent(
  actual: ReturnType<typeof fixture>,
  index: number,
  windowIndex = index,
) {
  await waitFor(() => expect(actual.requests).toHaveLength(index + 1));
  await act(async () => actual.requests[index]?.finish());
  await waitFor(() =>
    expect(
      actual.windows[windowIndex]?.location.replace,
    ).toHaveBeenCalledOnce(),
  );
}
async function cancel() {
  await userEvent.click(button("Cancel sign-in"));
  await waitFor(() => expect(currentRecord().privateState.pending).toEqual({}));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull(),
  );
}
function holdConfigure() {
  const driver = nativeConnectorDriver("oidc", "vault");
  const configure = driver.configure;
  const committed = deferred<void>();
  const resume = deferred<void>();
  vi.spyOn(driver, "configure").mockImplementationOnce(async (input) => {
    const view = await configure(input);
    committed.resolve();
    await resume.promise;
    return view;
  });
  releases.push(() => resume.resolve());
  return { committed: committed.promise, resume: () => resume.resolve() };
}

it("keeps the actual Settings panel and one Cancel through both committed form remounts", async () => {
  const actual = fixture();
  const panel = document.querySelector(".cx-setup");
  const first = configurationForm();
  await start();
  await waitFor(() => expect(actual.requests).toHaveLength(1));
  expect(panel?.isConnected).toBe(true);
  expect(first.isConnected).toBe(false);
  const second = configurationForm();
  expect(
    screen.getAllByRole("button", { name: "Cancel sign-in" }),
  ).toHaveLength(1);
  expect(
    button("Cancel sign-in").parentElement?.classList.contains("go-row"),
  ).toBe(true);
  expect(button(/^Sign in to /)).toHaveProperty("disabled", true);
  await reachConsent(actual, 0);
  expect(second.isConnected).toBe(false);
  expect(panel?.isConnected).toBe(true);
  expect(screen.getByLabelText("Instance HTTPS origin")).toHaveProperty(
    "value",
    "https://vault.example.org",
  );
  expect(currentRecord().privateState.pending.user).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: "Cancel sign-in" }),
  ).toHaveLength(1);
  await cancel();
  expect(actual.windows[0]?.close).toHaveBeenCalled();
  expect(currentRecord().privateState.credentials.oidc_nonce).toBeUndefined();
  expect(readNativeConnector(currentRecord().connectionId)?.status).toBe(
    "configuration",
  );
  expect(actual.onFlash).not.toHaveBeenCalled();
});

it("keeps B live when cancelled A finishes its real configure after the Settings remount", async () => {
  const actual = fixture();
  const held = holdConfigure();
  await start();
  await held.committed;
  await userEvent.click(button("Cancel sign-in"));
  await start();
  await reachConsent(actual, 0, 1);
  const state = currentRecord().privateState.pending.user?.state;
  await act(async () => held.resume());
  expect(actual.requests).toHaveLength(1);
  expect(actual.windows[1]?.close).not.toHaveBeenCalled();
  expect(currentRecord().privateState.pending.user?.state).toBe(state);
  expect(button("Cancel sign-in")).toHaveProperty("disabled", false);
  expect(actual.onFlash).not.toHaveBeenCalled();
  await cancel();
});

it.each(["route", "provider", "unmount", "remove"] as const)(
  "withdraws the exact close projection on %s while real configure is held",
  async (change) => {
    const actual = fixture();
    const held = holdConfigure();
    await start();
    await held.committed;
    if (change === "unmount") actual.mounted.unmount();
    else if (change === "remove") {
      const removing = nativeConnectorController(
        { id: "vault", refused: false },
        currentRecord().connectionId,
      );
      removing.load();
      await act(async () => removing.remove());
    } else
      await userEvent.click(
        button(change === "route" ? "Change route" : "Change provider"),
      );
    expect(actual.windows[0]?.close).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
    await act(async () => held.resume());
    expect(actual.requests).toHaveLength(0);
    if (change === "remove") expect(readDeviceRows()).toEqual([]);
    else expect(currentRecord().privateState.pending).toEqual({});
    expect(actual.onFlash).not.toHaveBeenCalled();
  },
);

it("does not revive the old close key after actual same-tomb lock and unlock", async () => {
  const actual = fixture();
  const password = "Panel fixture unlock phrase 9!";
  await act(async () => vaultStore.create(password));
  const tomb = vaultStore.getSnapshot().tomb;
  const held = holdConfigure();
  await start();
  await held.committed;
  await act(async () => vaultStore.lock({ recordLastVault: false }));
  expect(actual.windows[0]?.close).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  await act(async () => vaultStore.unlock(password));
  expect(vaultStore.getSnapshot().tomb).toBe(tomb);
  expect(vaultStore.getSnapshot().status).toBe("unlocked");
  await act(async () => held.resume());
  expect(actual.requests).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  await start();
  await reachConsent(actual, 0, 1);
  expect(actual.windows).toHaveLength(2);
  expect(actual.windows[1]?.close).not.toHaveBeenCalled();
  await cancel();
});

it("keeps only the original close key across an independent same-provider metadata commit", async () => {
  const actual = fixture();
  await start();
  await reachConsent(actual, 0);
  const before = configurationForm();
  const record = currentRecord();
  await act(async () =>
    updateNativeConnector(
      record.connectionId,
      {
        revision: record.revision,
        fingerprint: record.configuration.fingerprint,
      },
      nativeVaultClassification,
      (current) => {
        current.configuration.displayName = "Independent metadata";
        return current;
      },
    ),
  );
  expect(before.isConnected).toBe(false);
  expect(button("Cancel sign-in")).toHaveProperty("disabled", false);
  expect(readNativeConnector(record.connectionId)?.status).not.toBe(
    "connected",
  );
  await cancel();
  expect(actual.windows[0]?.close).toHaveBeenCalled();
  expect(actual.onFlash).not.toHaveBeenCalled();
});
