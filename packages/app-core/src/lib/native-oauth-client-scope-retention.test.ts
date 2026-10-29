import { expect, it } from "vitest";
import { updateNativeConnector } from "./native-connector-store.js";
import {
  beginNativeOAuthClient,
  configureNativeOAuthClient,
  nativeOAuthClientClassification,
} from "./native-oauth-client-config.js";
import { exchangeNativeOAuthClient } from "./native-oauth-client-exchange.js";
import { nativeOAuthClientFixture } from "./native-oauth-client.test-support.js";
import { verifyNativeOAuthMcpResource } from "./native-oauth-mcp-operations.js";
import { verifyNativeOAuthResource } from "./native-oauth-resource.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";

it("requires selected permission evidence when the token endpoint returns scopes", async () => {
  const f = await nativeOAuthClientFixture("none");
  try {
    const saved = await configureNativeOAuthClient(f.input, f.owner);
    const authorization = new URL(
      await beginNativeOAuthClient(saved.connectionId, f.owner),
    );
    f.state.challenge = authorization.searchParams.get("code_challenge") ?? "";
    f.state.scope = "different:scope";
    const search = new URLSearchParams({
      native_state: authorization.searchParams.get("state") ?? "",
      native_code: "one-use-code",
    }).toString();
    await expect(
      exchangeNativeOAuthClient(search, f.owner),
    ).rejects.toMatchObject({ code: "scope" });
    const record = requireNativeOAuthRecord(saved.connectionId);
    expect(record.privateState.grants).toEqual({});
    expect(record.privateState.recovery[0]).toMatchObject({
      credentials: { phase: "verify", protocol_valid: "false" },
      grant: { accessToken: "issued-access-1", scopes: ["different:scope"] },
    });
    await expect(
      verifyNativeOAuthResource(saved.connectionId, f.owner),
    ).rejects.toMatchObject({ code: "cleanup" });
    await expect(
      verifyNativeOAuthMcpResource(saved.connectionId, f.owner),
    ).rejects.toMatchObject({ code: "cleanup" });
    await updateNativeConnector(
      record.connectionId,
      nativeOAuthGuard(record),
      nativeOAuthClientClassification(),
      (current) => {
        const intent = current.privateState.recovery[0];
        if (!intent?.credentials) throw new Error("Missing retained grant");
        intent.credentials.protocol_valid = "true";
        return current;
      },
    );
    await expect(
      verifyNativeOAuthResource(saved.connectionId, f.owner),
    ).rejects.toMatchObject({ code: "scope" });
    await expect(
      verifyNativeOAuthMcpResource(saved.connectionId, f.owner),
    ).rejects.toMatchObject({ code: "scope" });
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});
