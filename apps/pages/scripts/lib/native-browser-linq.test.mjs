/** @vitest-environment node */
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
import { projectLinqMessagingLines } from "@opensesame/app-core/lib/native-api-messaging-inventories.js";
import { nativeApiResourceActions } from "@opensesame/app-core/lib/native-api-resources.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import {
  primaryKey,
  primaryOracle,
} from "../../src/sections/connections/connect/native-api-primary.test-support.js";
import { installConnectorIntegration } from "../../src/sections/connections/connect/native-connector-integration.test-support.js";
import { routeNativeApiAuthority } from "./native-browser-api-authority.mjs";
import {
  NATIVE_REPRESENTATIVE_API_IDS,
  nativeApiFixture,
  nativeBrowserPlans,
} from "./native-browser-provider-fixtures.mjs";

installConnectorIntegration();
const plan = nativeBrowserPlans().find((row) => row.id === "linq");
const fixture = () => nativeApiFixture(plan);
const closes = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
it("requires Linq in the representative journey and preserves the real shared read contract", () => {
  const protocol = fixture();
  expect(NATIVE_REPRESENTATIVE_API_IDS).toContain("linq");
  expect(plan.methods.map(({ kind }) => kind)).toEqual(["managed", "api-key"]);
  expect(protocol.preset.auth).toEqual({
    kind: "header",
    header: "Authorization",
    scheme: "Bearer",
    valueTemplate: null,
  });
  expect(protocol.preset.verify).toMatchObject({
    method: "GET",
    url: "https://api.linqapp.com/api/partner/v3/phone_numbers",
    headers: { Accept: "application/json" },
    body: null,
    requiredFields: ["phone_numbers"],
  });
  expect(protocol.read).toMatchObject({
    method: "GET",
    url: protocol.preset.verify.url,
    headers: { Accept: "application/json" },
  });
  expect(nativeApiResourceActions("linq", "api-key")).toEqual([
    { id: "provider.phone-numbers.read", label: "List messaging lines" },
  ]);
  for (const reply of [protocol.reply, protocol.read.reply])
    expect(projectLinqMessagingLines(reply)).toEqual(protocol.read.result);
  for (const value of [
    ...protocol.read.excludedText,
    ...Object.values(protocol.credentials),
  ])
    expect(JSON.stringify(protocol.read.result)).not.toContain(value);
});
it("keeps typed arrays and nested probe/read replies independently owned", () => {
  const first = fixture();
  first.reply.phone_numbers[0].reputation.status = "CRITICAL";
  first.reply.phone_numbers.length = 0;
  expect(first.read.reply.phone_numbers[0].reputation.status).toBe("HEALTHY");
  first.read.reply.phone_numbers.length = 0;
  expect(projectLinqMessagingLines(fixture().reply).items).toHaveLength(1);
  expect(projectLinqMessagingLines(fixture().read.reply).items).toHaveLength(1);
});
it.each(["not-an-array", [{ id: "not-a-line" }]])(
  "keeps actual strict parsing for malformed browser fixture payload %#",
  (phone_numbers) => {
    expect(() => projectLinqMessagingLines({ phone_numbers })).toThrow();
  },
);

async function oracle() {
  const dom = new JSDOM("", { url: "https://selfhost.example/OpenSesame/" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  closes.push(async () => dom.window.close());
  const protocol = fixture();
  const owned = await primaryOracle({
    id: "linq",
    name: "Linq",
    origin: "https://api.linqapp.com",
    authorization: `Bearer ${primaryKey}`,
    headers: { accept: "application/json" },
    parameters: {},
    verifyPath: "/api/partner/v3/phone_numbers",
    readPath: "/api/partner/v3/phone_numbers",
    verifyReply: protocol.reply,
    reply: protocol.read.reply,
    action: protocol.read.label,
    operation: protocol.read.id,
    resultLabel: protocol.read.result.label,
  });
  closes.push(() => owned.close());
  return owned;
}
async function saved() {
  const view = await configureNativeApiConnector({
    providerId: "linq",
    displayName: "Fixture messaging lines",
    parameters: {},
    credentials: { api_key: primaryKey },
  });
  const driver = nativeConnectorDriver("api-key", "linq");
  return {
    view,
    read: () => driver.invoke(view.connectionId, fixture().read.id, {}),
  };
}
it("consumes both documented replies over real owned TLS and encrypted cold custody", async () => {
  const o = await oracle();
  const s = await saved();
  expect(await s.read()).toEqual(fixture().read.result);
  expect(JSON.stringify(readDeviceRows())).not.toContain(primaryKey);
  expect([...o.storage.files.values()].join()).not.toContain(primaryKey);
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  expect(await s.read()).toEqual(fixture().read.result);
  expect(o.requests).toEqual(
    Array(3).fill({
      authorized: true,
      path: "/api/partner/v3/phone_numbers",
      emptyBody: true,
    }),
  );
  expect(o.browser).not.toHaveBeenCalled();
});
it("physically closes a held fixture resource stream on original node withdrawal", async () => {
  const o = await oracle();
  const s = await saved();
  const held = o.hold();
  const pending = s.read();
  const rejected = expect(pending).rejects.toThrow();
  await held.arrived;
  o.lifetime.abort();
  await rejected;
  let closed = false;
  void held.closed.then(() => {
    closed = true;
  });
  await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 });
  await expect(s.read()).rejects.toThrow();
  expect(o.requests).toHaveLength(2);
  expect(o.browser).not.toHaveBeenCalled();
});
it.each([
  ["/api/partner/v3/phone_numbers?limit=20", {}],
  ["/v3/phone_numbers", {}],
  ["/api/partner/v3/phone_numbers", { authorization: "Bearer wrong-key" }],
])(
  "refuses query/mount/credential drift on independent TLS %#",
  async (path, extra) => {
    const o = await oracle();
    const response = await o.fetch(`https://api.linqapp.com${path}`, {
      headers: {
        authorization: `Bearer ${primaryKey}`,
        accept: "application/json",
        ...extra,
      },
    });
    expect(response.status).toBe(401);
    await response.text();
    expect(o.requests).toEqual([{ authorized: false, path, emptyBody: true }]);
    expect(o.browser).not.toHaveBeenCalled();
  },
);

/** Exercise unchanged browser matcher semantics; this is not the TLS proof above. */
async function protocolAuthority() {
  const handlers = [];
  const authority = await routeNativeApiAuthority(
    {
      route: async (match, handle) => {
        handlers.push({ match, handle });
      },
    },
    { check: (ok, message) => expect(ok, message).toBe(true) },
  );
  return {
    authority,
    async dispatch(path, extra = {}, method = "GET") {
      const protocol = fixture();
      const request = new Request(`https://api.linqapp.com${path}`, {
        method,
        headers: {
          authorization: `Bearer ${protocol.credentials.api_key}`,
          accept: "application/json",
          ...extra,
        },
      });
      const matches = handlers
        .filter(({ match }) => match(new URL(request.url)))
        .reverse();
      let reply = { status: 404 };
      async function next(index) {
        const entry = matches[index];
        if (!entry) return;
        await entry.handle({
          request: () => ({
            url: () => request.url,
            method: () => request.method,
            allHeaders: async () => Object.fromEntries(request.headers),
            postData: () => null,
          }),
          fallback: () => next(index + 1),
          fulfill: async (value) => {
            reply = value;
          },
        });
      }
      await next(0);
      return reply;
    },
  };
}
it("identifies the identical verify/read browser wire contract as shared authority", async () => {
  const o = await protocolAuthority();
  const reply = await o.dispatch("/api/partner/v3/phone_numbers");
  expect(reply.status).toBe(200);
  expect(projectLinqMessagingLines(JSON.parse(reply.body))).toEqual(
    fixture().read.result,
  );
  expect(o.authority.state.calls).toEqual([
    expect.objectContaining({
      providerId: "linq",
      purpose: "shared",
      operation: "provider.phone-numbers.read",
    }),
  ]);
});
it.each([
  ["/api/partner/v3/phone_numbers?limit=20", {}, "GET"],
  ["/v3/phone_numbers", {}, "GET"],
  [
    "/api/partner/v3/phone_numbers",
    { authorization: "Bearer wrong-key" },
    "GET",
  ],
  ["/api/partner/v3/phone_numbers", { cookie: "session=wrong" }, "GET"],
  ["/api/partner/v3/phone_numbers", {}, "POST"],
])(
  "refuses drift in the unchanged browser request matcher %#",
  async (path, headers, method) => {
    const o = await protocolAuthority();
    expect((await o.dispatch(path, headers, method)).status).toBe(404);
    expect(o.authority.state.calls).toEqual([]);
  },
);
