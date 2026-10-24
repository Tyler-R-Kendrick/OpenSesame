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
  plivoContracts as catalogContracts,
  fill,
  mount,
} from "./native-api-plivo.test-support.js";

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
    displayName: "Owned product resources",
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
it.each(catalogContracts)(
  "$id reaches real common configuration, native TLS resource action and sealed cold reload",
  async (contract) => {
    const o = await oracle(contract);
    mount(contract);
    expect(screen.getAllByRole("heading", { name: "2 Connect" })).toHaveLength(
      1,
    );
    const action = await fill(contract);
    expect(
      screen.queryByRole("button", { name: /^Check .* access$/ }),
    ).toBeNull();
    expect(screen.getByLabelText(/API key$/)).toHaveProperty("value", "");
    await userEvent.click(action);
    const region = await screen.findByRole("region", {
      name: contract.resultLabel,
    });
    expect(within(region).getAllByRole("listitem")).toHaveLength(2);
    expect(region.textContent).toContain("18135401302");
    expect(region.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(region.querySelector("img, a")).toBeNull();
    for (const hidden of [
      primaryKey,
      "private-application",
      "private-cost",
      "private-account",
      "private-deleted",
      "private.example",
      "untrusted.example",
      "private-password",
      "private-env",
      "private@example.test",
      "private-cursor",
      "private-description",
      "private-ci",
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
    cleanup();
    mount(contract, row.connectionId);
    expect(screen.getByLabelText(/API key$/)).toHaveProperty("value", "");
    await userEvent.click(
      await screen.findByRole("button", { name: contract.action }),
    );
    await screen.findByRole("region", { name: contract.resultLabel });
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
    let closed = false;
    void held.closed.then(() => {
      closed = true;
    });
    const pending = s.read(caller.signal);
    await Promise.race([
      held.arrived,
      pending.then(() => {
        throw new Error("Read completed before held TLS response");
      }),
    ]);
    const rejected = expect(pending).rejects.toThrow();
    await delay(250);
    expect(closed).toBe(false);
    if (kind === "lease") o.context.abort();
    if (kind === "node") o.lifetime.abort();
    if (kind === "vault") vaultStore.lock({ recordLastVault: false });
    if (kind === "caller") caller.abort();
    await rejected;
    await physicallyClosed(held.closed);
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
    let closed = false;
    void held.closed.then(() => {
      closed = true;
    });
    await userEvent.click(
      await screen.findByRole("button", { name: contract.action }),
    );
    await held.arrived;
    await delay(250);
    expect(closed).toBe(false);
    page.unmount();
    await physicallyClosed(held.closed);
    expect(page.onFlash).not.toHaveBeenCalled();
    expect(page.onChanged).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: contract.resultLabel }),
    ).toBeNull();
    expect(o.browser).not.toHaveBeenCalled();
  },
);

it("retains blank credentials only for the same saved account and rejects target/SQL overrides", async () => {
  const c = catalogContracts[0];
  const o = await oracle(c);
  const s = await saved(c);
  const row = readNativeConnector(s.view.connectionId);
  if (!row) throw new Error("Missing saved Plivo account");
  const renamed = await configureNativeApiConnector({
    providerId: "plivo",
    connectionId: row.connectionId,
    revision: row.revision,
    displayName: "Renamed",
    parameters: c.parameters,
    credentials: { api_key: "" },
  });
  expect(renamed.connectionId).toBe(row.connectionId);
  const count = o.requests.length;
  await expect(
    configureNativeApiConnector({
      providerId: "plivo",
      connectionId: renamed.connectionId,
      revision: renamed.revision,
      displayName: "Other",
      parameters: { auth_id: "SAOTHER" },
      credentials: { api_key: "" },
    }),
  ).rejects.toThrow(/credentials/);
  await expect(
    s.driver.invoke(row.connectionId, c.operation, { auth_id: "SAOTHER" }),
  ).rejects.toThrow(/overrides/);
  await expect(
    configureNativeApiConnector({
      providerId: "plivo",
      connectionId: row.connectionId,
      revision: row.revision,
      displayName: "Stale",
      parameters: c.parameters,
      credentials: { api_key: primaryKey },
    }),
  ).rejects.toThrow();
  expect(o.requests).toHaveLength(count);
  expect(await s.read()).toMatchObject({ label: c.resultLabel });
});
it("preserves subaccount Basic username and read path instead of substituting a main account", async () => {
  const c = {
    ...catalogContracts[0],
    parameters: { auth_id: "SAOWNED456" },
    authorization: `Basic ${btoa(`SAOWNED456:${primaryKey}`)}`,
    verifyPath: "/v1/Account/SAOWNED456/",
    verifyReply: { auth_id: "SAOWNED456" },
    readPath: "/v1/Account/SAOWNED456/Number/?limit=20&offset=0",
  };
  const o = await oracle(c);
  const s = await saved(c);
  expect(await s.read()).toMatchObject({ label: c.resultLabel });
  expect(
    o.requests.every((request) => request.authorized && request.emptyBody),
  ).toBe(true);
  expect(o.requests.map((request) => request.path)).toEqual([
    c.verifyPath,
    c.readPath,
  ]);
  expect(o.browser).not.toHaveBeenCalled();
});

it.each(["credential", "response-limit"])(
  "rejects real TLS %s data without rendering a success",
  async (kind) => {
    const c = catalogContracts[0];
    const o = await oracle(c);
    const s = await saved(c);
    o.reply({
      meta: {
        limit: 20,
        offset: 0,
        total_count: 1,
        next: null,
        previous: null,
      },
      objects: [
        {
          number: "18135401302",
          alias: kind === "credential" ? primaryKey : "x".repeat(270000),
        },
      ],
    });
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
