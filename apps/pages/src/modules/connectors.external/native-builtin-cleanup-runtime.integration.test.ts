// @vitest-environment jsdom
/** Builtin providers must be removable through the production activation, even without a generated plan. */
import { deviceProviderRevokers } from "@opensesame/app-core/lib/device-connectors.js";
import { modelMemoryBackend } from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import type { NativeDriverInput } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeConnectorController } from "../../sections/connections/connect/native-connector-controller.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindProviderRuntime } from "./native-runtime.js";

const disposers: (() => void)[] = [];
beforeEach(() => {
  kvForgetAll();
  modelMemoryBackend();
});
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
});
type Builtin = { input: NativeDriverInput; response: () => Response };
const providers: Builtin[] = [
  {
    input: {
      providerId: "github",
      method: "api-key",
      displayName: "GitHub",
      parameters: {},
      credentials: { api_key: "private-github-personal-token" },
      requestedScopes: {},
      targetIds: {},
    },
    response: () =>
      Response.json({ id: 12345, login: "octocat", type: "User" }),
  },
  {
    input: {
      providerId: "s3",
      method: "api-key",
      displayName: "S3",
      parameters: {
        endpoint: "https://minio.example.test",
        bucket: "test-bucket",
        region: "us-east-1",
        access_key_id: "public-key-id",
        prefix: "",
      },
      credentials: {
        secret_access_key: "private-signing-secret",
        session_token: "private-session-token",
      },
      requestedScopes: {},
      targetIds: {},
    },
    response: () =>
      new Response(
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><Prefix/><IsTruncated>false</IsTruncated></ListBucketResult>',
        { headers: { "Content-Type": "application/xml" } },
      ),
  },
];
function activate(provider: Builtin) {
  const test = createTestContext();
  const fetcher = vi.fn<typeof test.ctx.egress.fetch>(async () =>
    provider.response(),
  );
  const ctx = { ...test.ctx, egress: { ...test.ctx.egress, fetch: fetcher } };
  const activation = createActivation(ctx, "connectors.external");
  disposers.push(activation.dispose);
  bindProviderRuntime(ctx, activation);
  return { activation, fetcher };
}
it.each(providers)(
  "removes $input.providerId through the production controller and registered device revoker",
  async (provider) => {
    const { fetcher } = activate(provider);
    const controller = nativeConnectorController({
      id: provider.input.providerId,
      refused: false,
    });
    const saved = await controller.configure(provider.input);
    expect(saved.status).toBe("connected");
    await controller.remove();
    expect(controller.load()).toBeNull();
    expect(readNativeConnector(saved.connectionId)).toBeNull();
    const next = await controller.configure(provider.input);
    const revoke = deviceProviderRevokers[provider.input.providerId];
    if (!revoke) throw new Error("Missing production builtin revoker");
    await revoke(next.connectionId);
    expect(readNativeConnector(next.connectionId)).toBeNull();
    // Manually supplied credentials are forgotten locally without claiming remote ownership.
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
it.each(providers)(
  "rejects retained $input.providerId revokers after their production activation is disposed",
  async (provider) => {
    const old = activate(provider);
    const controller = nativeConnectorController({
      id: provider.input.providerId,
      refused: false,
    });
    const saved = await controller.configure(provider.input);
    const revoke = deviceProviderRevokers[provider.input.providerId];
    if (!revoke) throw new Error("Missing production builtin revoker");
    old.activation.dispose();
    const next = activate(provider);
    await expect(revoke(saved.connectionId)).rejects.toThrow();
    expect(next.fetcher).not.toHaveBeenCalled();
    expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  },
);
