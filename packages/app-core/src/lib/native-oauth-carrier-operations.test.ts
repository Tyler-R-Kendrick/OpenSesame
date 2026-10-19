import { afterEach, expect, it } from "vitest";
import {
  captureOAuthCarrier,
  nativeOAuthCarrierFixture,
} from "./native-oauth-carrier.test-support.js";
import {
  beginNativeOAuthClient,
  configureNativeOAuthClient,
} from "./native-oauth-client-config.js";
import type { NativeOAuthClientOwner } from "./native-oauth-client-config.js";
import { exchangeNativeOAuthClient } from "./native-oauth-client-exchange.js";
import {
  invokeNativeOAuthMcpTool,
  verifyNativeOAuthMcpResource,
} from "./native-oauth-mcp-operations.js";
import { oauthMcpFixture } from "./native-oauth-mcp.test-support.js";
import { verifyNativeOAuthResource } from "./native-oauth-resource.js";
import { requireNativeOAuthRecord } from "./native-oauth-session.js";
const closing: (() => Promise<void>)[] = [];
const pending: Promise<unknown>[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  await Promise.allSettled(pending.splice(0));
});
async function authorization(
  id: string,
  owner: NativeOAuthClientOwner,
  state: { challenge: string },
) {
  const url = new URL(await beginNativeOAuthClient(id, owner));
  state.challenge = url.searchParams.get("code_challenge") ?? "";
  return new URLSearchParams({
    native_state: url.searchParams.get("state") ?? "",
    native_code: "one-use-code",
  }).toString();
}
it("exchanges and consumes a real HTTPS resource with the captured carrier, then refuses a withdrawn route before another read", async () => {
  const f = await nativeOAuthCarrierFixture();
  closing.push(f.close);
  const saved = await configureNativeOAuthClient(f.input, f.owner);
  await exchangeNativeOAuthClient(
    await authorization(saved.connectionId, f.owner, f.state),
    f.owner,
  );
  const verified = await verifyNativeOAuthResource(saved.connectionId, f.owner);
  expect(verified.view.status).toBe("connected");
  expect(verified.body).toEqual({
    projects: [{ id: "project-42", name: "Actual configured project" }],
  });
  expect(f.requests.map((row) => row.path)).toEqual(["/token", "/resource"]);
  f.withdrawRoute();
  await expect(
    verifyNativeOAuthResource(saved.connectionId, f.owner),
  ).rejects.toThrow();
  expect(f.requests).toHaveLength(2);
  expect(f.capture).toHaveBeenCalledTimes(1);
});
it("runs an actual HTTPS MCP primary tool operation through the captured owner and refuses stale origin support", async () => {
  const f = await oauthMcpFixture("client_secret_basic");
  const captured = captureOAuthCarrier(
    f.owner,
    new URL(f.input.parameters.token_endpoint ?? "").origin,
  );
  closing.push(async () => {
    captured.close();
    await f.close();
  });
  const input = {
    ...f.input,
    providerId: "resend",
    parameters: { ...f.input.parameters, resource_protocol: "mcp" },
  };
  const saved = await configureNativeOAuthClient(input, captured.owner);
  await exchangeNativeOAuthClient(
    await authorization(saved.connectionId, captured.owner, f.state),
    captured.owner,
  );
  await verifyNativeOAuthMcpResource(saved.connectionId, captured.owner);
  await expect(
    invokeNativeOAuthMcpTool(
      saved.connectionId,
      "echo",
      { text: "captured native policy" },
      captured.owner,
    ),
  ).resolves.toMatchObject({
    structuredContent: { echo: "Actual MCP: captured native policy" },
  });
  const before = f.rows.length;
  captured.withdrawRoute();
  await expect(
    invokeNativeOAuthMcpTool(
      saved.connectionId,
      "echo",
      { text: "must refuse" },
      captured.owner,
    ),
  ).rejects.toThrow();
  expect(f.rows).toHaveLength(before);
  expect(captured.capture).toHaveBeenCalledTimes(1);
  expect(f.faults).toEqual([]);
});
it.each(["authorization", "owner"] as const)(
  "an already-sent credential mutation settles into the original durable journal after %s withdrawal",
  async (cause) => {
    const f = await nativeOAuthCarrierFixture();
    closing.push(f.close);
    const saved = await configureNativeOAuthClient(f.input, f.owner);
    const search = await authorization(saved.connectionId, f.owner, f.state);
    f.state.hold = true;
    const operation = exchangeNativeOAuthClient(search, f.owner);
    pending.push(operation);
    const refused = expect(operation).rejects.toThrow();
    await f.entered.promise;
    if (cause === "authorization") f.authorization.abort();
    else f.controller.abort();
    f.release.resolve();
    await refused;
    const record = requireNativeOAuthRecord(saved.connectionId);
    expect(f.state.issued).toBe(1);
    expect(f.requests).toHaveLength(1);
    expect(record.privateState.grants).toEqual({});
    expect(record.privateState.recovery[0]?.grant?.accessToken).toBe(
      "issued-access-1",
    );
    await expect(
      beginNativeOAuthClient(saved.connectionId, f.owner),
    ).rejects.toThrow();
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(f.requests).toHaveLength(1);
  },
);
