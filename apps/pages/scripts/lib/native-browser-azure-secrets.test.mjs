import { azureSecretsKeyFlows } from "@opensesame/app-core/lib/native-azure-secrets.js";
/** @vitest-environment node */
import {
  azureClosed,
  azureDraft,
  azureOracle,
  azureToken,
} from "@opensesame/app-core/lib/native-azure-secrets.test-support.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import {
  AZURE_API_VERSION,
  azureSecretBundle,
  azureSecretPage,
  azureSecretReference,
  azureVaultBase,
} from "@opensesame/app-core/lib/secret-backends/azure-key-vault-codec.js";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnectorActions } from "../../src/sections/connections/connect/NativeConnectorActions.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "../../src/sections/connections/connect/native-connector-integration.test-support.js";
import {
  AZURE_SECRETS_FIXTURE,
  azureBrowserReplies,
  routeNativeAzureSecretsAuthority,
} from "./native-browser-azure-secrets.mjs";

installConnectorIntegration();
const closes = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
it("keeps the official same-vault list and versioned secret JSON valid under actual production codecs", () => {
  const f = AZURE_SECRETS_FIXTURE;
  expect(f.apiVersion).toBe(AZURE_API_VERSION);
  const base = azureVaultBase(f.vaultURL);
  const replies = azureBrowserReplies();
  expect(azureSecretPage(replies.page, base).items).toEqual([
    { id: `${f.vaultURL}/secrets/api-key`, name: "api-key", kind: "secret" },
  ]);
  expect(
    azureSecretBundle(
      replies.bundle,
      base,
      azureSecretReference("api-key", base),
    ),
  ).toEqual(replies.bundle);
  expect(JSON.stringify(replies.page)).not.toContain(f.value);
  expect(JSON.stringify(replies.page)).not.toContain(f.token);
  replies.page.value.length = 0;
  expect(azureBrowserReplies().page.value).toHaveLength(1);
});

async function authority() {
  let handler;
  const state = {
    calls: [],
    reject: new Set(),
    expectedResponses: new WeakMap(),
  };
  await routeNativeAzureSecretsAuthority(
    {
      route: async (_match, callback) => {
        handler = callback;
      },
    },
    { state },
    { check: (ok, message) => expect(ok, message).toBe(true) },
  );
  return {
    state,
    async dispatch(path, extra = {}, method = "GET", body = null) {
      let reply = { status: 404 };
      const request = {
        url: () => `${AZURE_SECRETS_FIXTURE.vaultURL}${path}`,
        method: () => method,
        postData: () => body,
        allHeaders: async () => ({
          authorization: `Bearer ${AZURE_SECRETS_FIXTURE.token}`,
          accept: "application/json",
          ...extra,
        }),
      };
      await handler({
        request: () => request,
        fallback: async () => {},
        fulfill: async (value) => {
          reply = value;
        },
      });
      return reply;
    },
  };
}
it("answers only supplied Key Vault audience credential list/get contracts without inventing writes", async () => {
  const o = await authority();
  const list = await o.dispatch(
    "/secrets?api-version=2025-07-01&maxresults=25",
  );
  const get = await o.dispatch("/secrets/api-key?api-version=2025-07-01");
  expect(list.status).toBe(200);
  expect(get.status).toBe(200);
  expect(JSON.parse(list.body)).toEqual(azureBrowserReplies().page);
  expect(JSON.parse(get.body)).toEqual(azureBrowserReplies().bundle);
  expect(
    o.state.calls.map(({ purpose, operation }) => [purpose, operation]),
  ).toEqual([
    ["shared", "provider.secrets.read"],
    ["resource", "provider.secret.read"],
  ]);
});
it.each([
  ["/secrets?api-version=2025-07-01&maxresults=26", {}, "GET", null],
  ["/secrets?api-version=7.4&maxresults=25", {}, "GET", null],
  [
    "/secrets?api-version=2025-07-01&maxresults=25&url=https://other.example",
    {},
    "GET",
    null,
  ],
  ["/secrets/api-key?api-version=2025-07-01&maxresults=25", {}, "GET", null],
  ["/keys?api-version=2025-07-01&maxresults=25", {}, "GET", null],
  [
    "/secrets?api-version=2025-07-01&maxresults=25",
    { cookie: "session=wrong" },
    "GET",
    null,
  ],
  ["/secrets?api-version=2025-07-01&maxresults=25", {}, "POST", null],
  ["/secrets/api-key?api-version=2025-07-01", {}, "PUT", "{}"],
])(
  "refuses unsupported wire shape before recording a positive request %#",
  async (path, headers, method, body) => {
    const o = await authority();
    expect((await o.dispatch(path, headers, method, body)).status).toBe(404);
    expect(o.state.calls).toEqual([]);
  },
);
it.each(["Bearer browser-protocol-only-graph-token", "Basic wrong", ""])(
  "reports refused credentials without a successful protocol result %#",
  async (authorization) => {
    const o = await authority();
    expect(
      (
        await o.dispatch("/secrets?api-version=2025-07-01&maxresults=25", {
          authorization,
        })
      ).status,
    ).toBe(401);
    expect(o.state.calls).toHaveLength(1);
  },
);
async function oracle() {
  const dom = new JSDOM("", { url: "https://selfhost.example/OpenSesame/" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  closes.push(async () => dom.window.close());
  const fixture = connectorIntegration();
  const o = await azureOracle();
  closes.push(() => o.close());
  fixture.route.respond = (request) => o.transport.fetch(request);
  return { ...o, fixture };
}
it("consumes actual browser fixture JSON through real TLS, sealed cold custody, and useful masked secret value", async () => {
  const o = await oracle();
  o.reply(azureBrowserReplies().page);
  const driver = nativeConnectorDriver("api-key", "azure-sm");
  const view = await driver.configure({
    ...azureDraft(),
    method: "api-key",
    requestedScopes: {},
    targetIds: {},
  });
  expect(
    await driver.invoke(view.connectionId, "provider.secrets.read", {}),
  ).toMatchObject({
    label: "Showing 1 secret names from first page",
    items: [{ label: "api-key" }],
  });
  o.reply(azureBrowserReplies().bundle);
  expect(
    await driver.invoke(view.connectionId, "provider.secret.read", {
      name: "api-key",
    }),
  ).toMatchObject({
    label: "Secret read once",
    items: [{ label: "api-key", secretValue: AZURE_SECRETS_FIXTURE.value }],
  });
  expect([...o.fixture.disk.files.values()].join()).not.toContain(azureToken);
  expect([...o.fixture.disk.files.values()].join()).not.toContain(
    AZURE_SECRETS_FIXTURE.value,
  );
  await o.fixture.reload();
  o.reply(azureBrowserReplies().page);
  expect(
    await driver.invoke(view.connectionId, "provider.secrets.read", {}),
  ).toMatchObject({ items: [{ label: "api-key" }] });
  expect(o.requests.every(({ authorized }) => authorized)).toBe(true);
});
it("physically closes the current owned TLS stream on actual activation withdrawal", async () => {
  const o = await oracle();
  const driver = nativeConnectorDriver("api-key", "azure-sm");
  const view = await driver.configure({
    ...azureDraft(),
    method: "api-key",
    requestedScopes: {},
    targetIds: {},
  });
  const held = o.hold();
  const pending = driver.invoke(view.connectionId, "provider.secrets.read", {});
  const rejected = expect(pending).rejects.toThrow();
  await held.arrived.promise;
  o.fixture.activation.dispose();
  await rejected;
  await azureClosed(held.closed.promise);
  await expect(
    driver.invoke(view.connectionId, "provider.secrets.read", {}),
  ).rejects.toThrow();
  expect(o.requests).toHaveLength(2);
});

it("recognizes actual shared Azure action summaries before expanding their closed native disclosures", async () => {
  const o = await oracle();
  o.reply(azureBrowserReplies().page);
  const driver = nativeConnectorDriver("api-key", "azure-sm");
  const view = await driver.configure({
    ...azureDraft(),
    method: "api-key",
    requestedScopes: {},
    targetIds: {},
  });
  const ui = azureSecretsKeyFlows.ui("azure-sm");
  const element = document.createElement("div");
  element.innerHTML = renderToStaticMarkup(
    createElement(NativeConnectorActions, {
      descriptor: {
        providerId: "azure-sm",
        name: ui.name,
        methods: [],
        docsUrl: null,
        actions: ui.actions.map((action) => ({
          ...action,
          available: true,
          resultOrigins: [],
        })),
      },
      controller: { invoke: driver.invoke },
      view,
      onChanged: () => {},
      onFlash: () => {},
    }),
  );
  const details = [...element.querySelectorAll("details")];
  expect(
    details.map((detail) => detail.querySelector("summary")?.textContent),
  ).toEqual(["List secret names", "Read a secret"]);
  for (const detail of details) {
    expect(detail.open).toBe(false);
    expect(detail.querySelector("button[type=submit]")).not.toBeNull();
    detail.open = true;
    expect(detail.open).toBe(true);
  }
  expect(o.requests).toHaveLength(1);
});
