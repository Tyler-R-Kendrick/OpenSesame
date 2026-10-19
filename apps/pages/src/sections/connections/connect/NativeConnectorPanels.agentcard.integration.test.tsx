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

const key = "agentcard-owned:platform~token";
const organization = {
  object: "api_v2",
  organization_id: "owned-organization",
  test_mode: true,
};
function draft() {
  return {
    providerId: "agentcard",
    displayName: "Platform organization",
    parameters: {},
    credentials: { api_key: key },
  };
}
declareConnectionsTutorial();
const fixtures: Awaited<ReturnType<typeof stripeOracle>>[] = [];
afterEach(async () => {
  cleanup();
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
});
async function oracle(testMode = true) {
  const o = await stripeOracle("/api/v2", {
    origin: "https://api.agentcard.sh",
    authorization: `Bearer ${key}`,
    headers: {},
    absentHeaders: ["x-user-token", "x-api-version", "cookie"],
    reply: { ...organization, test_mode: testMode },
  });
  fixtures.push(o);
  return o;
}
function mount(id?: string) {
  const onFlash = vi.fn();
  const provider = mergeVercelCatalog(getBundledProviders()).find(
    (row) => row.id === "agentcard",
  );
  if (!provider) throw new Error("Missing actual Agentcard catalog provider");
  expect(hasConnectRoute(provider.id)).toBe(true);
  return {
    ...render(
      <MemoryRouter initialEntries={["/settings/connections/agentcard"]}>
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
  await userEvent.type(screen.getByLabelText("Agentcard API key"), key);
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Agentcard" }),
  );
}
async function saved() {
  const view = await configureNativeApiConnector(draft());
  const driver = nativeConnectorDriver("api-key", "agentcard");
  return {
    view,
    driver,
    read: (signal?: AbortSignal) =>
      driver.invoke(
        view.connectionId,
        "provider.organization.read",
        {},
        signal,
      ),
  };
}
it.each([true, false])(
  "saves through the common form with token-derived mode %s, cold-reloads sealed credentials and consumes TLS organization",
  async (testMode) => {
    const o = await oracle(testMode);
    mount();
    expect(screen.queryByLabelText("Credential type")).toBeNull();
    expect(
      screen.queryByRole("img", { name: "Not available here" }),
    ).toBeNull();
    expect(screen.queryByText("Managed MCP")).toBeNull();
    await fill();
    await screen.findByRole("button", { name: "Read platform organization" });
    expect(screen.getByLabelText("Agentcard API key")).toHaveProperty(
      "value",
      "",
    );
    o.reply({
      ...organization,
      test_mode: testMode,
      access_token: "private-access",
      credentials: { number: "private-pan", cvc: "private-cvc" },
      member_token: "private-member",
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Read platform organization" }),
    );
    const region = await screen.findByRole("region", {
      name: `Agentcard platform organization (${testMode ? "test mode" : "production"})`,
    });
    expect(
      within(region)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      `owned-organization — ${testMode ? "test mode" : "production"}`,
    ]);
    for (const secret of [
      key,
      "private-access",
      "private-pan",
      "private-cvc",
      "private-member",
    ])
      expect(region.textContent).not.toContain(secret);
    expect([...o.storage.files.values()].join()).not.toContain(key);
    expect(JSON.stringify(readDeviceRows())).not.toContain(key);
    await kvFlush();
    kvForgetAll();
    await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
    const row = readDeviceRows().find(
      (entry) => entry.providerId === "agentcard",
    );
    if (!row) throw new Error("Missing sealed Agentcard connection");
    const record = readNativeConnector(row.connectionId);
    expect(record?.configuration.parameters).toEqual({});
    const driver = nativeConnectorDriver("api-key", "agentcard");
    await driver.verify(row.connectionId);
    expect(
      await driver.invoke(row.connectionId, "provider.organization.read", {}),
    ).toMatchObject({ items: [{ id: "owned-organization" }] });
    expect(
      o.requests.every(
        (request) =>
          request.authorized && request.emptyBody && request.path === "/api/v2",
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
    expect(readDeviceRows().some((row) => row.providerId === "agentcard")).toBe(
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
it("rejects a wrong or member Bearer token at the independently verified TLS oracle", async () => {
  const o = await oracle();
  await expect(
    configureNativeApiConnector({
      ...draft(),
      credentials: { api_key: "wrong-owned-key" },
    }),
  ).rejects.toMatchObject({ code: "authorization" });
  expect(o.requests).toEqual([
    {
      authorized: false,
      emptyBody: true,
      path: "/api/v2",
    },
  ]);
  expect(readDeviceRows().some((row) => row.providerId === "agentcard")).toBe(
    false,
  );
});
it("refuses malformed HTTP200 organization before saving verification proof", async () => {
  const o = await oracle();
  o.reply({ ...organization, organization_id: key });
  await expect(configureNativeApiConnector(draft())).rejects.toMatchObject({
    code: "response",
  });
  expect(readDeviceRows().some((row) => row.providerId === "agentcard")).toBe(
    false,
  );
});
it("rejects member authority, host, test-mode overrides and writes before native dispatch", async () => {
  const o = await oracle();
  for (const [field, value] of Object.entries({
    user_id: "member",
    host: "other.test",
    test_mode: "false",
  }))
    await expect(
      configureNativeApiConnector({
        ...draft(),
        parameters: { [field]: value },
      }),
    ).rejects.toThrow();
  expect(o.requests).toEqual([]);
  const s = await saved();
  const count = o.requests.length;
  for (const operation of [
    "provider.cards.read",
    "provider.cards.create",
    "provider.tokens.create",
    "provider.organization.write",
  ])
    await expect(
      s.driver.invoke(s.view.connectionId, operation, {}),
    ).rejects.toThrow();
  for (const [field, value] of Object.entries({
    url: "https://other.test",
    user_id: "member",
    member_token: "private-member",
    test_mode: "false",
  }))
    await expect(
      s.driver.invoke(s.view.connectionId, "provider.organization.read", {
        [field]: value,
      }),
    ).rejects.toThrow();
  expect(o.requests).toHaveLength(count);
  expect(o.browser).not.toHaveBeenCalled();
});
it.each([
  { object: "card", credentials: { number: "private-pan" } },
  { object: "api_v2", org_id: "wrong", test_mode: true },
  { ...organization, test_mode: "true" },
])(
  "refuses member-card or malformed HTTP200 payload %# before saving",
  async (reply) => {
    const o = await oracle();
    o.reply(reply);
    await expect(configureNativeApiConnector(draft())).rejects.toMatchObject({
      code: "response",
    });
    expect(readDeviceRows().some((r) => r.providerId === "agentcard")).toBe(
      false,
    );
  },
);
it("withdraws retained proof after actual platform-token expiry/HTTP401 without browser fallback", async () => {
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
    await screen.findByRole("button", { name: "Read platform organization" }),
  );
  await hold.arrived;
  page.unmount();
  await hold.closed;
  expect(page.onFlash).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("region", { name: /Agentcard platform organization/ }),
  ).toBeNull();
  expect(o.browser).not.toHaveBeenCalled();
});
