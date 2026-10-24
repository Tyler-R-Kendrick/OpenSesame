import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { nativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { registerNativeProviderCleanup } from "@opensesame/app-core/lib/native-connector-lifecycle.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { oauthMcpFixture } from "@opensesame/app-core/lib/native-oauth-mcp.test-support.js";
import { requireNativeOAuthRecord } from "@opensesame/app-core/lib/native-oauth-session.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { NativeConnectorForm } from "../../sections/connections/connect/NativeConnectorForm.js";
import { NativeMcpTools } from "../../sections/connections/connect/NativeMcpTools.js";
import { nativeConnectorController } from "../../sections/connections/connect/native-connector-controller.js";
import { nativeProviderDescriptor } from "../../sections/connections/connect/native-provider-descriptor.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import {
  bindNativeOAuthRuntime,
  nativeCallbackUrl,
} from "./native-oauth-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";
const closes: (() => void | Promise<void>)[] = [];
const operations: Promise<unknown>[] = [];
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
  await Promise.allSettled(operations.splice(0));
});
async function setup(wrongScope = false) {
  const f = await oauthMcpFixture(
    "client_secret_post",
    "json",
    "openid profile",
  );
  closes.push(f.close);
  f.input.providerId = "vercel";
  const endpoint = f.state.resource;
  f.state.resource = new URL("/", endpoint).href;
  f.input.parameters.resource = f.state.resource;
  f.input.parameters.mcp_endpoint = endpoint;
  f.input.parameters.mcp_transport = "streamable-http";
  f.input.parameters.resource_protocol = "mcp";
  if (wrongScope) f.state.scope = "read:tools";
  f.state.redirect = nativeCallbackUrl();
  const test = createTestContext();
  const ctx = {
    ...test.ctx,
    egress: {
      ...test.ctx.egress,
      fetch: async (
        input: string | URL,
        init?: RequestInit,
        meta?: { capability: string; purpose: string },
      ) => {
        expect(meta).toEqual({
          capability: "connectors.external",
          purpose: NATIVE_PROVIDER_PURPOSE,
        });
        return f.owner.transport.fetch(input, init);
      },
    },
  };
  const activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  bindNativeOAuthRuntime(activation);
  closes.push(activation.dispose);
  let cancelled = false;
  closes.push(
    bindNativeOAuthBrowserPort({
      redirectUri: f.state.redirect,
      navigate: () => {
        throw new Error("Unexpected navigation");
      },
      scrubCallback: () => {},
      authorize: async (url) => {
        if (cancelled) throw new Error("Operator cancelled consent");
        const target = new URL(url);
        expect(target.origin + target.pathname).toBe(
          f.input.parameters.authorization_endpoint,
        );
        expect(target.searchParams.get("resource")).toBe(f.state.resource);
        expect(target.searchParams.get("scope")?.split(" ").sort()).toEqual([
          "openid",
          "profile",
        ]);
        expect(target.searchParams.get("client_id")).toBe(
          f.input.parameters.client_id,
        );
        expect(target.searchParams.get("code_challenge_method")).toBe("S256");
        expect(target.searchParams.has("client_secret")).toBe(false);
        f.state.challenge = target.searchParams.get("code_challenge") ?? "";
        return new URLSearchParams({
          native_state: target.searchParams.get("state") ?? "",
          native_code: "one-use-code",
        }).toString();
      },
    }),
  );
  const driver = nativeConnectorDriver("oauth", "vercel");
  closes.push(registerNativeProviderCleanup("vercel", driver.cleanup));
  return {
    ...f,
    activation,
    driver,
    controller: nativeConnectorController({
      id: "vercel",
      refused: false,
    }),
    cancel: () => {
      cancelled = true;
    },
  };
}
function mount(f: Awaited<ReturnType<typeof setup>>) {
  const plan = connectPlan("vercel");
  const profile = nativeBrowserOAuthProfile("vercel");
  if (!plan || !profile) throw new Error("Missing real Vercel contract");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: nativeCallbackUrl(),
    apiKey: { available: false },
    oauth: { available: true, registeredAvailable: true, profile },
    mcp: { available: false, actor: "user" },
  });
  const views: NativeConnectorView[] = [];
  const failures: string[] = [];
  const mounted = render(
    <NativeConnectorForm
      descriptor={descriptor}
      controller={f.controller}
      onFlash={(flash) => {
        if (flash.tone === "err") failures.push(flash.text);
      }}
      onChanged={(view) => {
        if (view) views.push(view);
      }}
    />,
  );
  expect(screen.getByLabelText("OAuth application")).toHaveProperty(
    "value",
    "provider",
  );
  expect(screen.queryByLabelText("MCP server endpoint")).toBeNull();
  fireEvent.change(screen.getByLabelText("OAuth application"), {
    target: { value: "client_secret_post" },
  });
  expect(screen.getByLabelText("Resource API protocol")).toHaveProperty(
    "value",
    "",
  );
  expect(screen.queryByLabelText("MCP server endpoint")).toBeNull();
  fireEvent.change(screen.getByLabelText("Resource API protocol"), {
    target: { value: "mcp" },
  });
  expect(screen.getByLabelText("Resource API protocol")).toHaveProperty(
    "value",
    "mcp",
  );
  expect(screen.getByLabelText("MCP server endpoint")).toHaveProperty(
    "value",
    "https://mcp.vercel.com",
  );
  expect(screen.getByLabelText("MCP transport")).toHaveProperty(
    "value",
    "streamable-http",
  );
  for (const [label, key] of [
    ["OAuth client ID", "client_id"],
    ["OAuth issuer URL", "issuer"],
    ["Authorization endpoint", "authorization_endpoint"],
    ["Token endpoint", "token_endpoint"],
    ["API resource URL", "resource"],
    ["MCP server endpoint", "mcp_endpoint"],
  ])
    fireEvent.change(screen.getByLabelText(label ?? ""), {
      target: { value: f.input.parameters[key ?? ""] },
    });
  fireEvent.change(
    screen.getByLabelText("OAuth client secret", {
      selector: 'input[type="password"]',
    }),
    { target: { value: f.input.credentials.client_secret } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Sign in to Vercel" }));
  return { mounted, views, failures };
}
it("clicks the actual common registered mode, seals its secret and consumes an MCP tool at a distinct audience and endpoint", async () => {
  const f = await setup();
  const { mounted, views, failures } = mount(f);
  await expect
    .poll(() => failures[0] ?? views.at(-1)?.status)
    .toBe("connected");
  const view = f.controller.load();
  if (!view) throw new Error("Missing verified MCP connection");
  expect(view.configuration.parameters).toMatchObject({
    resource: f.state.resource,
    mcp_endpoint: f.input.parameters.mcp_endpoint,
    resource_protocol: "mcp",
    mcp_transport: "streamable-http",
  });
  expect([...(view.configuration.requestedScopes.user ?? [])].sort()).toEqual([
    "openid",
    "profile",
  ]);
  expect(
    [
      ...(requireNativeOAuthRecord(view.connectionId).privateState.grants.user
        ?.scopes ?? []),
    ].sort(),
  ).toEqual(["openid", "profile"]);
  expect(JSON.stringify(views)).not.toContain(
    f.input.credentials.client_secret,
  );
  expect(
    vaultStore
      .getSnapshot()
      .items.some(
        (item) =>
          item.kind === "credential" &&
          item.method.type === "token" &&
          item.method.token === f.input.credentials.client_secret,
      ),
  ).toBe(true);
  mounted.unmount();
  render(
    <NativeMcpTools
      view={view}
      controller={f.controller}
      onFlash={() => {}}
      onChanged={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Discover MCP tools" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Tool arguments (JSON object)")).toBeTruthy(),
  );
  fireEvent.change(screen.getByLabelText("Tool arguments (JSON object)"), {
    target: { value: JSON.stringify({ text: "mounted real tool" }) },
  });
  fireEvent.click(screen.getByRole("button", { name: /echo:/ }));
  await waitFor(() =>
    expect(screen.getByText("Actual MCP: mounted real tool")).toBeTruthy(),
  );
  expect(f.rows.filter((row) => row.rpc === "tools/call")).toHaveLength(1);
  expect(f.rows.every((row) => row.authenticated)).toBe(true);
  expect(f.faults).toEqual([]);
});
it("refuses an independently issued insufficient scope before MCP verification and retains the issued obligation", async () => {
  const f = await setup(true);
  const { failures } = mount(f);
  await expect.poll(() => failures.length).toBe(1);
  expect(f.state.issued).toBe(1);
  const view = f.controller.load();
  if (!view) throw new Error("Missing saved pending connection");
  expect(view.status).not.toBe("connected");
  const record = requireNativeOAuthRecord(view.connectionId);
  expect(record.runtime.verifiedAt).toBeNull();
  expect(record.privateState.grants).toEqual({});
  expect(
    record.privateState.recovery.some((intent) =>
      intent.grant?.scopes?.includes("read:tools"),
    ),
  ).toBe(true);
  expect(f.rows.some((row) => row.path === "/mcp")).toBe(false);
});
