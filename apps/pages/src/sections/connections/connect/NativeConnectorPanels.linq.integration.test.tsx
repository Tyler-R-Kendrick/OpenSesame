/** @vitest-environment jsdom */
import type { ServerResponse } from "node:http";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
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
  configureNativeApiConnector,
  testNativeApiCredential,
} from "@opensesame/app-core/lib/native-api-connectors.js";
import { nativeMessagingInventories } from "@opensesame/app-core/lib/native-api-messaging-inventories.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { nativeOAuthGuard } from "@opensesame/app-core/lib/native-oauth-session.js";
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
declareConnectionsTutorial();
function line(index = 0) {
  return {
    id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, "0")}`,
    phone_number: "+12025551234",
    line_type: "iMessage",
    reputation: {
      status: "HEALTHY",
      doc_url:
        "https://docs.linqapp.com/channel/imessage/guides/phone-numbers/phone-reputation#healthy",
    },
    forwarding_number: "+12025559999",
    private_data: "private-linq-data",
  };
}
const reply = { phone_numbers: [line()] };
const contract: PrimaryContract = {
  id: "linq",
  name: "Linq",
  origin: "https://api.linqapp.com",
  authorization: `Bearer ${primaryKey}`,
  headers: { accept: "application/json" },
  parameters: {},
  verifyPath: "/api/partner/v3/phone_numbers",
  readPath: "/api/partner/v3/phone_numbers",
  verifyReply: reply,
  reply,
  action: "List messaging lines",
  operation: "provider.phone-numbers.read",
  resultLabel: "Showing 1 of 1 returned messaging lines",
};
const fixtures: Awaited<ReturnType<typeof primaryOracle>>[] = [];
afterEach(async () => {
  cleanup();
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
});
async function oracle() {
  const owned = await primaryOracle(contract);
  fixtures.push(owned);
  return owned;
}
function mount(id?: string) {
  const provider = mergeVercelCatalog(getBundledProviders()).find(
    (row) => row.id === "linq",
  );
  if (!provider) throw new Error("Missing actual Linq catalog provider");
  expect(hasConnectRoute(provider.id)).toBe(true);
  const onFlash = vi.fn();
  return {
    onFlash,
    ...render(
      <MemoryRouter initialEntries={["/settings/connections/linq"]}>
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
  };
}
const draft = () => ({
  providerId: "linq",
  displayName: "Partner messaging lines",
  parameters: {},
  credentials: { api_key: primaryKey },
});
async function saved() {
  const view = await configureNativeApiConnector(draft());
  const driver = nativeConnectorDriver("api-key", "linq");
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
it("appends the official API-key plan without overwriting managed methods or the two existing messaging resources", () => {
  const plan = connectPlan("linq");
  expect(plan?.methods.map((method) => method.kind)).toEqual([
    "managed",
    "api-key",
  ]);
  const method = plan?.methods.find((value) => value.kind === "api-key");
  expect(method).toMatchObject({
    preset: {
      header: "Authorization",
      scheme: "Bearer",
      serviceUrls: ["https://api.linqapp.com/api/partner"],
      verify: {
        method: "GET",
        url: "https://api.linqapp.com/api/partner/v3/phone_numbers",
        requiredFields: ["phone_numbers"],
      },
    },
  });
  expect(
    nativeMessagingInventories.map((resource) => resource.providerId),
  ).toEqual(["messagebird", "telegram"]);
});
it("actual Settings saves a TLS-proved key, cold-restores custody, and reads useful sending lines through the native feature port", async () => {
  const o = await oracle();
  await testNativeApiCredential(draft());
  expect(readDeviceRows().some((row) => row.providerId === "linq")).toBe(false);
  const page = mount();
  expect(screen.getAllByRole("heading", { name: "2 Connect" })).toHaveLength(1);
  expect(page.container.textContent).not.toMatch(
    /no public.*contract|cannot.*browser|managed.*only/i,
  );
  await userEvent.type(screen.getByLabelText(/API key$/), primaryKey);
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Linq" }),
  );
  const action = await screen.findByRole("button", { name: contract.action });
  expect(
    screen.queryByRole("button", { name: /^Check .* access$/ }),
  ).toBeNull();
  expect(screen.getByLabelText(/API key$/)).toHaveProperty("value", "");
  await userEvent.click(action);
  const region = await screen.findByRole("region", {
    name: contract.resultLabel,
  });
  expect(within(region).getAllByRole("listitem")).toHaveLength(1);
  expect(region.textContent).toContain("+12025551234 — iMessage — HEALTHY");
  expect(region.querySelector("a, img")).toBeNull();
  expect(region.textContent).not.toMatch(
    /12025559999|private-linq-data|docs.linqapp/,
  );
  expect(JSON.stringify(readDeviceRows())).not.toContain(primaryKey);
  expect([...o.storage.files.values()].join()).not.toContain(primaryKey);
  page.unmount();
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  const row = readDeviceRows().find((value) => value.providerId === "linq");
  if (!row) throw new Error("Missing actual sealed Linq connection");
  mount(row.connectionId);
  expect(screen.getByLabelText(/API key$/)).toHaveProperty("value", "");
  const driver = nativeConnectorDriver("api-key", "linq");
  await driver.verify(row.connectionId);
  expect(
    await driver.invoke(row.connectionId, contract.operation, {}),
  ).toMatchObject({ label: contract.resultLabel });
  expect(o.requests).toHaveLength(5);
  expect(
    o.requests.every(
      (request) =>
        request.authorized &&
        request.emptyBody &&
        request.path === contract.readPath,
    ),
  ).toBe(true);
  expect(o.context.egressCalls).toEqual([]);
  expect(o.browser).not.toHaveBeenCalled();
});
const configurationFailures = [
  { name: "missing collection", body: {}, status: 200 },
  {
    name: "invalid UUID",
    body: { phone_numbers: [{ ...line(), id: "foreign" }] },
    status: 200,
  },
  {
    name: "failed envelope",
    body: { ...reply, error: { message: "safe provider error" } },
    status: 200,
  },
  ...[401, 403, 429].map((status) => ({
    name: `HTTP${status}`,
    body: { error: primaryKey },
    status,
  })),
];
it.each(configurationFailures)(
  "$name cannot pass Test or save a false connected row",
  async ({ body, status }) => {
    const o = await oracle();
    o.reply(body, status);
    await expect(testNativeApiCredential(draft())).rejects.toThrow();
    const page = mount();
    await userEvent.type(screen.getByLabelText(/API key$/), primaryKey);
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and connect Linq" }),
    );
    await waitFor(() =>
      expect(page.onFlash).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "err" }),
      ),
    );
    expect(readDeviceRows().some((row) => row.providerId === "linq")).toBe(
      false,
    );
    expect(o.requests).toHaveLength(2);
    expect(JSON.stringify(page.onFlash.mock.calls)).not.toContain(primaryKey);
    expect(document.body.textContent).not.toContain(primaryKey);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it.each(["missing", "failed", "oversized", "credential reflection"])(
  "rejects %s resource responses after genuine saved verification",
  async (kind) => {
    const o = await oracle();
    const s = await saved();
    const body =
      kind === "missing"
        ? {}
        : kind === "failed"
          ? { ...reply, error: "failed" }
          : kind === "oversized"
            ? { ...reply, detail: "x".repeat(262145) }
            : { phone_numbers: [{ ...line(), phone_number: primaryKey }] };
    o.reply(body);
    const page = mount(s.view.connectionId);
    await userEvent.click(
      await screen.findByRole("button", { name: contract.action }),
    );
    await screen.findByRole("img", {
      name: /Provider did not return the expected response/,
    });
    expect(
      screen.queryByRole("region", { name: contract.resultLabel }),
    ).toBeNull();
    expect(JSON.stringify(page.onFlash.mock.calls)).not.toContain(primaryKey);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
async function replaceHeldRecord(
  id: string,
  response: ServerResponse | undefined,
) {
  const record = loadNativeConnectorRecord(id);
  if (!record) throw new Error("Missing private saved row");
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    { publicParameters: [], privateCredentials: ["api_key"] },
    (current) => ({
      ...current,
      configuration: {
        ...current.configuration,
        displayName: "Changed owner binding",
      },
    }),
  );
  if (!response) throw new Error("Missing actual held TLS response");
  response.end(`],"phone_numbers":${JSON.stringify(reply.phone_numbers)}}`);
}
it.each(["lease", "node", "vault", "caller", "unmount", "revision"])(
  "%s withdrawal fences the original held TLS resource read",
  async (kind) => {
    const o = await oracle();
    const s = await saved();
    const page = kind === "unmount" ? mount(s.view.connectionId) : null;
    let response: ServerResponse | undefined;
    o.server.once("request", (_request, current) => {
      response = current;
    });
    const caller = new AbortController();
    const held = o.hold();
    const pending = page ? null : s.read(caller.signal);
    const rejected = pending ? expect(pending).rejects.toThrow() : null;
    if (page)
      await userEvent.click(
        await screen.findByRole("button", { name: contract.action }),
      );
    await held.arrived;
    if (kind === "lease") o.context.abort();
    if (kind === "node") o.lifetime.abort();
    if (kind === "vault") vaultStore.lock({ recordLastVault: false });
    if (kind === "caller") caller.abort();
    if (page) page.unmount();
    if (kind === "revision")
      await replaceHeldRecord(s.view.connectionId, response);
    if (rejected) await rejected;
    await closedWithin(held.closed);
    if (kind === "caller") {
      o.reply(reply);
      expect(await s.read()).toMatchObject({ label: contract.resultLabel });
    }
    if (["lease", "node", "vault"].includes(kind)) {
      const count = o.requests.length;
      await expect(s.read()).rejects.toThrow();
      expect(o.requests).toHaveLength(count);
    }
    if (page) expect(page.onFlash).not.toHaveBeenCalled();
    expect(o.context.egressCalls).toEqual([]);
    expect(o.browser).not.toHaveBeenCalled();
  },
);
it("rejects arbitrary caller fields before any provider request", async () => {
  const o = await oracle();
  const s = await saved();
  const driver = nativeConnectorDriver("api-key", "linq");
  const count = o.requests.length;
  for (const key of ["path", "origin", "url"])
    await expect(
      driver.invoke(s.view.connectionId, contract.operation, {
        [key]: key === "path" ? "/v3/chats" : "https://foreign.test",
      }),
    ).rejects.toThrow();
  expect(o.requests).toHaveLength(count);
  expect(readNativeConnector(s.view.connectionId)?.status).toBe("connected");
  expect(o.browser).not.toHaveBeenCalled();
});

it("the independent TLS oracle refuses a wrong Bearer credential without saving a row", async () => {
  const o = await oracle();
  await expect(
    configureNativeApiConnector({
      ...draft(),
      credentials: { api_key: "wrong-linq-credential" },
    }),
  ).rejects.toMatchObject({ code: "authorization" });
  expect(o.requests).toEqual([
    { authorized: false, path: contract.verifyPath, emptyBody: true },
  ]);
  expect(readDeviceRows().some((row) => row.providerId === "linq")).toBe(false);
  expect(o.browser).not.toHaveBeenCalled();
});
