import { configureHost, host } from "@opensesame/app-core/host.js";
import { webLocksDouble } from "@opensesame/app-core/lib/__tests__/web-locks-double.js";
/** @vitest-environment jsdom */
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { readDeviceSecrets } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  deviceConnection,
  listDeviceConnections,
} from "@opensesame/app-core/lib/device-connectors.js";
import * as kv from "@opensesame/app-core/lib/kv.js";
import { applyLinearClientId } from "@opensesame/app-core/lib/linear-connectors.js";
import { linearApiSeams } from "@opensesame/app-core/lib/linear-http.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LinearConnectorForm } from "./LinearConnectorForm.js";
import { LinearConnectorSummary } from "./LinearConnectorSummary.js";
import { linearUiAccount, linearUiResponse } from "./linear-ui.test-support.js";

const foundPlan = connectPlan("linear");
if (!foundPlan) throw new Error("Linear plan required");
const plan = foundPlan;
const originalFetch = linearApiSeams.fetch;
const originalHost = host();
let release: () => void = () => undefined;

beforeEach(() => {
  configureHost({ ...originalHost, locks: overlapCast(webLocksDouble()) });
  kv.kvForgetAll();
  const memory = new Map<string, string>();
  vi.spyOn(kv.kvSeams, "kvGet").mockImplementation(
    (key) => memory.get(key) ?? null,
  );
  vi.spyOn(kv.kvSeams, "kvSetDurable").mockImplementation(
    async (key, value) => {
      memory.set(key, value);
    },
  );
  vi.spyOn(kv, "kvDurability").mockReturnValue("persistent");
  vi.spyOn(kv, "kvRefresh").mockResolvedValue(undefined);
  applyLinearClientId("registered-client");
});
afterEach(() => {
  cleanup();
  release();
  linearApiSeams.fetch = originalFetch;
  applyLinearClientId(undefined);
  kv.kvForgetAll();
  vi.restoreAllMocks();
  configureHost(originalHost);
});

function pendingConsent() {
  let reject: ((reason: Error) => void) | undefined;
  const authorize = vi.fn(
    () =>
      new Promise<string>((_resolve, refused) => {
        reject = refused;
      }),
  );
  const cancelAuthorization = vi.fn(() =>
    reject?.(new Error("Sign-in cancelled")),
  );
  release = bindNativeOAuthBrowserPort({
    redirectUri: "https://app.example.test/auth/native-connector.html",
    navigate: vi.fn(),
    scrubCallback: vi.fn(),
    prepareAuthorization: () => vi.fn(),
    authorize,
    cancelAuthorization,
  });
  return { authorize, cancelAuthorization };
}

async function cancelFirstConsent() {
  const port = pendingConsent();
  const onFlash = vi.fn();
  const onSaved = vi.fn();
  render(
    <LinearConnectorForm plan={plan} onFlash={onFlash} onSaved={onSaved} />,
  );
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Create and authorize Linear" }),
  );
  await waitFor(() => expect(port.authorize).toHaveBeenCalledOnce());
  await userEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull(),
  );
  expect(port.cancelAuthorization).toHaveBeenCalledOnce();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onFlash).not.toHaveBeenCalledWith(
    expect.objectContaining({ tone: "ok" }),
  );
  return port;
}

it("cancels initial Linear consent and enables another originating click without claiming a connection", async () => {
  const port = await cancelFirstConsent();
  const first = listDeviceConnections()[0];
  if (!first) throw new Error("Saved Linear configuration required");
  expect(listDeviceConnections()).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Save and authorize Linear" }),
  ).toHaveProperty("disabled", false);
  await userEvent.click(
    screen.getByRole("button", { name: "Save and authorize Linear" }),
  );
  await waitFor(() => expect(port.authorize).toHaveBeenCalledTimes(2));
  await userEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull(),
  );
  expect(listDeviceConnections()).toHaveLength(1);
  expect(listDeviceConnections()[0]?.connectionId).toBe(first.connectionId);
  expect(deviceConnection(first.connectionId)?.status).not.toBe("active");
  expect(
    readDeviceSecrets()[first.connectionId]?.linear_pending,
  ).toBeUndefined();
});

it("reuses the initial saved configuration after provider denial with fresh consent state and no false success", async () => {
  const states: string[] = [];
  const authorize = vi.fn(async (_url: string, options: { state: string }) => {
    states.push(options.state);
    return new URLSearchParams({
      native_state: options.state,
      native_error: "access_denied",
    }).toString();
  });
  release = bindNativeOAuthBrowserPort({
    redirectUri: "https://app.example.test/auth/native-connector.html",
    navigate: vi.fn(),
    scrubCallback: vi.fn(),
    prepareAuthorization: () => vi.fn(),
    authorize,
  });
  const fetch = vi.fn<typeof linearApiSeams.fetch>();
  linearApiSeams.fetch = fetch;
  const onSaved = vi.fn();
  const onFlash = vi.fn();
  render(
    <LinearConnectorForm plan={plan} onFlash={onFlash} onSaved={onSaved} />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Create and authorize Linear" }),
  );
  await waitFor(() =>
    expect(onFlash).toHaveBeenCalledWith({
      tone: "err",
      text: "Linear authorization was declined; your connector is not authorized",
    }),
  );
  const first = listDeviceConnections()[0];
  if (!first) throw new Error("Saved Linear configuration required");
  await userEvent.click(
    screen.getByRole("button", { name: "Save and authorize Linear" }),
  );
  await waitFor(() => expect(onFlash).toHaveBeenCalledTimes(2));
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(states).toHaveLength(2);
  expect(states[0]).not.toBe(states[1]);
  expect(listDeviceConnections()).toHaveLength(1);
  expect(listDeviceConnections()[0]?.connectionId).toBe(first.connectionId);
  expect(deviceConnection(first.connectionId)?.status).not.toBe("active");
  expect(
    readDeviceSecrets()[first.connectionId]?.linear_pending,
  ).toBeUndefined();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onFlash).not.toHaveBeenCalledWith(
    expect.objectContaining({ tone: "ok" }),
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("cancels explicit actor consent renewal and keeps connector removal separate", async () => {
  const port = await cancelFirstConsent();
  cleanup();
  const saved = listDeviceConnections()[0];
  if (!saved) throw new Error("Durable draft required");
  const connection = deviceConnection(saved.connectionId);
  if (!connection) throw new Error("Saved connection required");
  const onChanged = vi.fn();
  render(
    <LinearConnectorSummary
      connection={connection}
      onFlash={vi.fn()}
      onChanged={onChanged}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Authorize application" }),
  );
  await waitFor(() => expect(port.authorize).toHaveBeenCalledTimes(2));
  await userEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(port.cancelAuthorization).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Remove connector" }),
  );
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Confirm remove connector" }),
  ).toBeTruthy();
});

it("does not offer consent cancellation while verifying a Linear API key", async () => {
  const port = pendingConsent();
  let complete: ((response: Response) => void) | undefined;
  linearApiSeams.fetch = () =>
    new Promise<Response>((done) => {
      complete = done;
    });
  const onSaved = vi.fn();
  render(
    <LinearConnectorForm plan={plan} onFlash={vi.fn()} onSaved={onSaved} />,
  );
  await userEvent.click(screen.getByRole("radio", { name: "Bring Your Own" }));
  await userEvent.click(screen.getByRole("radio", { name: "API key" }));
  await userEvent.type(
    screen.getByLabelText("Linear API key"),
    "lin_api_test-only",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Linear" }),
  );
  await waitFor(() => expect(complete).toBeTruthy());
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  expect(port.authorize).not.toHaveBeenCalled();
  complete?.(linearUiResponse(linearUiAccount));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
});
