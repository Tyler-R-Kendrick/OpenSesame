/** @vitest-environment jsdom */
import { nativeGoogleBrowserAvailable } from "@opensesame/app-core/browser/native-google-oauth.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { nativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { NativeOAuthClientTarget } from "@opensesame/app-core/lib/native-oauth-client-config.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vercelConnectCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeConnectorForm } from "../../sections/connections/connect/NativeConnectorForm.js";
import { nativeSettingsDescriptor } from "../../sections/connections/connect/NativeConnectorPanels.js";
import { nativeConnectorController } from "../../sections/connections/connect/native-connector-controller.js";
import { nativeProviderDescriptor } from "../../sections/connections/connect/native-provider-descriptor.js";
import {
  googleClient,
  googleRegisteredFixture,
  googleSecret,
  googleUser,
} from "./native-google-registered.test-support.js";
const closes: (() => Promise<void>)[] = [];
const operations: Promise<unknown>[] = [];
beforeEach(() => vi.stubGlobal("crossOriginIsolated", true));
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
  await Promise.allSettled(operations.splice(0));
  vi.unstubAllGlobals();
});
async function setup() {
  const f = await googleRegisteredFixture();
  closes.push(f.close);
  const provider = vercelConnectCatalog().find((row) => row.id === "google");
  if (!provider) throw new Error("Missing Google catalog provider");
  const descriptor = nativeSettingsDescriptor(provider);
  if (!descriptor) throw new Error("Missing Google descriptor");
  const method = descriptor.methods.find((row) => row.id === "oauth");
  if (!method) throw new Error("Missing OAuth form");
  const controller = nativeConnectorController({
    id: "google",
    refused: false,
  });
  return {
    ...f,
    descriptor,
    method,
    controller,
    input: {
      providerId: "google",
      displayName: "Google registered web app",
      method: "oauth" as const,
      parameters: {
        client_id: googleClient,
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        resource: "https://openidconnect.googleapis.com/v1/userinfo",
        token_auth_method: "client_secret_post",
        resource_parameter: "omit",
      },
      credentials: { client_secret: googleSecret },
      requestedScopes: { user: ["openid", "email"] },
      targetIds: {},
    },
  };
}
it("offers and executes the actual registered Google form under isolation while keeping GIS blocked", async () => {
  const f = await setup();
  expect(nativeGoogleBrowserAvailable()).toBe(false);
  await expect(
    f.driver.configure({
      ...f.input,
      parameters: { client_id: googleClient },
      credentials: {},
    }),
  ).rejects.toThrow("isolation");
  const views: NativeConnectorView[] = [];
  render(
    <NativeConnectorForm
      descriptor={f.descriptor}
      controller={f.controller}
      onChanged={(view) => {
        if (view) views.push(view);
      }}
      onFlash={() => {}}
    />,
  );
  expect(screen.getByLabelText("Token endpoint")).toHaveProperty(
    "value",
    "https://oauth2.googleapis.com/token",
  );
  expect(screen.getByLabelText("API resource URL")).toHaveProperty(
    "value",
    "https://openidconnect.googleapis.com/v1/userinfo",
  );
  expect(
    screen.getByLabelText("Authorization resource parameter"),
  ).toHaveProperty("value", "omit");
  fireEvent.change(screen.getByLabelText("OAuth client ID"), {
    target: { value: googleClient },
  });
  fireEvent.change(
    screen.getByLabelText("OAuth client secret", {
      selector: 'input[type="password"]',
    }),
    { target: { value: googleSecret } },
  );
  expect(f.requests).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Sign in to Google" }));
  await waitFor(() => expect(views.at(-1)?.status).toBe("connected"));
  const view = views.at(-1);
  if (!view) throw new Error("Missing connected view");
  const result = await f.driver.invoke(
    view.connectionId,
    "provider.resource.read",
    {},
  );
  expect(JSON.parse(result.items[0]?.secretValue ?? "null")).toEqual(
    googleUser,
  );
  expect(f.requests).toEqual([
    { path: "/token", valid: true },
    { path: "/v1/userinfo", valid: true },
    { path: "/v1/userinfo", valid: true },
  ]);
  expect(f.destinations).toEqual([
    "https://oauth2.googleapis.com/token",
    "https://openidconnect.googleapis.com/v1/userinfo",
    "https://openidconnect.googleapis.com/v1/userinfo",
  ]);
  expect(f.googleToken).not.toHaveBeenCalled();
  expect(f.browserFetch).not.toHaveBeenCalled();
  expect(JSON.stringify(views)).not.toContain(googleSecret);
  expect(
    vaultStore
      .getSnapshot()
      .items.some(
        (item) =>
          item.kind === "credential" &&
          item.method.type === "token" &&
          item.method.token === googleSecret,
      ),
  ).toBe(true);
  f.controller.load();
  await f.controller.remove();
  expect(f.controller.load()).toBeNull();
});
it("stays unverified after configuration and rejects a token error without trying userinfo", async () => {
  const f = await setup();
  const view = await f.driver.configure(f.input);
  expect(view.status).toBe("configuration");
  f.state.deny = true;
  await expect(f.driver.authorize?.(view.connectionId)).rejects.toThrow();
  expect(readNativeConnector(view.connectionId)?.status).not.toBe("connected");
  expect(f.requests.map((row) => row.path)).toEqual(["/token"]);
});
it("forwards the fourth caller signal and retains original native-node ownership", async () => {
  const f = await setup();
  const view = await f.controller.connect(f.input);
  const count = f.requests.length;
  const caller = new AbortController();
  caller.abort();
  await expect(
    f.driver.invoke(
      view.connectionId,
      "provider.resource.read",
      {},
      caller.signal,
    ),
  ).rejects.toThrow();
  expect(f.requests).toHaveLength(count);
  f.state.hold = true;
  const pending = f.driver.invoke(
    view.connectionId,
    "provider.resource.read",
    {},
  );
  const rejected = expect(pending).rejects.toThrow();
  operations.push(rejected);
  await f.entered.promise;
  f.node.lifetime.abort();
  await rejected;
  f.release.resolve();
  expect(f.requests).toHaveLength(count + 1);
  expect(f.browserFetch).not.toHaveBeenCalled();
});
it("adds the registered fallback even when no public OAuth method is in the plan", () => {
  const original = connectPlan("google");
  const profile = nativeBrowserOAuthProfile("google");
  const oauth = original?.methods.find((row) => row.kind === "oauth");
  if (!original || !profile || oauth?.kind !== "oauth" || !oauth.preset)
    throw new Error("Missing compiled Google preset");
  const plan = {
    ...original,
    methods: original.methods.filter((row) => row.kind !== "oauth"),
  };
  const describe = (registeredAvailable: boolean) =>
    nativeProviderDescriptor(plan, {
      callbackUrl: "https://operator.example/auth/native-connector.html",
      apiKey: { available: false },
      oauth: {
        available: false,
        registeredAvailable,
        profile,
        preset: oauth.preset ?? undefined,
      },
      mcp: { available: false, actor: "user" },
    });
  expect(
    describe(true).methods.find((row) => row.id === "oauth"),
  ).toMatchObject({ available: true, runtimeAvailable: true });
  expect(describe(false).methods.some((row) => row.available)).toBe(false);
});
it("keeps absent optional resource behavior unchanged and rejects unknown settings", () => {
  const target = {
    issuer: "https://accounts.google.com",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    resource: "https://openidconnect.googleapis.com/v1/userinfo",
    token_auth_method: "client_secret_post",
  };
  expect(JSON.stringify(NativeOAuthClientTarget.parse(target))).toBe(
    JSON.stringify(target),
  );
  expect(() =>
    NativeOAuthClientTarget.parse({ ...target, resource_parameter: "unknown" }),
  ).toThrow();
});
