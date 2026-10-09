import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
/** @vitest-environment jsdom */
import {
  beginNativeMcpAuthorization,
  configureNativeMcpConnector,
} from "@opensesame/app-core/lib/native-mcp-connectors.js";
import { fixture as oauthResponse } from "@opensesame/app-core/lib/native-mcp-oauth-fixtures.test-helper.js";
import { nativeMcpRecordOAuthTarget } from "@opensesame/app-core/lib/native-mcp-profile.js";
import { requireNativeMcpRecord } from "@opensesame/app-core/lib/native-mcp-records.js";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";
import { useProviderCallbacks } from "./useProviderCallbacks.js";
installConnectorIntegration();
const Rpc = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
});
it("routes a sealed MCP callback to its resource protocol despite contradictory query parameters", async () => {
  const fixture = connectorIntegration();
  const saved = await configureNativeMcpConnector({
    providerId: "adobe",
    method: "mcp",
    displayName: "Adobe tools",
    parameters: {},
    credentials: {},
    requestedScopes: { user: [] },
    targetIds: {},
  });
  const methods: string[] = [];
  fixture.route.respond = async (request) => {
    const target = nativeMcpRecordOAuthTarget(
      requireNativeMcpRecord(saved.connectionId).configuration,
    );
    if (request.url !== target.binding.endpoint)
      return oauthResponse(target).ports.fetch(request);
    if (request.method === "GET") return new Response(null, { status: 405 });
    const rpc = Rpc.parse(JSON.parse(await request.text()));
    methods.push(rpc.method);
    if (rpc.method.startsWith("notifications/"))
      return new Response(null, { status: 202 });
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "Adobe resource", version: "1.0" },
          }
        : { tools: [] };
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  };
  await beginNativeMcpAuthorization(saved.connectionId);
  const pending = loadNativeConnectorRecord(saved.connectionId)?.privateState
    .pending.user;
  if (!pending) throw new Error("Missing MCP transaction");
  const onFlash = vi.fn();
  const reload = vi.fn(async () => {});
  function Callback() {
    const location = useLocation();
    useProviderCallbacks(location.search, reload, onFlash);
    return (
      <output aria-label="Current route">
        {location.pathname}
        {location.search}
      </output>
    );
  }
  const search = new URLSearchParams({
    native_state: pending.state,
    native_code: "mcp-one-use-code",
    method: "oauth",
    provider: "gitlab",
  });
  render(
    <MemoryRouter initialEntries={[`/connections?${search}`]}>
      <Callback />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Current route").textContent).toBe(
      `/connections/adobe/${saved.connectionId}`,
    ),
  );
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  expect(methods).toContain("initialize");
  expect(methods).toContain("tools/list");
  const tokenRequests = fixture.requests.filter(
    (request) => request.url === "https://ims-na1.adobelogin.com/ims/token/v3",
  );
  expect(tokenRequests).toHaveLength(1);
  expect(new URLSearchParams(await tokenRequests[0]?.text()).get("code")).toBe(
    "mcp-one-use-code",
  );
  expect(
    fixture.requests.some((request) =>
      request.url.startsWith("https://gitlab.com"),
    ),
  ).toBe(false);
  expect(onFlash).toHaveBeenLastCalledWith(
    expect.objectContaining({ tone: "ok" }),
  );
});
