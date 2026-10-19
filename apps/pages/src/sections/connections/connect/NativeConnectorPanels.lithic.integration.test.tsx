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

const key = "lithic-owned:read-only~key";
const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const card = { token, state: "OPEN", type: "VIRTUAL" };
const cards = { data: [card], has_more: false };
function draft(environment = "sandbox") {
  return {
    providerId: "lithic",
    displayName: "Read-only card inventory",
    parameters: { credential_variant: environment },
    credentials: { api_key: key },
  };
}
declareConnectionsTutorial();
const fixtures: Awaited<ReturnType<typeof stripeOracle>>[] = [];
afterEach(async () => {
  cleanup();
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
});
async function oracle(environment = "sandbox") {
  const o = await stripeOracle("/v1/cards?page_size=20", {
    origin: `https://${environment === "sandbox" ? "sandbox" : "api"}.lithic.com`,
    authorization: key,
    headers: { "api-version": "2026-07-01" },
    absentHeaders: ["lithic-version", "stripe-version"],
    reply: cards,
  });
  fixtures.push(o);
  return o;
}
function mount(id?: string) {
  const onFlash = vi.fn();
  const provider = mergeVercelCatalog(getBundledProviders()).find(
    (row) => row.id === "lithic",
  );
  if (!provider) throw new Error("Missing actual Lithic catalog provider");
  expect(hasConnectRoute(provider.id)).toBe(true);
  return {
    ...render(
      <MemoryRouter initialEntries={["/settings/connections/lithic"]}>
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
async function fill(environment = "sandbox") {
  await userEvent.selectOptions(
    screen.getByLabelText("Credential type"),
    environment,
  );
  await userEvent.type(
    screen.getByLabelText(
      `Lithic ${environment === "sandbox" ? "Sandbox" : "Production"}`,
    ),
    key,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Lithic" }),
  );
}
async function saved() {
  const view = await configureNativeApiConnector(draft());
  const driver = nativeConnectorDriver("api-key", "lithic");
  return {
    view,
    driver,
    read: (signal?: AbortSignal) =>
      driver.invoke(view.connectionId, "provider.cards.read", {}, signal),
  };
}
it.each(["sandbox", "production"])(
  "saves through the common %s form, cold-reloads sealed credentials and consumes safe TLS inventory",
  async (environment) => {
    const o = await oracle(environment);
    mount();
    expect(screen.getByLabelText("Credential type")).toHaveProperty(
      "value",
      "sandbox",
    );
    expect(
      screen.queryByRole("img", { name: "Not available here" }),
    ).toBeNull();
    expect(screen.queryByText("Managed MCP")).toBeNull();
    await fill(environment);
    await screen.findByRole("button", { name: "List cards" });
    expect(
      screen.getByLabelText(
        `Lithic ${environment === "sandbox" ? "Sandbox" : "Production"}`,
      ),
    ).toHaveProperty("value", "");
    o.reply({
      ...cards,
      data: [
        {
          ...card,
          pan: "private-pan",
          cvv: "private-cvv",
          memo: "private-memo",
          account_token: "private-account",
        },
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "List cards" }));
    const region = await screen.findByRole("region", {
      name: "Showing 1 cards from first page",
    });
    expect(
      within(region)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([`${token} — OPEN (VIRTUAL)`]);
    for (const secret of [
      key,
      "private-pan",
      "private-cvv",
      "private-memo",
      "private-account",
    ])
      expect(region.textContent).not.toContain(secret);
    expect([...o.storage.files.values()].join()).not.toContain(key);
    expect(JSON.stringify(readDeviceRows())).not.toContain(key);
    await kvFlush();
    kvForgetAll();
    await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
    const row = readDeviceRows().find((entry) => entry.providerId === "lithic");
    if (!row) throw new Error("Missing sealed Lithic connection");
    const record = readNativeConnector(row.connectionId);
    expect(record?.configuration.parameters).toMatchObject({
      credential_variant: environment,
    });
    const driver = nativeConnectorDriver("api-key", "lithic");
    await driver.verify(row.connectionId);
    expect(
      await driver.invoke(row.connectionId, "provider.cards.read", {}),
    ).toMatchObject({ items: [{ id: token }] });
    expect(
      o.requests.every(
        (request) =>
          request.authorized &&
          request.emptyBody &&
          request.path === "/v1/cards?page_size=20",
      ),
    ).toBe(true);
    expect(o.context.egressCalls).toEqual([]);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it.each([401, 403])(
  "shows an accurate HTTP%s refusal without saving or reflecting keys",
  async (status) => {
    const o = await oracle();
    o.reply({ error: key }, status);
    const page = mount();
    await fill();
    await screen.findByRole("img", {
      name:
        status === 401
          ? /Provider authorization was refused/
          : /Provider permissions do not allow/,
    });
    expect(readDeviceRows().some((row) => row.providerId === "lithic")).toBe(
      false,
    );
    expect(page.onFlash).toHaveBeenCalledExactlyOnceWith({
      tone: "err",
      text:
        status === 401
          ? "Provider authorization was refused; verify or replace the saved credential"
          : "Provider permissions do not allow this operation",
    });
    expect(document.body.textContent).not.toContain(key);
    expect(JSON.stringify(page.onFlash.mock.calls)).not.toContain(key);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it("rejects a wrong raw key at the independently verified TLS oracle", async () => {
  const o = await oracle();
  await expect(
    configureNativeApiConnector({
      ...draft(),
      credentials: { api_key: "wrong-owned-key" },
    }),
  ).rejects.toMatchObject({ code: "authorization" });
  expect(o.requests).toEqual([
    { authorized: false, emptyBody: true, path: "/v1/cards?page_size=20" },
  ]);
  expect(readDeviceRows().some((row) => row.providerId === "lithic")).toBe(
    false,
  );
});
it("refuses malformed HTTP200 inventory before saving verification proof", async () => {
  const o = await oracle();
  o.reply({ ...cards, data: [{ ...card, token: key }] });
  await expect(configureNativeApiConnector(draft())).rejects.toMatchObject({
    code: "response",
  });
  expect(readDeviceRows().some((row) => row.providerId === "lithic")).toBe(
    false,
  );
});
it("refuses changing the selected environment outside the captured native authority", async () => {
  const o = await oracle();
  await expect(
    configureNativeApiConnector(draft("production")),
  ).rejects.toThrow();
  expect(o.requests).toEqual([]);
  expect(o.browser).not.toHaveBeenCalled();
});
it("offers only a bounded inventory, refuses arbitrary inputs and does not follow pagination or card details", async () => {
  const o = await oracle();
  o.reply({
    data: [],
    has_more: true,
    next_page: "https://other.test/private",
  });
  const s = await saved();
  expect(await s.read()).toEqual({
    label: "Showing 0 cards from first page; more available",
    items: [],
  });
  const count = o.requests.length;
  for (const operation of [
    "provider.cards.create",
    "provider.cards.details",
    "provider.payments.read",
  ])
    await expect(
      s.driver.invoke(s.view.connectionId, operation, {}),
    ).rejects.toThrow();
  for (const [field, value] of Object.entries({
    url: "https://other.test",
    page_size: "100",
    starting_after: token,
    expand: "pan",
    card_token: token,
  }))
    await expect(
      s.driver.invoke(s.view.connectionId, "provider.cards.read", {
        [field]: value,
      }),
    ).rejects.toThrow();
  expect(o.requests).toHaveLength(count);
});
it("withdraws retained proof after real authorization loss without browser fallback", async () => {
  const o = await oracle();
  const s = await saved();
  o.reply({ error: key }, 401);
  await expect(s.read()).rejects.toMatchObject({ code: "authorization" });
  expect(readNativeConnector(s.view.connectionId)?.status).toBe("reauthorize");
  expect(o.browser).not.toHaveBeenCalled();
});
it.each(["lease", "node", "vault", "caller"])(
  "physically closes the held TLS body on %s withdrawal",
  async (kind) => {
    const o = await oracle();
    const s = await saved();
    const caller = new AbortController();
    const hold = o.hold();
    const rejected = expect(s.read(caller.signal)).rejects.toThrow();
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
it("unmount closes the actual common Settings action stream without a stale result", async () => {
  const o = await oracle();
  const s = await saved();
  const page = mount(s.view.connectionId);
  const hold = o.hold();
  await userEvent.click(
    await screen.findByRole("button", { name: "List cards" }),
  );
  await hold.arrived;
  page.unmount();
  await hold.closed;
  expect(page.onFlash).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("region", { name: /cards from first page/ }),
  ).toBeNull();
  expect(o.browser).not.toHaveBeenCalled();
});
