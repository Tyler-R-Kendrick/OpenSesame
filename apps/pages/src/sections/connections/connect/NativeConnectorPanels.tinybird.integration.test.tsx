/** @vitest-environment jsdom */
import { setTimeout as delay } from "node:timers/promises";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "@opensesame/app-core/lib/device-connector-records.js";
import {
  kvFlush,
  kvForgetAll,
  kvHydrate,
} from "@opensesame/app-core/lib/kv.js";
import { configureNativeApiConnector } from "@opensesame/app-core/lib/native-api-connectors.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";
import {
  type PrimaryContract,
  primaryKey,
  primaryOracle,
} from "./native-api-primary.test-support.js";
import {
  tinybirdContracts as contracts,
  fill,
  mount,
  stageOldContract,
} from "./native-api-tinybird.test-support.js";

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
async function saved(contract: PrimaryContract) {
  const view = await configureNativeApiConnector({
    providerId: contract.id,
    displayName: "Workspace data sources",
    parameters: contract.parameters,
    credentials: { api_key: primaryKey },
  });
  const driver = nativeConnectorDriver("api-key", contract.id);
  return {
    view,
    driver,
    read: (signal?: AbortSignal) =>
      driver.invoke(view.connectionId, contract.operation, {}, signal),
  };
}
async function physicallyClosed(pending: Promise<void>) {
  let closed = false;
  void pending.then(() => {
    closed = true;
  });
  await waitFor(() => expect(closed).toBe(true), { timeout: 2000 });
}
it.each(contracts)(
  "$origin common region form, actual list and sealed cold UI retain the selected workspace",
  async (c) => {
    const o = await oracle(c);
    mount(c);
    expect(screen.getByLabelText(/Data region$/)).toHaveProperty("value", "");
    expect(screen.getByRole("option", { name: "EU" })).toHaveProperty(
      "value",
      "api.tinybird.co",
    );
    expect(screen.getByRole("option", { name: "US East" })).toHaveProperty(
      "value",
      "api.us-east.tinybird.co",
    );
    const action = await fill(c);
    expect(
      screen.queryByRole("button", { name: /^Check .* access$/ }),
    ).toBeNull();
    expect(screen.getByLabelText(/API key$/)).toHaveProperty("value", "");
    await userEvent.click(action);
    const region = await screen.findByRole("region", { name: c.resultLabel });
    expect(within(region).getAllByRole("listitem")).toHaveLength(20);
    expect(region.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(region.querySelector("img, a")).toBeNull();
    for (const secret of [
      primaryKey,
      "private-token",
      "private-column",
      "untrusted.example",
      "source_20",
    ])
      expect(region.textContent).not.toContain(secret);
    expect([...o.storage.files.values()].join()).not.toContain(primaryKey);
    expect(JSON.stringify(readDeviceRows())).not.toContain(primaryKey);
    await kvFlush();
    kvForgetAll();
    await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
    const row = readDeviceRows().find((entry) => entry.providerId === c.id);
    if (!row) throw new Error("Missing sealed Tinybird connection");
    expect(
      readNativeConnector(row.connectionId)?.configuration.parameters,
    ).toEqual(c.parameters);
    cleanup();
    mount(c, row.connectionId);
    expect(screen.getByLabelText(/Data region$/)).toHaveProperty(
      "value",
      c.parameters.api_host,
    );
    expect(screen.getByLabelText(/API key$/)).toHaveProperty("value", "");
    await userEvent.click(
      await screen.findByRole("button", { name: c.action }),
    );
    await screen.findByRole("region", { name: c.resultLabel });
    expect(o.requests.map((request) => request.path)).toEqual([
      c.verifyPath,
      c.readPath,
      c.readPath,
    ]);
    expect(
      o.requests.every((request) => request.authorized && request.emptyBody),
    ).toBe(true);
    expect(o.context.egressCalls).toEqual([]);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it.each([403, 401])(
  "actual Tinybird HTTP%s does not become an empty resource success",
  async (status) => {
    const c = contracts[0];
    const o = await oracle(c);
    const s = await saved(c);
    const page = mount(c, s.view.connectionId);
    o.reply({ error: primaryKey }, status);
    await userEvent.click(
      await screen.findByRole("button", { name: c.action }),
    );
    if (status === 403)
      await screen.findByRole("img", {
        name: /Provider permissions do not allow/,
      });
    else
      await waitFor(() =>
        expect(readNativeConnector(s.view.connectionId)?.status).toBe(
          "reauthorize",
        ),
      );
    expect(screen.queryByRole("region", { name: c.resultLabel })).toBeNull();
    expect(document.body.textContent).not.toContain(primaryKey);
    expect(JSON.stringify(page.onFlash.mock.calls)).not.toContain(primaryKey);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it.each(["malformed", "credential", "response-limit"])(
  "real TLS %s replies are refused instead of rendered",
  async (kind) => {
    const c = contracts[0];
    const o = await oracle(c);
    const s = await saved(c);
    o.reply(
      kind === "malformed"
        ? { datasources: [], error: "denied" }
        : {
            datasources: [
              { name: kind === "credential" ? primaryKey : "x".repeat(270000) },
            ],
          },
    );
    const page = mount(c, s.view.connectionId);
    await userEvent.click(
      await screen.findByRole("button", { name: c.action }),
    );
    await screen.findByRole("img", {
      name: /Provider did not return the expected response/,
    });
    expect(screen.queryByRole("region", { name: c.resultLabel })).toBeNull();
    expect(document.body.textContent).not.toContain(primaryKey);
    expect(JSON.stringify(page.onFlash.mock.calls)).not.toContain(primaryKey);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it("wrong bearer key fails independent TLS authentication without saving a connection", async () => {
  const c = contracts[0];
  const o = await oracle(c);
  await expect(
    configureNativeApiConnector({
      providerId: c.id,
      displayName: "Wrong key",
      parameters: c.parameters,
      credentials: { api_key: "wrong-key" },
    }),
  ).rejects.toMatchObject({ code: "authorization" });
  expect(o.requests).toEqual([
    { authorized: false, path: c.verifyPath, emptyBody: true },
  ]);
  expect(readDeviceRows().some((row) => row.providerId === c.id)).toBe(false);
});
it("blank credentials retain only the same region; changed region and stale revision never dispatch", async () => {
  const c = contracts[0];
  const o = await oracle(c);
  const s = await saved(c);
  const renamed = await configureNativeApiConnector({
    providerId: c.id,
    connectionId: s.view.connectionId,
    revision: s.view.revision,
    displayName: "Renamed",
    parameters: c.parameters,
    credentials: { api_key: "" },
  });
  const before = readDeviceRows();
  const count = o.requests.length;
  await expect(
    configureNativeApiConnector({
      providerId: c.id,
      connectionId: renamed.connectionId,
      revision: renamed.revision,
      displayName: "US",
      parameters: contracts[1].parameters,
      credentials: { api_key: "" },
    }),
  ).rejects.toThrow(/credentials/);
  await expect(
    configureNativeApiConnector({
      providerId: c.id,
      connectionId: s.view.connectionId,
      revision: s.view.revision,
      displayName: "Stale",
      parameters: c.parameters,
      credentials: { api_key: primaryKey },
    }),
  ).rejects.toThrow(/changed/);
  await expect(
    s.driver.invoke(s.view.connectionId, c.operation, {
      api_host: contracts[1].parameters.api_host,
    }),
  ).rejects.toThrow(/does not accept/);
  expect(readDeviceRows()).toEqual(before);
  expect(o.requests).toHaveLength(count);
  expect(await s.read()).toMatchObject({ label: c.resultLabel });
});
it("historical fixed-EU proof retains its secret references but must be explicitly reverified on the same ID", async () => {
  const c = contracts[0];
  const o = await oracle(c);
  const s = await saved(c);
  const old = await stageOldContract(s.view.connectionId);
  const before = readDeviceRows();
  const count = o.requests.length;
  await expect(s.driver.verify(old.connectionId)).rejects.toThrow(
    /contract changed/,
  );
  await expect(s.read()).rejects.toThrow(/contract changed/);
  await expect(
    configureNativeApiConnector({
      providerId: c.id,
      connectionId: old.connectionId,
      revision: old.revision,
      displayName: "Retest",
      parameters: c.parameters,
      credentials: { api_key: "" },
    }),
  ).rejects.toThrow(/credentials/);
  expect(readDeviceRows()).toEqual(before);
  expect(o.requests).toHaveLength(count);
  const retested = await configureNativeApiConnector({
    providerId: c.id,
    connectionId: old.connectionId,
    revision: old.revision,
    displayName: "Retested",
    parameters: c.parameters,
    credentials: { api_key: primaryKey },
  });
  expect(retested.connectionId).toBe(old.connectionId);
  expect(await s.read()).toMatchObject({ label: c.resultLabel });
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  expect(await s.read()).toMatchObject({ label: c.resultLabel });
  expect(
    readNativeConnector(old.connectionId)?.configuration.parameters,
  ).toEqual(c.parameters);
});
it.each(["caller", "lease", "node", "vault", "unmount"])(
  "held real TLS data-source response physically closes within 2s on %s withdrawal",
  async (kind) => {
    const c = contracts[0];
    const o = await oracle(c);
    const s = await saved(c);
    const page = mount(c, s.view.connectionId);
    const caller = new AbortController();
    const held = o.hold();
    let closed = false;
    void held.closed.then(() => {
      closed = true;
    });
    const pending = kind === "unmount" ? null : s.read(caller.signal);
    const rejected = pending ? expect(pending).rejects.toThrow() : null;
    if (!pending)
      await userEvent.click(
        await screen.findByRole("button", { name: c.action }),
      );
    await held.arrived;
    await delay(250);
    expect(closed).toBe(false);
    if (kind === "caller") caller.abort();
    if (kind === "lease") o.context.abort();
    if (kind === "node") o.lifetime.abort();
    if (kind === "vault") vaultStore.lock({ recordLastVault: false });
    if (kind === "unmount") page.unmount();
    if (rejected) await rejected;
    await physicallyClosed(held.closed);
    expect(page.onChanged).not.toHaveBeenCalled();
    expect(page.onFlash).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: c.resultLabel })).toBeNull();
    expect(o.context.egressCalls).toEqual([]);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
