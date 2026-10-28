/** @vitest-environment jsdom */
/** Actual mounted common UI/SDK/owned TLS with a typed original node carrier; not WASM acceptance. */
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { captureNativeAuthorizationTransport } from "@opensesame/app-core/lib/native-authorization-transport.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { registerNativeProviderCleanup } from "@opensesame/app-core/lib/native-connector-lifecycle.js";
import { loadNativeConnectorRecord } from "@opensesame/app-core/lib/native-connector-store.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import {
  MCP_KEY,
  type McpCredentialMode,
  bindConfiguredMcpNode,
  configuredMcpFixture,
} from "@opensesame/app-core/lib/native-mcp-configured.test-support.js";
import { nativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
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
const closes: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function setup(mode: McpCredentialMode) {
  const f = await configuredMcpFixture(mode);
  closes.push(f.close);
  const node = await bindConfiguredMcpNode(f);
  closes.push(node.close);
  const test = createTestContext();
  const browserFetch = vi.fn(async () => {
    throw new Error("Unexpected direct browser/other-provider fallback");
  });
  const ctx = {
    ...test.ctx,
    egress: { ...test.ctx.egress, fetch: browserFetch },
  };
  const activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  bindNativeOAuthRuntime(activation);
  closes.push(activation.dispose);
  const authorize = vi.spyOn(nativeOAuthBrowserPort(), "authorize");
  const driver = nativeConnectorDriver("mcp", "adobe");
  closes.push(registerNativeProviderCleanup("adobe", driver.cleanup));
  const popup = vi.spyOn(window, "open").mockReturnValue(null);
  const controller = nativeConnectorController({ id: "adobe", refused: false });
  const plan = connectPlan("adobe");
  if (!plan) throw new Error("Missing real MCP-only provider");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: nativeCallbackUrl(),
    apiKey: { available: false },
    oauth: { available: true, registeredAvailable: true },
    mcp: { available: true, actor: "user" },
  });
  return { ...f, node, authorize, browserFetch, popup, controller, descriptor };
}
it.each(["bearer", "header", "anonymous"] as const)(
  "uses the actual shared %s mode, sealed credential and MCP tools without OAuth or browser fallback",
  async (mode) => {
    const f = await setup(mode);
    expect(() =>
      captureNativeAuthorizationTransport(f.owner.transport),
    ).toThrow("Reserve a fresh provider sign-in window first");
    expect(f.rows).toEqual([]);
    const views: NativeConnectorView[] = [];
    const failures: string[] = [];
    const mounted = render(
      <NativeConnectorForm
        descriptor={f.descriptor}
        controller={f.controller}
        onFlash={(flash) => {
          if (flash.tone === "err") failures.push(flash.text);
        }}
        onChanged={(view) => {
          if (view) views.push(view);
        }}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "MCP" }));
    expect(screen.getByLabelText("MCP authentication")).toHaveProperty(
      "value",
      "oauth",
    );
    fireEvent.change(screen.getByLabelText("MCP authentication"), {
      target: { value: mode },
    });
    expect(screen.getByLabelText("MCP server endpoint")).toHaveProperty(
      "value",
      "https://express-mcp-service.adobe.io/mcp",
    );
    expect(screen.getByLabelText("MCP transport")).toHaveProperty(
      "value",
      "streamable-http",
    );
    expect(screen.queryByText("MCP permissions")).toBeNull();
    fireEvent.change(screen.getByLabelText("MCP server endpoint"), {
      target: { value: f.input.parameters.mcp_url },
    });
    fireEvent.change(screen.getByLabelText("MCP resource audience"), {
      target: { value: f.input.parameters.mcp_resource },
    });
    if (mode === "header")
      fireEvent.change(screen.getByLabelText("MCP credential header"), {
        target: { value: "X-Test-Mcp-Key" },
      });
    if (mode !== "anonymous")
      fireEvent.change(
        screen.getByLabelText("MCP credential", {
          selector: 'input[type="password"]',
        }),
        { target: { value: MCP_KEY } },
      );
    else
      expect(
        screen.queryByLabelText("MCP credential", {
          selector: 'input[type="password"]',
        }),
      ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Verify and connect Adobe" }),
    );
    await expect
      .poll(() => failures[0] ?? views.at(-1)?.status)
      .toBe("connected");
    if (!f.controller.load())
      throw new Error("Missing genuinely verified connection");
    const view = await f.controller.verify();
    expect(view.status).toBe("connected");
    expect(view.configuration.method).toBe("mcp");
    expect(view.configuration.requestedScopes).toEqual({});
    expect(view.grants).toEqual([]);
    expect(
      loadNativeConnectorRecord(view.connectionId)?.privateState.grants,
    ).toEqual({});
    expect(JSON.stringify(view)).not.toContain(MCP_KEY);
    expect(
      vaultStore
        .getSnapshot()
        .items.filter(
          (item) =>
            item.kind === "credential" &&
            item.method.type === "token" &&
            item.method.token === MCP_KEY,
        ),
    ).toHaveLength(mode === "anonymous" ? 0 : 1);
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
    await expect
      .poll(
        () => screen.queryByLabelText("Tool arguments (JSON object)") !== null,
      )
      .toBe(true);
    fireEvent.change(screen.getByLabelText("Tool arguments (JSON object)"), {
      target: { value: '{"text":"mounted safe input"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /echo/ }));
    await expect
      .poll(
        () => screen.queryByText("Credential MCP: mounted safe input") !== null,
      )
      .toBe(true);
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.popup).not.toHaveBeenCalled();
    expect(f.browserFetch).not.toHaveBeenCalled();
    expect(f.node.captures()).toBeGreaterThan(0);
    expect(f.rows.every((row) => row.path === "/mcp" && row.authorized)).toBe(
      true,
    );
    expect(f.faults).toEqual([]);
    await f.controller.remove();
    expect(f.controller.load()).toBeNull();
    expect(
      vaultStore
        .getSnapshot()
        .items.filter(
          (item) =>
            item.kind === "credential" &&
            item.method.type === "token" &&
            item.method.token === MCP_KEY,
        ),
    ).toEqual([]);
  },
);
it("clears a hidden bearer when switching to explicit anonymous and preserves public OAuth as the original default", async () => {
  const f = await setup("anonymous");
  render(
    <NativeConnectorForm
      descriptor={f.descriptor}
      controller={f.controller}
      onFlash={() => {}}
      onChanged={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "MCP" }));
  fireEvent.change(screen.getByLabelText("MCP authentication"), {
    target: { value: "bearer" },
  });
  fireEvent.change(
    screen.getByLabelText("MCP credential", {
      selector: 'input[type="password"]',
    }),
    { target: { value: MCP_KEY } },
  );
  fireEvent.change(screen.getByLabelText("MCP authentication"), {
    target: { value: "anonymous" },
  });
  expect(
    screen.queryByLabelText("MCP credential", {
      selector: 'input[type="password"]',
    }),
  ).toBeNull();
  fireEvent.change(screen.getByLabelText("MCP authentication"), {
    target: { value: "oauth" },
  });
  expect(screen.queryByLabelText("MCP server endpoint")).toBeNull();
  fireEvent.change(screen.getByLabelText("MCP authentication"), {
    target: { value: "bearer" },
  });
  expect(
    screen.getByLabelText("MCP credential", {
      selector: 'input[type="password"]',
    }),
  ).toHaveProperty("value", "");
  expect(f.rows).toEqual([]);
});

it("selects the actual public MCP permissions contract before consent without claiming verification", async () => {
  const f = await setup("anonymous");
  render(
    <NativeConnectorForm
      descriptor={f.descriptor}
      controller={f.controller}
      onFlash={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("radio", { name: "Bring Your Own OAuth App" }),
  );
  expect(
    screen.getByRole("radio", {
      name: "Bring Your Own OAuth App",
    }),
  ).toHaveProperty("checked", true);
  expect(
    screen.queryByLabelText("MCP permissions", { selector: "summary" }),
  ).toBeNull();
  await user.click(screen.getByRole("radio", { name: "MCP" }));
  await user.selectOptions(
    screen.getByLabelText("MCP authentication", { exact: true }),
    "oauth",
  );
  expect(screen.getByRole("radio", { name: "MCP" })).toHaveProperty(
    "checked",
    true,
  );
  expect(
    screen.getByLabelText("MCP authentication", { exact: true }),
  ).toHaveProperty("value", "oauth");
  await user.click(
    screen.getByText("Sign-in options", { selector: "summary" }),
  );
  const permissions = screen.getByLabelText("MCP permissions", {
    selector: "summary",
  });
  await user.click(permissions);
  expect(permissions.closest("details")).toHaveProperty("open", true);
  const openid = screen.getByRole("checkbox", { name: "openid" });
  await user.click(openid);
  expect(openid).toHaveProperty("checked", true);
  expect(
    screen.queryByRole("img", { name: "Adobe access verified" }),
  ).toBeNull();
  expect(f.rows).toEqual([]);
  expect(f.browserFetch).not.toHaveBeenCalled();
  expect(f.popup).not.toHaveBeenCalled();
  expect(f.authorize).not.toHaveBeenCalled();
});
