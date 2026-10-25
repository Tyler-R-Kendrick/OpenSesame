/** @vitest-environment jsdom */
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import {
  walletClass,
  walletIssuer,
  walletOrigin,
} from "@opensesame/app-core/lib/native-google-wallet.test-support.js";
import { nativeOAuthGuard } from "@opensesame/app-core/lib/native-oauth-session.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";
import {
  connect,
  fill,
  mount,
  oracle,
  prepare,
} from "./google-wallet-page.test-support.js";
declareConnectionsTutorial();

it("actual Settings verifies issuer/class, seals and cold-restores the key, then offers the signed Google save URL for an explicit user click", async () => {
  const o = await oracle();
  const ui = mount();
  expect(o.requests).toHaveLength(0);
  await connect(o.account);
  expect(o.requests.map((request) => request.stage)).toEqual([
    "token",
    "class",
  ]);
  expect(o.requests.every((request) => request.authorized)).toBe(true);
  const row = readDeviceRows()[0];
  if (!row) throw new Error("Missing proved wallet connection");
  expect(readNativeConnector(row.connectionId)?.status).toBe("connected");
  expect(screen.getByLabelText("Service account JSON key")).toHaveProperty(
    "value",
    "",
  );
  const key = JSON.parse(o.account).private_key;
  expect([...o.fixture.disk.files.values()].join()).not.toContain(key);
  expect([...o.fixture.disk.files.values()].join()).not.toContain(
    "BEGIN PRIVATE KEY",
  );
  expect(JSON.stringify(readDeviceRows())).not.toContain(key);
  ui.unmount();
  await o.fixture.reload();
  mount(row.connectionId);
  expect(screen.getByLabelText("Service account JSON key")).toHaveProperty(
    "value",
    "",
  );
  expect(o.requests).toHaveLength(2);
  await prepare();
  const section = await screen.findByRole("region", {
    name: "Save link prepared",
  });
  const link = within(section).getByRole("link", {
    name: "Save to Google Wallet",
  });
  const href = link.getAttribute("href") ?? "";
  const claims = o.verifySave(href);
  expect(claims).toMatchObject({
    aud: "google",
    typ: "savetowallet",
    origins: [walletOrigin],
    payload: {
      genericObjects: [
        expect.objectContaining({
          classId: walletClass,
          state: "ACTIVE",
          cardTitle: {
            defaultValue: { language: "en-US", value: "Research access" },
          },
          header: {
            defaultValue: { language: "en-US", value: "Operator pass" },
          },
        }),
      ],
    },
  });
  expect(JSON.stringify(claims)).not.toContain(key);
  expect(link).toHaveProperty("target", "_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
  const gestures: string[] = [];
  link.addEventListener("click", (event) => {
    gestures.push(href);
    event.preventDefault();
  });
  await userEvent.click(link);
  expect(gestures).toEqual([href]);
  expect(section.textContent).not.toMatch(
    /created|installed|added|saved successfully/i,
  );
  expect(o.requests.map((request) => request.stage)).toEqual([
    "token",
    "class",
    "token",
    "class",
  ]);
});
it.each([
  { stage: "token", body: {}, status: 401 },
  {
    stage: "token",
    body: { access_token: "short", expires_in: 3600 },
    status: 200,
  },
  { stage: "class", body: {}, status: 403 },
  { stage: "class", body: { id: `${walletIssuer}.foreign` }, status: 200 },
  {
    stage: "class",
    body: { id: walletClass, padding: "x".repeat(65536) },
    status: 200,
  },
] as const)(
  "$stage HTTP$status malformed/refused responses never save a fake proved issuer",
  async ({ stage, body, status }) => {
    const o = await oracle();
    o.reply(stage, body, status);
    const ui = mount();
    await fill(o.account);
    await waitFor(() => expect(ui.onFlash).toHaveBeenCalled());
    expect(readDeviceRows()).toHaveLength(0);
    expect(o.requests.map((request) => request.stage)).toEqual(
      stage === "token" ? ["token"] : ["token", "class"],
    );
    expect(
      screen.queryByText("Prepare a Google Wallet pass", {
        selector: "summary",
      }),
    ).toBeNull();
    expect(JSON.stringify(ui.onFlash.mock.calls)).not.toContain(
      JSON.parse(o.account).private_key,
    );
  },
);
it.each(["activation", "vault", "caller", "unmount"])(
  "%s withdrawal physically closes token work and cannot publish a late save link",
  async (kind) => {
    const o = await oracle();
    const ui = mount();
    await connect(o.account);
    const row = readDeviceRows()[0];
    if (!row) throw new Error("Missing saved connection");
    const held = o.hold("token");
    const caller = new AbortController();
    const driver = nativeConnectorDriver("api-key", "google-wallet");
    const pending =
      kind === "caller"
        ? driver.invoke(
            row.connectionId,
            "provider.pass.prepare",
            { title: "Research access", header: "Operator pass" },
            caller.signal,
          )
        : null;
    const rejected = pending ? expect(pending).rejects.toThrow() : null;
    if (!pending) await prepare();
    await held.arrived.promise;
    const started = Date.now();
    if (kind === "activation") o.fixture.activation.dispose();
    if (kind === "vault") vaultStore.lock();
    if (kind === "caller") caller.abort();
    if (kind === "unmount") ui.unmount();
    if (rejected) await rejected;
    await held.closed.promise;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(o.requests.map((request) => request.stage)).toEqual([
      "token",
      "class",
      "token",
    ]);
    expect(
      screen.queryByRole("link", { name: "Save to Google Wallet" }),
    ).toBeNull();
  },
);
it.each(["configuration", "grant"])(
  "a saved %s replacement during token response prevents any later class request or link",
  async (kind) => {
    const o = await oracle();
    mount();
    await connect(o.account);
    const row = readDeviceRows()[0];
    if (!row) throw new Error("Missing saved wallet");
    const saved = loadNativeConnectorRecord(row.connectionId);
    if (!saved) throw new Error("Missing private record");
    const held = o.hold("token");
    const driver = nativeConnectorDriver("api-key", "google-wallet");
    const pending = driver.invoke(row.connectionId, "provider.pass.prepare", {
      title: "Research access",
      header: "Operator pass",
    });
    const rejected = expect(pending).rejects.toThrow();
    await held.arrived.promise;
    await updateNativeConnector(
      row.connectionId,
      nativeOAuthGuard(saved),
      {
        publicParameters: ["issuer_id", "class_id", "origin", "client_email"],
        privateCredentials: ["service_account_json"],
      },
      (current) => ({
        ...current,
        ...(kind === "configuration"
          ? {
              configuration: {
                ...current.configuration,
                displayName: "Changed issuer record",
              },
            }
          : { privateState: { ...current.privateState, grants: {} } }),
      }),
    );
    held.release();
    await rejected;
    expect(o.requests.map((request) => request.stage)).toEqual([
      "token",
      "class",
      "token",
    ]);
  },
);

it("an independently rejected RSA key cannot save a fake issuer", async () => {
  const o = await oracle();
  const ui = mount();
  await fill(o.wrongAccount());
  await waitFor(() => expect(ui.onFlash).toHaveBeenCalled());
  expect(readDeviceRows()).toHaveLength(0);
  expect(
    o.requests.map((request) => [request.stage, request.authorized]),
  ).toEqual([["token", false]]);
});
it("payload screening rejects secret-shaped public fields instead of publishing a signed link", async () => {
  const o = await oracle();
  mount();
  await connect(o.account);
  await userEvent.click(
    screen.getByText("Prepare a Google Wallet pass", { selector: "summary" }),
  );
  await userEvent.type(
    screen.getByLabelText("Public pass title"),
    "Bearer eyJhbGciOiJSUzI1NiJ9.private.signature",
  );
  await userEvent.type(
    screen.getByLabelText("Public pass header"),
    "Operator pass",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Prepare a Google Wallet pass" }),
  );
  await screen.findByRole("img", {
    name: /Provider did not return the expected response/,
  });
  expect(
    screen.queryByRole("link", { name: "Save to Google Wallet" }),
  ).toBeNull();
});

it.each(["unmount", "activation", "vault"] as const)(
  "%s withdrawal during issuer configuration closes actual token work before a connection can publish",
  async (kind) => {
    const o = await oracle();
    const ui = mount();
    const held = o.hold("token");
    await fill(o.account);
    await held.arrived.promise;
    if (kind === "unmount") ui.unmount();
    else if (kind === "activation") o.fixture.activation.dispose();
    else vaultStore.lock();
    await held.closed.promise;
    held.release();
    expect(readDeviceRows()).toHaveLength(0);
    expect(ui.onFlash.mock.calls.some(([flash]) => flash.tone === "ok")).toBe(
      false,
    );
  },
);

it("Disconnect uses the original activation cleanup after the successful configuration caller has retired", async () => {
  const o = await oracle();
  mount();
  await connect(o.account);
  await userEvent.click(
    screen.getByRole("button", { name: "Remove connector" }),
  );
  await userEvent.click(
    screen.getByRole("button", {
      name: "Confirm remove connector",
    }),
  );
  await waitFor(() => expect(readDeviceRows()).toHaveLength(0));
  expect(o.requests.map((request) => request.stage)).toEqual([
    "token",
    "class",
  ]);
});
