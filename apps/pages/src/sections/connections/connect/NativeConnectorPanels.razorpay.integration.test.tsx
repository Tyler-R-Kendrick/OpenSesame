/** @vitest-environment jsdom */
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import {
  kvFlush,
  kvForgetAll,
  kvHydrate,
} from "@opensesame/app-core/lib/kv.js";
import {
  type NativeApiConfigureInput,
  configureNativeApiConnector,
} from "@opensesame/app-core/lib/native-api-connectors.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  hasConnectRoute,
  mergeVercelCatalog,
} from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";
import { stripeOracle } from "./native-stripe.test-support.js";

const keyID = "rzp_test_ownedKeyID";
const keySecret = "razorpay-owned:separate~secret";
const wireCredential = btoa(`${keyID}:${keySecret}`);
const payment = {
  entity: "payment",
  id: "pay_first",
  status: "captured",
  currency: "INR",
  amount: 1500,
};
const payments = { entity: "collection", count: 1, items: [payment] };
const draft = {
  providerId: "razorpay",
  displayName: "Read-only payments",
  parameters: {},
  credentials: { api_key: keyID, key_secret: keySecret },
};
declareConnectionsTutorial();
const fixtures: Awaited<ReturnType<typeof stripeOracle>>[] = [];
afterEach(async () => {
  cleanup();
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
});
async function oracle() {
  const o = await stripeOracle("/v1/payments?count=20&skip=0", {
    origin: "https://api.razorpay.com",
    authorization: `Basic ${wireCredential}`,
    headers: {},
    absentHeaders: ["x-razorpay-account", "stripe-version"],
    reply: payments,
  });
  fixtures.push(o);
  return o;
}
function mount(id?: string) {
  const onFlash = vi.fn();
  const provider = mergeVercelCatalog(getBundledProviders()).find(
    (row) => row.id === "razorpay",
  );
  if (!provider) throw new Error("Missing actual Razorpay catalog provider");
  expect(hasConnectRoute(provider.id)).toBe(true);
  return {
    ...render(
      <MemoryRouter initialEntries={["/settings/connections/razorpay"]}>
        <ConnectorSettingsPage
          provider={provider}
          providerId={provider.id}
          connection={id ? deviceConnection(id) : null}
          connections={[]}
          loading={false}
          online
          canConfigure
          configureHint=""
          flash={null}
          rememberOffer={null}
          onFlash={onFlash}
          onRememberOffer={() => {}}
          onChanged={() => {}}
        />
      </MemoryRouter>,
    ),
    onFlash,
  };
}
async function fill() {
  await userEvent.type(screen.getByLabelText("Razorpay API key"), keyID);
  await userEvent.type(screen.getByLabelText("Key Secret"), keySecret);
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Razorpay" }),
  );
}
async function saved() {
  const view = await configureNativeApiConnector(draft);
  const driver = nativeConnectorDriver("api-key", "razorpay");
  return {
    view,
    driver,
    read: (signal?: AbortSignal) =>
      driver.invoke(view.connectionId, "provider.payments.read", {}, signal),
  };
}
it("reaches the common real Settings form, seals/reloads both Basic credentials and reads safe payment summaries over TLS", async () => {
  const o = await oracle();
  mount();
  expect(screen.getAllByRole("heading", { name: "2 Connect" })).toHaveLength(1);
  expect(screen.queryByRole("img", { name: "Not available here" })).toBeNull();
  expect(screen.queryByText(/unavailable under the product/)).toBeNull();
  expect(screen.queryByText("Managed MCP")).toBeNull();
  expect(screen.getByText(/Enter your Key ID/)).toBeTruthy();
  expect(screen.getByLabelText("Razorpay API key")).toHaveProperty(
    "type",
    "password",
  );
  expect(screen.getByLabelText("Key Secret")).toHaveProperty(
    "type",
    "password",
  );
  await fill();
  await screen.findByRole("button", { name: "List payments" });
  expect(screen.getByLabelText("Razorpay API key")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Key Secret")).toHaveProperty("value", "");
  o.reply({
    ...payments,
    items: [
      {
        ...payment,
        email: "private@example.test",
        contact: "private-contact",
        card: { number: "private-card" },
        bank: "private-bank",
        upi: { vpa: "private-upi" },
        notes: { private: "private-notes" },
      },
    ],
  });
  await userEvent.click(screen.getByRole("button", { name: "List payments" }));
  const region = await screen.findByRole("region", {
    name: "Showing 1 payments from first page; amounts in minor units",
  });
  expect(
    within(region)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["pay_first — captured (INR 1500 minor units)"]);
  for (const secret of [
    keyID,
    keySecret,
    wireCredential,
    "private@example.test",
    "private-contact",
    "private-card",
    "private-bank",
    "private-upi",
    "private-notes",
  ])
    expect(region.textContent).not.toContain(secret);
  for (const secret of [keyID, keySecret, wireCredential]) {
    expect([...o.storage.files.values()].join()).not.toContain(secret);
    expect(JSON.stringify(readDeviceRows())).not.toContain(secret);
  }
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  const row = readDeviceRows().find((entry) => entry.providerId === "razorpay");
  if (!row) throw new Error("Missing sealed Razorpay connection");
  const driver = nativeConnectorDriver("api-key", "razorpay");
  await driver.verify(row.connectionId);
  expect(
    await driver.invoke(row.connectionId, "provider.payments.read", {}),
  ).toMatchObject({ items: [{ id: "pay_first" }] });
  expect(
    o.requests.every(
      (request) =>
        request.authorized &&
        request.emptyBody &&
        request.path === "/v1/payments?count=20&skip=0",
    ),
  ).toBe(true);
  expect(o.context.egressCalls).toEqual([]);
  expect(o.browser).not.toHaveBeenCalled();
});
it.each([401, 403])(
  "renders an accurate HTTP%s failure on the real Settings form without saving credentials or reflected errors",
  async (status) => {
    const o = await oracle();
    o.reply(
      { error: { description: `${keyID} ${keySecret} ${wireCredential}` } },
      status,
    );
    const page = mount();
    await fill();
    await screen.findByRole("img", {
      name:
        status === 401
          ? /Provider authorization was refused/
          : /Provider permissions do not allow/,
    });
    expect(readDeviceRows().some((row) => row.providerId === "razorpay")).toBe(
      false,
    );
    expect(page.onFlash).toHaveBeenCalledExactlyOnceWith({
      tone: "err",
      text:
        status === 401
          ? "Provider authorization was refused; verify or replace the saved credential"
          : "Provider permissions do not allow this operation",
    });
    for (const secret of [keyID, keySecret, wireCredential]) {
      expect(document.body.textContent).not.toContain(secret);
      expect(JSON.stringify(page.onFlash.mock.calls)).not.toContain(secret);
    }
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it.each(["api_key", "key_secret"])(
  "rejects a wrong %s at the independent native HTTPS Basic oracle",
  async (field) => {
    const o = await oracle();
    await expect(
      configureNativeApiConnector({
        ...draft,
        credentials: {
          ...draft.credentials,
          [field]: "incorrect-owned-credential",
        },
      }),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(o.requests).toEqual([
      {
        authorized: false,
        emptyBody: true,
        path: "/v1/payments?count=20&skip=0",
      },
    ]);
    expect(readDeviceRows().some((row) => row.providerId === "razorpay")).toBe(
      false,
    );
  },
);
it("requires both credentials and never accepts secret material as public configuration", async () => {
  const o = await oracle();
  const missingCredentials: NativeApiConfigureInput["credentials"][] = [
    { api_key: keyID },
    { key_secret: keySecret },
  ];
  for (const credentials of missingCredentials)
    await expect(
      configureNativeApiConnector({ ...draft, credentials }),
    ).rejects.toThrow("required provider credentials");
  await expect(
    configureNativeApiConnector({
      ...draft,
      parameters: { key_secret: keySecret },
    }),
  ).rejects.toThrow("public configuration");
  expect(o.requests).toEqual([]);
});
it.each([
  { ...payments, entity: "account" },
  { ...payments, count: "1" },
  { ...payments, count: 0 },
  { ...payments, count: -1 },
  { ...payments, items: null },
  { ...payments, items: [{ ...payment, entity: "refund" }] },
  { ...payments, items: [{ ...payment, id: keyID }] },
  { ...payments, items: [{ ...payment, status: "unknown" }] },
  { ...payments, items: [{ ...payment, currency: "inr" }] },
  { ...payments, items: [{ ...payment, amount: "1500" }] },
  { ...payments, items: [{ ...payment, amount: 1.5 }] },
  { ...payments, items: [{ ...payment, amount: -1 }] },
  { ...payments, items: [{ ...payment, amount: Number.MAX_SAFE_INTEGER + 1 }] },
  { ...payments, count: 2, items: [payment, payment] },
  {
    ...payments,
    count: 21,
    items: Array.from({ length: 21 }, (_, i) => ({
      ...payment,
      id: `pay_item${i}`,
    })),
  },
  { ...payments, error: { description: keySecret } },
])(
  "never marks malformed HTTP200 payment inventory verified %#",
  async (invalid) => {
    const o = await oracle();
    o.reply(invalid);
    await expect(configureNativeApiConnector(draft)).rejects.toMatchObject({
      code: "response",
      message: "Provider did not return the expected response",
    });
    expect(readDeviceRows().some((row) => row.providerId === "razorpay")).toBe(
      false,
    );
  },
);
it("accepts an empty bounded first page without claiming a total or exposing additional operations", async () => {
  const o = await oracle();
  o.reply({ entity: "collection", count: 0, items: [] });
  const s = await saved();
  expect(await s.read()).toEqual({
    label: "Showing 0 payments from first page; amounts in minor units",
    items: [],
  });
  const count = o.requests.length;
  for (const operation of [
    "provider.payment.capture",
    "provider.refunds.create",
    "provider.issuing-cards.read",
  ])
    await expect(
      s.driver.invoke(s.view.connectionId, operation, {}),
    ).rejects.toThrow();
  for (const [field, value] of Object.entries({
    url: "https://other.test",
    count: "100",
    expand: "card",
    payment_id: "pay_other",
  }))
    await expect(
      s.driver.invoke(s.view.connectionId, "provider.payments.read", {
        [field]: value,
      }),
    ).rejects.toThrow();
  expect(o.requests).toHaveLength(count);
});
it("withdraws retained proof after real authorization loss without browser fallback", async () => {
  const o = await oracle();
  const s = await saved();
  o.reply({ error: { description: keySecret } }, 401);
  await expect(s.read()).rejects.toMatchObject({ code: "authorization" });
  expect(readNativeConnector(s.view.connectionId)?.status).toBe("reauthorize");
  expect(o.browser).not.toHaveBeenCalled();
});
it.each(["lease", "node", "vault", "caller"])(
  "drains the actual held TLS body on %s withdrawal",
  async (kind) => {
    const o = await oracle();
    const s = await saved();
    const caller = new AbortController();
    const hold = o.hold();
    const pending = s.read(caller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await hold.arrived;
    if (kind === "lease") o.context.abort();
    if (kind === "node") o.lifetime.abort();
    if (kind === "vault") vaultStore.lock({ recordLastVault: false });
    if (kind === "caller") caller.abort();
    await rejected;
    await hold.closed;
    if (kind !== "caller") {
      const count = o.requests.length;
      await expect(s.read()).rejects.toThrow();
      expect(o.requests).toHaveLength(count);
    }
    expect(o.context.egressCalls).toEqual([]);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it("unmounting the actual Settings common action cancels its original TLS stream without a stale result", async () => {
  const o = await oracle();
  const s = await saved();
  const page = mount(s.view.connectionId);
  const hold = o.hold();
  await userEvent.click(
    await screen.findByRole("button", { name: "List payments" }),
  );
  await hold.arrived;
  page.unmount();
  await hold.closed;
  expect(page.onFlash).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("region", { name: /payments from first page/ }),
  ).toBeNull();
  expect(o.browser).not.toHaveBeenCalled();
});
