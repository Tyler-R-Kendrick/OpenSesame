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

const key = "marqeta-owned-application";
const admin = "marqeta-owned:separate~admin";
const encoded = btoa(`${key}:${admin}`);
const user = { token: "owned-user", active: true };
const users = {
  count: 1,
  start_index: 0,
  end_index: 0,
  is_more: false,
  data: [user],
};
function publicParameters(
  environment: string,
): NativeApiConfigureInput["parameters"] {
  if (environment === "program")
    return {
      credential_variant: environment,
      program_host: "program-api.example.test",
    };
  return { credential_variant: environment };
}
function draft(environment = "sandbox") {
  return {
    providerId: "marqeta",
    displayName: "Read-only user inventory",
    parameters: publicParameters(environment),
    credentials: { api_key: key, admin_access_token: admin },
  };
}
declareConnectionsTutorial();
const fixtures: Awaited<ReturnType<typeof stripeOracle>>[] = [];
afterEach(async () => {
  cleanup();
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
});
async function oracle(environment = "sandbox") {
  const o = await stripeOracle(
    "/v3/users?count=10&start_index=0&fields=token%2Cactive",
    {
      origin: `https://${environment === "sandbox" ? "sandbox-api.marqeta.com" : "program-api.example.test"}`,
      authorization: `Basic ${encoded}`,
      headers: {},
      absentHeaders: ["api-version", "x-marqeta-account"],
      reply: users,
    },
  );
  fixtures.push(o);
  return o;
}
function mount(id?: string) {
  const onFlash = vi.fn();
  const provider = mergeVercelCatalog(getBundledProviders()).find(
    (row) => row.id === "marqeta",
  );
  if (!provider) throw new Error("Missing actual Marqeta catalog provider");
  expect(hasConnectRoute(provider.id)).toBe(true);
  return {
    ...render(
      <MemoryRouter initialEntries={["/settings/connections/marqeta"]}>
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
  if (environment === "program")
    await userEvent.type(
      screen.getByLabelText("Program API host (from dashboard)"),
      "program-api.example.test",
    );
  await userEvent.type(
    screen.getByLabelText(
      `Marqeta ${environment === "sandbox" ? "Public sandbox" : "Program API"}`,
    ),
    key,
  );
  expect(screen.getByLabelText("Admin access token")).toHaveProperty(
    "type",
    "password",
  );
  await userEvent.type(screen.getByLabelText("Admin access token"), admin);
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Marqeta" }),
  );
}
async function saved() {
  const view = await configureNativeApiConnector(draft());
  const driver = nativeConnectorDriver("api-key", "marqeta");
  return {
    view,
    driver,
    read: (signal?: AbortSignal) =>
      driver.invoke(view.connectionId, "provider.users.read", {}, signal),
  };
}
it.each(["sandbox", "program"])(
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
    await screen.findByRole("button", { name: "List users" });
    expect(screen.getByLabelText("Admin access token")).toHaveProperty(
      "value",
      "",
    );
    expect(
      screen.getByLabelText(
        `Marqeta ${environment === "sandbox" ? "Public sandbox" : "Program API"}`,
      ),
    ).toHaveProperty("value", "");
    o.reply({
      ...users,
      data: [
        {
          ...user,
          first_name: "private-name",
          address1: "private-address",
          birth_date: "private-birth-date",
          identifications: [{ value: "private-id" }],
          balances: "private-balances",
        },
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "List users" }));
    const region = await screen.findByRole("region", {
      name: "Showing 1 users from first page",
    });
    expect(
      within(region)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["owned-user — active"]);
    for (const secret of [
      key,
      admin,
      encoded,
      "private-name",
      "private-address",
      "private-birth-date",
      "private-id",
      "private-balances",
    ])
      expect(region.textContent).not.toContain(secret);
    for (const secret of [key, admin, encoded]) {
      expect([...o.storage.files.values()].join()).not.toContain(secret);
      expect(JSON.stringify(readDeviceRows())).not.toContain(secret);
    }
    await kvFlush();
    kvForgetAll();
    await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
    const row = readDeviceRows().find(
      (entry) => entry.providerId === "marqeta",
    );
    if (!row) throw new Error("Missing sealed Marqeta connection");
    const record = readNativeConnector(row.connectionId);
    expect(record?.configuration.parameters).toMatchObject({
      credential_variant: environment,
    });
    const driver = nativeConnectorDriver("api-key", "marqeta");
    await driver.verify(row.connectionId);
    expect(
      await driver.invoke(row.connectionId, "provider.users.read", {}),
    ).toMatchObject({ items: [{ id: "owned-user" }] });
    expect(
      o.requests.every(
        (request) =>
          request.authorized &&
          request.emptyBody &&
          request.path ===
            "/v3/users?count=10&start_index=0&fields=token%2Cactive",
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
    expect(readDeviceRows().some((row) => row.providerId === "marqeta")).toBe(
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
it.each(["api_key", "admin_access_token"])(
  "rejects a wrong %s at the independently verified TLS Basic oracle",
  async (field) => {
    const o = await oracle();
    await expect(
      configureNativeApiConnector({
        ...draft(),
        credentials: {
          ...draft().credentials,
          [field]: "wrong-owned-credential",
        },
      }),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(o.requests).toEqual([
      {
        authorized: false,
        emptyBody: true,
        path: "/v3/users?count=10&start_index=0&fields=token%2Cactive",
      },
    ]);
    expect(readDeviceRows().some((row) => row.providerId === "marqeta")).toBe(
      false,
    );
  },
);
it("refuses malformed HTTP200 inventory before saving verification proof", async () => {
  const o = await oracle();
  o.reply({ ...users, data: [{ ...user, active: "yes" }] });
  await expect(configureNativeApiConnector(draft())).rejects.toMatchObject({
    code: "response",
  });
  expect(readDeviceRows().some((row) => row.providerId === "marqeta")).toBe(
    false,
  );
});
it("refuses changing the selected environment outside the captured native authority", async () => {
  const o = await oracle();
  await expect(configureNativeApiConnector(draft("program"))).rejects.toThrow();
  expect(o.requests).toEqual([]);
  expect(o.browser).not.toHaveBeenCalled();
});
it("offers only a bounded inventory, refuses arbitrary inputs and does not follow pagination or card details", async () => {
  const o = await oracle();
  o.reply({});
  const s = await saved();
  expect(await s.read()).toEqual({
    label: "Showing 0 users from first page",
    items: [],
  });
  o.reply({ data: [] });
  expect(await s.read()).toEqual({
    label: "Showing 0 users from first page",
    items: [],
  });
  o.reply({ ...users, is_more: true, next_page: "https://other.test/private" });
  expect(await s.read()).toEqual({
    label: "Showing 1 users from first page; more available",
    items: [{ id: "owned-user", label: "owned-user — active" }],
  });
  const count = o.requests.length;
  for (const operation of [
    "provider.users.create",
    "provider.users.details",
    "provider.payments.read",
  ])
    await expect(
      s.driver.invoke(s.view.connectionId, operation, {}),
    ).rejects.toThrow();
  for (const [field, value] of Object.entries({
    url: "https://other.test",
    count: "100",
    start_index: "10",
    fields: "token,email",
    user_token: "other-user",
  }))
    await expect(
      s.driver.invoke(s.view.connectionId, "provider.users.read", {
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
    await screen.findByRole("button", { name: "List users" }),
  );
  await hold.arrived;
  page.unmount();
  await hold.closed;
  expect(page.onFlash).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("region", { name: /users from first page/ }),
  ).toBeNull();
  expect(o.browser).not.toHaveBeenCalled();
});
