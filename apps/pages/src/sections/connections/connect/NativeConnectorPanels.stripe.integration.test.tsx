/** @vitest-environment jsdom */
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import {
  kvFlush,
  kvForgetAll,
  kvHydrate,
} from "@opensesame/app-core/lib/kv.js";
import { configureNativeApiConnector } from "@opensesame/app-core/lib/native-api-connectors.js";
import { nativeApiTarget } from "@opensesame/app-core/lib/native-api-target.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorPanels } from "./NativeConnectorPanels.js";
import { integrationProvider } from "./native-connector-integration.test-support.js";
import {
  stripeBalance,
  stripeDraft,
  stripeKey,
  stripeOracle,
} from "./native-stripe.test-support.js";

const fixtures: Awaited<ReturnType<typeof stripeOracle>>[] = [];
afterEach(async () => {
  cleanup();
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
});
async function oracle() {
  const value = await stripeOracle();
  fixtures.push(value);
  return value;
}
function mount(connectionId?: string) {
  const onFlash = vi.fn();
  return {
    ...render(
      <MemoryRouter>
        <NativeConnectorPanels
          provider={integrationProvider("stripe")}
          connection={connectionId ? deviceConnection(connectionId) : null}
          onFlash={onFlash}
          onChanged={() => {}}
        />
      </MemoryRouter>,
    ),
    onFlash,
  };
}
async function saved() {
  const driver = nativeConnectorDriver("api-key", "stripe");
  const view = await driver.configure({
    ...stripeDraft,
    method: "api-key",
    requestedScopes: {},
    targetIds: {},
  });
  return {
    driver,
    view,
    read: () => driver.invoke(view.connectionId, "provider.balance.read", {}),
  };
}
it("uses the common key form, real TLS balance read, sealed reload and exact native carrier", async () => {
  const o = await oracle();
  mount();
  expect(screen.queryByText(/unavailable under the product/)).toBeNull();
  expect(screen.queryByText("Managed MCP")).toBeNull();
  expect(screen.getByText(/restricted API key with Balance Read/)).toBeTruthy();
  await userEvent.type(screen.getByLabelText("Stripe API key"), stripeKey);
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Stripe" }),
  );
  await screen.findByRole("button", { name: "Read account balance" });
  expect(screen.getByLabelText("Stripe API key")).toHaveProperty("value", "");
  expect(
    screen.queryByRole("button", { name: "Check Stripe access" }),
  ).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Read account balance" }),
  );
  const region = await screen.findByRole("region", {
    name: "Stripe balance (sandbox); amounts in minor units",
  });
  expect(
    within(region)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Available USD: 1500 minor units", "Pending JPY: -7 minor units"]);
  expect(region.textContent).not.toContain(stripeKey);
  expect([...o.storage.files.values()].join()).not.toContain(stripeKey);
  expect(JSON.stringify(readDeviceRows())).not.toContain(stripeKey);
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  const row = readDeviceRows().find((entry) => entry.providerId === "stripe");
  if (!row) throw new Error("Stripe connection missing after sealed reload");
  const driver = nativeConnectorDriver("api-key", "stripe");
  await driver.verify(row.connectionId);
  expect(
    await driver.invoke(row.connectionId, "provider.balance.read", {}),
  ).toMatchObject({ items: [{ id: "available:usd" }, { id: "pending:jpy" }] });
  expect(o.requests.length).toBeGreaterThanOrEqual(4);
  expect(
    o.requests.every(
      (request) =>
        request.authorized &&
        request.emptyBody &&
        request.path === "/v1/balance",
    ),
  ).toBe(true);
  expect(o.context.egressCalls).toEqual([]);
  expect(o.browser).not.toHaveBeenCalled();
});
it.each([401, 403])(
  "refuses actual HTTP%s without retaining credentials or raw provider errors",
  async (status) => {
    const o = await oracle();
    o.reply({ error: { message: stripeKey } }, status);
    await expect(
      configureNativeApiConnector(stripeDraft),
    ).rejects.toMatchObject({
      code: status === 401 ? "authorization" : "permission",
    });
    expect(readDeviceRows().some((row) => row.providerId === "stripe")).toBe(
      false,
    );
    expect([...o.storage.files.values()].join()).not.toContain(stripeKey);
    expect(o.context.egressCalls).toEqual([]);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it("refuses a wrong entered key at the independent HTTP authorization oracle", async () => {
  const o = await oracle();
  await expect(
    configureNativeApiConnector({
      ...stripeDraft,
      credentials: { api_key: "incorrect-owned-fixture-key" },
    }),
  ).rejects.toMatchObject({
    code: "authorization",
    message:
      "Provider authorization was refused; verify or replace the saved credential",
  });
  expect(o.requests).toEqual([
    { authorized: false, emptyBody: true, path: "/v1/balance" },
  ]);
  expect(readDeviceRows().some((row) => row.providerId === "stripe")).toBe(
    false,
  );
});
it.each([
  { ...stripeBalance, object: "account" },
  { ...stripeBalance, livemode: "false" },
  { ...stripeBalance, available: null },
  { ...stripeBalance, pending: [{ amount: 0.5, currency: "usd" }] },
  {
    ...stripeBalance,
    available: [{ amount: Number.MAX_SAFE_INTEGER + 1, currency: "usd" }],
  },
  { ...stripeBalance, available: [{ amount: 1, currency: "USD" }] },
  { ...stripeBalance, available: [{ amount: 1, currency: stripeKey }] },
  {
    ...stripeBalance,
    pending: [
      { amount: 1, currency: "usd" },
      { amount: 2, currency: "usd" },
    ],
  },
  {
    ...stripeBalance,
    pending: Array.from({ length: 51 }, () => ({ amount: 1, currency: "usd" })),
  },
  { ...stripeBalance, error: { message: stripeKey } },
])("does not call malformed HTTP200 balance verified %#", async (invalid) => {
  const o = await oracle();
  o.reply(invalid);
  await expect(configureNativeApiConnector(stripeDraft)).rejects.toMatchObject({
    code: "response",
    message: "Provider did not return the expected response",
  });
  expect(readDeviceRows().some((row) => row.providerId === "stripe")).toBe(
    false,
  );
});
it("reads actual zero balances and rejects malformed read results after valid authentication", async () => {
  const o = await oracle();
  const s = await saved();
  o.reply({ object: "balance", livemode: true, available: [], pending: [] });
  expect(await s.read()).toEqual({
    label: "Stripe balance (live); amounts in minor units",
    items: [],
  });
  o.reply({ ...stripeBalance, pending: [{ amount: "100", currency: "usd" }] });
  await expect(s.read()).rejects.toMatchObject({ code: "response" });
});
it("does not allow payment writes, arbitrary targets, connected accounts or unclassified fields", async () => {
  const o = await oracle();
  const s = await saved();
  const count = o.requests.length;
  for (const operation of [
    "provider.charge.create",
    "provider.payout.create",
    "provider.balance.write",
  ])
    await expect(
      s.driver.invoke(s.view.connectionId, operation, {}),
    ).rejects.toThrow();
  for (const [field, value] of [
    ["url", "https://other.test"],
    ["account", "acct_other"],
    ["amount", "100"],
  ])
    await expect(
      s.driver.invoke(s.view.connectionId, "provider.balance.read", {
        [field]: value,
      }),
    ).rejects.toThrow();
  expect(() =>
    nativeApiTarget("stripe", { endpoint: "https://other.test" }),
  ).toThrow("public");
  expect(o.requests).toHaveLength(count);
  expect(o.context.egressCalls).toEqual([]);
  expect(o.browser).not.toHaveBeenCalled();
});
it("invalidates saved proof after actual authorization loss without leaking the rejected credential", async () => {
  const o = await oracle();
  const s = await saved();
  o.reply({ error: { message: stripeKey } }, 401);
  await expect(s.read()).rejects.toMatchObject({ code: "authorization" });
  expect(readNativeConnector(s.view.connectionId)?.status).toBe("reauthorize");
  expect(JSON.stringify(readDeviceRows())).not.toContain(stripeKey);
});
it.each(["lease", "node"])(
  "physically drains a pending original TLS body after %s withdrawal, with no browser fallback",
  async (kind) => {
    const o = await oracle();
    const s = await saved();
    const hold = o.hold();
    const pending = s.read();
    const rejected = expect(pending).rejects.toThrow();
    await hold.arrived;
    if (kind === "lease") o.context.abort();
    else o.lifetime.abort();
    await rejected;
    await hold.closed;
    const count = o.requests.length;
    await expect(s.read()).rejects.toThrow();
    expect(o.requests).toHaveLength(count);
    expect(o.context.egressCalls).toEqual([]);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it("unmounting the actual shared action cancels its original TLS read and suppresses stale results", async () => {
  const o = await oracle();
  const s = await saved();
  const page = mount(s.view.connectionId);
  const hold = o.hold();
  await userEvent.click(
    await screen.findByRole("button", { name: "Read account balance" }),
  );
  await hold.arrived;
  page.unmount();
  await hold.closed;
  expect(page.onFlash).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: /Stripe balance/ })).toBeNull();
  expect(o.browser).not.toHaveBeenCalled();
});
