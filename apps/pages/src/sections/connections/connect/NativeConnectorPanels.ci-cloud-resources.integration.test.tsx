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
  type PrimaryContract,
  primaryKey,
  primaryOracle,
} from "./native-api-primary.test-support.js";

import { ciCloudContracts as catalogContracts } from "./native-api-ci-cloud.test-support.js";

declareConnectionsTutorial();
const fixtures: Awaited<ReturnType<typeof primaryOracle>>[] = [];
afterEach(async () => {
  cleanup();
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
});
async function oracle(contract: PrimaryContract) {
  const result = await primaryOracle(contract);
  fixtures.push(result);
  return result;
}
function mount(contract: PrimaryContract, id?: string) {
  const provider = mergeVercelCatalog(getBundledProviders()).find(
    (row) => row.id === contract.id,
  );
  if (!provider) throw new Error("Missing actual catalog provider");
  expect(hasConnectRoute(provider.id)).toBe(true);
  const onFlash = vi.fn();
  return {
    ...render(
      <MemoryRouter initialEntries={[`/settings/connections/${contract.id}`]}>
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
async function fill(contract: PrimaryContract) {
  const method = screen.queryByRole("radio", { name: "API Key" });
  if (method) await userEvent.click(method);
  await userEvent.type(screen.getByLabelText(/API key$/), primaryKey);
  const connect = screen.getByRole("button", { name: /^Verify and connect / });
  expect(connect).toHaveProperty("disabled", false);
  const label =
    contract.id === "buildkite"
      ? "Buildkite organization slug"
      : "CircleCI project slug";
  for (const value of Object.values(contract.parameters))
    await userEvent.type(screen.getByLabelText(label), value);
  if (contract.id === "digitalocean")
    expect(document.body.textContent).toMatch(
      /account:read[\s\S]*droplet:read/,
    );
  await userEvent.click(connect);
  return screen.findByRole("button", { name: contract.action });
}

async function saved(contract: PrimaryContract) {
  const view = await configureNativeApiConnector({
    providerId: contract.id,
    displayName: "Owned product resources",
    parameters: contract.parameters,
    credentials: { api_key: primaryKey },
  });
  const driver = nativeConnectorDriver("api-key", contract.id);
  return {
    view,
    read: (signal?: AbortSignal) =>
      driver.invoke(view.connectionId, contract.operation, {}, signal),
  };
}
async function closedWithin(pending: Promise<void>) {
  let closed = false;
  void pending.then(() => {
    closed = true;
  });
  await waitFor(() => expect(closed).toBe(true), { timeout: 2000 });
}
it.each(catalogContracts)(
  "$id reaches real common configuration, native TLS resource action and sealed cold reload",
  async (contract) => {
    const o = await oracle(contract);
    const page = mount(contract);
    expect(screen.getAllByRole("heading", { name: "2 Connect" })).toHaveLength(
      1,
    );
    const action = await fill(contract);
    expect(
      screen.queryByRole("button", { name: /^Check .* access$/ }),
    ).toBeNull();
    expect(screen.getByLabelText(/API key$/)).toHaveProperty("value", "");
    await userEvent.click(action);
    await waitFor(() => expect(action).toHaveProperty("disabled", false));
    expect(
      page.onFlash.mock.calls.filter(([flash]) => flash.tone === "err"),
    ).toEqual([]);
    expect(o.requests).toHaveLength(2);
    const region = await screen.findByRole("region", {
      name: contract.resultLabel,
    });
    expect(within(region).getAllByRole("listitem")).toHaveLength(1);
    expect(region.querySelector("img, a")).toBeNull();
    for (const hidden of [
      primaryKey,
      "private-env",
      "private-description",
      "private-webhook",
      "private-error",
      "private-key",
      "10.0.0.1",
    ])
      expect(region.textContent).not.toContain(hidden);
    expect([...o.storage.files.values()].join()).not.toContain(primaryKey);
    expect(JSON.stringify(readDeviceRows())).not.toContain(primaryKey);
    await kvFlush();
    kvForgetAll();
    await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
    const row = readDeviceRows().find(
      (entry) => entry.providerId === contract.id,
    );
    if (!row) throw new Error("Missing sealed provider connection");
    const driver = nativeConnectorDriver("api-key", contract.id);
    await driver.verify(row.connectionId);
    expect(
      await driver.invoke(row.connectionId, contract.operation, {}),
    ).toMatchObject({ label: contract.resultLabel });
    expect(o.requests.map((request) => request.path)).toEqual([
      contract.verifyPath,
      contract.readPath,
      contract.verifyPath,
      contract.readPath,
    ]);
    expect(
      o.requests.every((request) => request.authorized && request.emptyBody),
    ).toBe(true);
    expect(o.context.egressCalls).toEqual([]);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it.each(catalogContracts)(
  "$id displays real HTTP failures safely and invalidates only lost authorization",
  async (contract) => {
    const o = await oracle(contract);
    const s = await saved(contract);
    const page = mount(contract, s.view.connectionId);
    for (const status of [403, 401]) {
      o.reply({ error: primaryKey }, status);
      await userEvent.click(
        await screen.findByRole("button", { name: contract.action }),
      );
      if (status === 403)
        await screen.findByRole("img", {
          name: /Provider permissions do not allow/,
        });
      else {
        // Lost authorization remounts the action; its old error notice must not survive.
        await waitFor(() =>
          expect(readNativeConnector(s.view.connectionId)?.status).toBe(
            "reauthorize",
          ),
        );
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: contract.action }),
          ).toHaveProperty("disabled", true),
        );
      }
      expect(readNativeConnector(s.view.connectionId)?.status).toBe(
        status === 401 ? "reauthorize" : "connected",
      );
      expect(document.body.textContent).not.toContain(primaryKey);
      expect(JSON.stringify(page.onFlash.mock.calls)).not.toContain(primaryKey);
      expect(
        screen.queryByRole("region", { name: contract.resultLabel }),
      ).toBeNull();
    }
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it.each(catalogContracts)(
  "$id rejects malformed HTTP200 resource data without claiming read success",
  async (contract) => {
    const o = await oracle(contract);
    const s = await saved(contract);
    o.reply({ malformed: true });
    mount(contract, s.view.connectionId);
    await userEvent.click(
      await screen.findByRole("button", { name: contract.action }),
    );
    await screen.findByRole("img", {
      name: /Provider did not return the expected response/,
    });
    expect(
      screen.queryByRole("region", { name: contract.resultLabel }),
    ).toBeNull();
    expect(readNativeConnector(s.view.connectionId)?.status).toBe("connected");
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it.each(catalogContracts)(
  "$id rejects wrong credentials at the independent TLS authentication oracle",
  async (contract) => {
    const o = await oracle(contract);
    await expect(
      configureNativeApiConnector({
        providerId: contract.id,
        displayName: "Wrong key",
        parameters: contract.parameters,
        credentials: { api_key: "wrong-key" },
      }),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(o.requests).toEqual([
      { authorized: false, path: contract.verifyPath, emptyBody: true },
    ]);
    expect(readDeviceRows().some((row) => row.providerId === contract.id)).toBe(
      false,
    );
  },
);
const withdrawals = catalogContracts.flatMap((contract) =>
  ["lease", "node", "vault", "caller"].map((kind) => ({ contract, kind })),
);
it.each(withdrawals)(
  "$contract.id physically closes the held TLS response on $kind withdrawal",
  async ({ contract, kind }) => {
    const o = await oracle(contract);
    const s = await saved(contract);
    const caller = new AbortController();
    const held = o.hold();
    const pending = s.read(caller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await held.arrived;
    if (kind === "lease") o.context.abort();
    if (kind === "node") o.lifetime.abort();
    if (kind === "vault") vaultStore.lock({ recordLastVault: false });
    if (kind === "caller") caller.abort();
    await rejected;
    await closedWithin(held.closed);
    if (kind !== "caller") {
      const count = o.requests.length;
      await expect(s.read()).rejects.toThrow();
      expect(o.requests).toHaveLength(count);
    }
    expect(o.context.egressCalls).toEqual([]);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it.each(catalogContracts)(
  "$id common Settings action unmount cancels its original TLS stream",
  async (contract) => {
    const o = await oracle(contract);
    const s = await saved(contract);
    const page = mount(contract, s.view.connectionId);
    const held = o.hold();
    await userEvent.click(
      await screen.findByRole("button", { name: contract.action }),
    );
    await held.arrived;
    page.unmount();
    await closedWithin(held.closed);
    expect(page.onFlash).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: contract.resultLabel }),
    ).toBeNull();
    expect(o.browser).not.toHaveBeenCalled();
  },
);
