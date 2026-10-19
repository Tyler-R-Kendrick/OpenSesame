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
import { configureNativeApiConnector } from "@opensesame/app-core/lib/native-api-connectors.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
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
import { stripeKey, stripeOracle } from "./native-stripe.test-support.js";

const card = {
  object: "issuing.card",
  id: "ic_first",
  status: "active",
  type: "virtual",
  currency: "usd",
};
const cards = {
  object: "list",
  url: "/v1/issuing/cards",
  has_more: false,
  data: [card],
};
const draft = {
  providerId: "stripe-issuing",
  displayName: "Read-only Issuing inventory",
  parameters: {},
  credentials: { api_key: stripeKey },
};
declareConnectionsTutorial();

const fixtures: Awaited<ReturnType<typeof stripeOracle>>[] = [];
afterEach(async () => {
  cleanup();
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
});
async function oracle() {
  const o = await stripeOracle("/v1/issuing/cards?limit=20");
  fixtures.push(o);
  o.reply(cards);
  return o;
}
function mount(id?: string) {
  const onFlash = vi.fn();
  const provider = mergeVercelCatalog(getBundledProviders()).find(
    (row) => row.id === "stripe-issuing",
  );
  if (!provider) throw new Error("Missing actual bundled Issuing provider");
  expect(hasConnectRoute(provider.id)).toBe(true);
  return {
    ...render(
      <MemoryRouter initialEntries={["/settings/connections/stripe-issuing"]}>
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
async function saved() {
  const view = await configureNativeApiConnector(draft);
  const driver = nativeConnectorDriver("api-key", "stripe-issuing");
  return {
    view,
    driver,
    read: () =>
      driver.invoke(view.connectionId, "provider.issuing-cards.read", {}),
  };
}
it("configures the common Issuing form, seals/reloads its key and reads only bounded card summaries over TLS", async () => {
  const o = await oracle();
  mount();
  expect(screen.getAllByRole("heading", { name: "2 Connect" })).toHaveLength(1);
  expect(screen.queryByRole("img", { name: "Not available here" })).toBeNull();
  expect(screen.queryByText(/unavailable under the product/)).toBeNull();
  expect(screen.queryByText("Managed MCP")).toBeNull();
  expect(screen.getByText(/Issuing Cards Read permission/)).toBeTruthy();
  await userEvent.type(
    screen.getByLabelText("Stripe Issuing API key"),
    stripeKey,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Stripe Issuing" }),
  );
  await screen.findByRole("button", { name: "List Issuing cards" });
  expect(screen.getByLabelText("Stripe Issuing API key")).toHaveProperty(
    "value",
    "",
  );
  o.reply({
    ...cards,
    has_more: true,
    data: [
      {
        ...card,
        number: "private-pan-sentinel",
        cvc: "private-cvc-sentinel",
        cardholder: { email: "private-holder@example.test" },
        metadata: { private: "private-metadata-sentinel" },
      },
    ],
  });
  await userEvent.click(
    screen.getByRole("button", { name: "List Issuing cards" }),
  );
  const region = await screen.findByRole("region", {
    name: "Showing 1 Issuing cards from first page; more available",
  });
  expect(
    within(region)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["ic_first — active (virtual)"]);
  for (const secret of [
    stripeKey,
    "private-pan-sentinel",
    "private-cvc-sentinel",
    "private-holder@example.test",
    "private-metadata-sentinel",
  ])
    expect(region.textContent).not.toContain(secret);
  expect([...o.storage.files.values()].join()).not.toContain(stripeKey);
  expect(JSON.stringify(readDeviceRows())).not.toContain(stripeKey);
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  const row = readDeviceRows().find(
    (entry) => entry.providerId === "stripe-issuing",
  );
  if (!row) throw new Error("Missing sealed Issuing connection");
  const driver = nativeConnectorDriver("api-key", "stripe-issuing");
  await driver.verify(row.connectionId);
  expect(
    await driver.invoke(row.connectionId, "provider.issuing-cards.read", {}),
  ).toMatchObject({ items: [{ id: "ic_first" }] });
  expect(
    o.requests.every(
      (request) =>
        request.authorized &&
        request.emptyBody &&
        request.path === "/v1/issuing/cards?limit=20",
    ),
  ).toBe(true);
  expect(o.context.egressCalls).toEqual([]);
  expect(o.browser).not.toHaveBeenCalled();
});
it.each([401, 403])(
  "rejects actual HTTP%s without storing key or reflected provider error",
  async (status) => {
    const o = await oracle();
    o.reply({ error: { message: stripeKey } }, status);
    await expect(configureNativeApiConnector(draft)).rejects.toMatchObject({
      code: status === 401 ? "authorization" : "permission",
    });
    expect(
      readDeviceRows().some((row) => row.providerId === "stripe-issuing"),
    ).toBe(false);
    expect([...o.storage.files.values()].join()).not.toContain(stripeKey);
  },
);
it("refuses a wrong key at the independent native HTTPS header oracle", async () => {
  const o = await oracle();
  await expect(
    configureNativeApiConnector({
      ...draft,
      credentials: { api_key: "incorrect-owned-key" },
    }),
  ).rejects.toMatchObject({ code: "authorization" });
  expect(o.requests).toEqual([
    { authorized: false, emptyBody: true, path: "/v1/issuing/cards?limit=20" },
  ]);
  expect(
    readDeviceRows().some((row) => row.providerId === "stripe-issuing"),
  ).toBe(false);
});
it.each([
  { ...cards, object: "account" },
  { ...cards, url: "https://other.test/next" },
  { ...cards, has_more: "false" },
  { ...cards, data: null },
  { ...cards, data: [{ ...card, object: "cardholder" }] },
  { ...cards, data: [{ ...card, id: "" }] },
  { ...cards, data: [{ ...card, id: stripeKey }] },
  { ...cards, data: [{ ...card, status: "" }] },
  { ...cards, data: [{ ...card, type: "virtual\n" }] },
  { ...cards, data: [{ ...card, currency: "USD" }] },
  { ...cards, data: [card, card] },
  {
    ...cards,
    data: Array.from({ length: 21 }, (_, i) => ({
      ...card,
      id: `ic_card${i}`,
    })),
  },
  { ...cards, error: { message: stripeKey } },
])(
  "never calls malformed HTTP200 Issuing inventory verified %#",
  async (invalid) => {
    const o = await oracle();
    o.reply(invalid);
    await expect(configureNativeApiConnector(draft)).rejects.toMatchObject({
      code: "response",
      message: "Provider did not return the expected response",
    });
    expect(
      readDeviceRows().some((row) => row.providerId === "stripe-issuing"),
    ).toBe(false);
  },
);
it("accepts an empty real first page and additive status/type codes without authorizing spending", async () => {
  const o = await oracle();
  o.reply({ ...cards, data: [] });
  const s = await saved();
  expect(await s.read()).toEqual({
    label: "Showing 0 Issuing cards",
    items: [],
  });
  o.reply({
    ...cards,
    data: [{ ...card, status: "awaiting_review", type: "new_card_type" }],
  });
  expect(await s.read()).toEqual({
    label: "Showing 1 Issuing cards",
    items: [
      { id: "ic_first", label: "ic_first — awaiting_review (new_card_type)" },
    ],
  });
});
it("rejects a retained resource field reflecting the sealed credential before any result can render", async () => {
  const o = await oracle();
  const s = await saved();
  o.reply({ ...cards, data: [{ ...card, status: stripeKey }] });
  await expect(s.read()).rejects.toThrow();
  expect(o.browser).not.toHaveBeenCalled();
});
it("rejects arbitrary fields, card creation/retrieval and cross-provider balance operations before network", async () => {
  const o = await oracle();
  const s = await saved();
  const count = o.requests.length;
  for (const operation of [
    "provider.issuing-cards.create",
    "provider.issuing-card.read",
    "provider.balance.read",
  ])
    await expect(
      s.driver.invoke(s.view.connectionId, operation, {}),
    ).rejects.toThrow();
  for (const [field, value] of Object.entries({
    url: "https://other.test",
    expand: "number",
    stripe_account: "acct_other",
    card_id: "ic_other",
  }))
    await expect(
      s.driver.invoke(s.view.connectionId, "provider.issuing-cards.read", {
        [field]: value,
      }),
    ).rejects.toThrow();
  expect(o.requests).toHaveLength(count);
  expect(o.context.egressCalls).toEqual([]);
  expect(o.browser).not.toHaveBeenCalled();
});
it("invalidates retained proof after real auth loss and never falls back to browser fetch", async () => {
  const o = await oracle();
  const s = await saved();
  o.reply({ error: { message: stripeKey } }, 401);
  await expect(s.read()).rejects.toMatchObject({ code: "authorization" });
  expect(readNativeConnector(s.view.connectionId)?.status).toBe("reauthorize");
  expect(o.browser).not.toHaveBeenCalled();
});
it.each(["lease", "node"])(
  "drains the actual held TLS socket on %s withdrawal",
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
it("unmounting its actual common action cancels the original TLS stream with no stale result", async () => {
  const o = await oracle();
  const s = await saved();
  const page = mount(s.view.connectionId);
  const hold = o.hold();
  await userEvent.click(
    await screen.findByRole("button", { name: "List Issuing cards" }),
  );
  await hold.arrived;
  page.unmount();
  await hold.closed;
  expect(page.onFlash).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: /Issuing cards/ })).toBeNull();
  expect(o.browser).not.toHaveBeenCalled();
});
