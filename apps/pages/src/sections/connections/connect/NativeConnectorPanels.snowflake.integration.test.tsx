/** @vitest-environment jsdom */
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import {
  snowflakeAccount,
  snowflakeData,
  snowflakeOracle,
  snowflakePending,
  snowflakeToken,
} from "@opensesame/app-core/lib/native-snowflake.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";
import {
  connectorIntegration,
  installConnectorIntegration,
  integrationProvider,
} from "./native-connector-integration.test-support.js";

declareConnectionsTutorial();
installConnectorIntegration();
const oracles: Awaited<ReturnType<typeof snowflakeOracle>>[] = [];
afterEach(async () => {
  cleanup();
  for (const o of oracles.splice(0).reverse()) await o.close();
});
async function oracle(mode = "PROGRAMMATIC_ACCESS_TOKEN") {
  const fixture = connectorIntegration();
  const o = await snowflakeOracle(mode);
  oracles.push(o);
  fixture.route.respond = (request) => o.transport.fetch(request);
  return { ...o, fixture };
}
function mount(id?: string) {
  const onFlash = vi.fn();
  return {
    ...render(
      <MemoryRouter initialEntries={["/settings/connections/snowflake"]}>
        <ConnectorSettingsPage
          provider={integrationProvider("snowflake")}
          providerId="snowflake"
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
async function fill(
  mode = "PROGRAMMATIC_ACCESS_TOKEN",
  token = snowflakeToken,
) {
  await userEvent.type(
    screen.getByLabelText("Snowflake account URL"),
    snowflakeAccount,
  );
  await userEvent.selectOptions(screen.getByLabelText("Token type"), mode);
  await userEvent.click(screen.getByText("Sign-in options"));
  await userEvent.type(screen.getByLabelText("Role (optional)"), "READER");
  await userEvent.type(screen.getByLabelText("Access token"), token);
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Snowflake" }),
  );
}
async function connect(mode = "PROGRAMMATIC_ACCESS_TOKEN") {
  await fill(mode);
  return screen.findByRole("button", { name: "List databases" });
}
async function listed() {
  const section = await screen.findByRole("region", {
    name: "Showing 2 databases from first page",
  });
  expect(
    within(section)
      .getAllByRole("listitem")
      .map((row) => row.textContent),
  ).toEqual(["ANALYTICS", "WAREHOUSE_METADATA"]);
  expect(section.querySelector("a, img")).toBeNull();
  expect(section.textContent).not.toContain(snowflakeToken);
}
it.each(["PROGRAMMATIC_ACCESS_TOKEN", "OAUTH"])(
  "%s is configurable through actual catalog Settings, proves SQL and lists databases after sealed cold restore",
  async (mode) => {
    const o = await oracle(mode);
    const ui = mount();
    await userEvent.click(await connect(mode));
    await listed();
    const row = readDeviceRows()[0];
    if (!row) throw new Error("Missing actual saved device connection");
    expect(readNativeConnector(row.connectionId)?.status).toBe("connected");
    expect(JSON.stringify(readDeviceRows())).not.toContain(snowflakeToken);
    expect([...o.fixture.disk.files.values()].join()).not.toContain(
      snowflakeToken,
    );
    expect(screen.getByLabelText("Access token")).toHaveProperty("value", "");
    expect(o.requests).toHaveLength(2);
    expect(
      o.requests.every(
        (request) => request.authorized && request.method === "POST",
      ),
    ).toBe(true);
    ui.unmount();
    const restored = await o.fixture.reload();
    expect(restored).toHaveLength(1);
    mount(row.connectionId);
    await userEvent.click(
      await screen.findByRole("button", { name: "List databases" }),
    );
    await listed();
    expect(o.requests).toHaveLength(3);
    expect(o.origins).toEqual([
      snowflakeAccount,
      snowflakeAccount,
      snowflakeAccount,
    ]);
    expect(
      o.fixture.requests.every(
        (request) => new URL(request.url).origin === snowflakeAccount,
      ),
    ).toBe(true);
    expect(ui.onFlash).not.toHaveBeenCalledWith("error", expect.anything());
  },
);
it("actual Settings completes asynchronous202 polling before exposing genuine database metadata", async () => {
  const o = await oracle();
  mount();
  await connect();
  o.reply((request, response) => {
    if (request.method === "POST") {
      response.writeHead(202);
      response.end(JSON.stringify(snowflakePending));
    } else response.end(JSON.stringify(snowflakeData));
  });
  await userEvent.click(screen.getByRole("button", { name: "List databases" }));
  await listed();
  expect(o.requests.map((request) => request.method)).toEqual([
    "POST",
    "POST",
    "GET",
  ]);
});
it("a wrong actual credential never creates a proved saved connection", async () => {
  const o = await oracle();
  const ui = mount();
  await fill("PROGRAMMATIC_ACCESS_TOKEN", "controlled-wrong-credential");
  await waitFor(() => expect(ui.onFlash).toHaveBeenCalled());
  expect(readDeviceRows()).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "List databases" })).toBeNull();
  expect(o.requests).toHaveLength(1);
  expect(o.requests[0]?.authorized).toBe(false);
  expect(JSON.stringify(ui.onFlash.mock.calls)).not.toContain(snowflakeToken);
});
it("a200 query failure cannot render metadata or reflect the token in the common action error", async () => {
  const o = await oracle();
  const ui = mount();
  await connect();
  o.reply((_request, response) =>
    response.end(
      JSON.stringify({
        code: "000904",
        sqlState: "42000",
        message: snowflakeToken,
      }),
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "List databases" }));
  await waitFor(() => expect(ui.onFlash).toHaveBeenCalled());
  expect(
    screen.queryByRole("region", { name: /Showing.*databases/ }),
  ).toBeNull();
  expect(JSON.stringify(ui.onFlash.mock.calls)).not.toContain(snowflakeToken);
  expect(o.requests).toHaveLength(2);
});
it.each(["activation", "vault"])(
  "original %s withdrawal physically drains pending Settings SQL and does not send cancel or accept later data",
  async (owner) => {
    const o = await oracle();
    mount();
    await connect();
    const held = o.hold();
    await userEvent.click(
      screen.getByRole("button", { name: "List databases" }),
    );
    await held.arrived.promise;
    if (owner === "activation") o.fixture.activation.dispose();
    else vaultStore.lock();
    await held.closed.promise;
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: /Showing.*databases/ }),
      ).toBeNull(),
    );
    expect(o.requests).toHaveLength(2);
    expect(o.requests.some((request) => request.path.includes("cancel"))).toBe(
      false,
    );
  },
);

it("retains the caller signal through real shared-driver custody and permits an independent later read", async () => {
  const o = await oracle();
  mount();
  await connect();
  const row = readDeviceRows()[0];
  if (!row) throw new Error("Missing saved connection");
  const driver = nativeConnectorDriver("api-key", "snowflake");
  const caller = new AbortController();
  const held = o.hold();
  const pending = driver.invoke(
    row.connectionId,
    "provider.databases.read",
    {},
    caller.signal,
  );
  const refused = expect(pending).rejects.toThrow();
  await held.arrived.promise;
  caller.abort();
  await refused;
  await held.closed.promise;
  await expect(
    driver.invoke(
      row.connectionId,
      "provider.databases.read",
      {},
      caller.signal,
    ),
  ).rejects.toThrow();
  expect(o.requests).toHaveLength(2);
  expect(readNativeConnector(row.connectionId)?.status).toBe("connected");
  await userEvent.click(screen.getByRole("button", { name: "List databases" }));
  await listed();
  expect(o.requests).toHaveLength(3);
});
