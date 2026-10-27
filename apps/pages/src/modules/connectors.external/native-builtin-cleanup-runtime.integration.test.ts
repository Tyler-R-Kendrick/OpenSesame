// @vitest-environment jsdom
/** Builtin providers must be removable through the production activation, even without a generated plan. */
import { initialDraftState } from "@opensesame/app-core/lib/connect-draft.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { deviceProviderRevokers } from "@opensesame/app-core/lib/device-connectors.js";
import { modelMemoryBackend } from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import type { NativeDriverInput } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import {
  readSelfHostedConnector,
  saveSelfHostedConnector,
} from "@opensesame/app-core/lib/self-hosted-connectors.js";
import { afterEach as afterGenuine, beforeEach as beforeGenuine } from "vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeConnectorController } from "../../sections/connections/connect/native-connector-controller.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import {
  closeGenuineRuntimeFixture,
  genuineRuntimeFixture,
} from "./genuine-runtime.test-support.js";
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
const linear: Builtin = {
  input: {
    providerId: "linear",
    method: "api-key",
    displayName: "Linear",
    parameters: {},
    credentials: { api_key: "private-linear-api-key" },
    requestedScopes: {},
    targetIds: {},
  },
  response: () =>
    Response.json({
      data: { viewer: { id: "linear-user", name: "Protocol Linear user" } },
    }),
};
const providers: Builtin[] = [
  linear,
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
  ...["azure-sm", "azure-key-vault-secrets"].map(
    (providerId): Builtin => ({
      input: {
        providerId,
        method: "api-key",
        displayName: "Azure Key Vault Secrets",
        parameters: { vault_url: "https://owned.vault.azure.net" },
        credentials: { token: "owned-key-vault-audience-token" },
        requestedScopes: {},
        targetIds: {},
      },
      response: () => Response.json({ value: [] }),
    }),
  ),
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
it("preserves the legacy Linear revoker beside native cleanup", async () => {
  activate(linear);
  const plan = connectPlan("linear");
  if (!plan) throw new Error("Linear plan required");
  const saved = await saveSelfHostedConnector(
    plan,
    { ...initialDraftState(plan, "api-key"), key: "lin_api_test-only" },
    {
      mode: "byo",
      workspace: "protocol-workspace",
      appScopes: [],
      userScopes: [],
      webhookResourceTypes: [],
      icon: "",
    },
  );
  const revoke = deviceProviderRevokers.linear;
  if (!revoke) throw new Error("Missing the Linear revoker");
  await revoke(saved.connectionId);
  expect(readSelfHostedConnector(saved.connectionId)).toBeNull();
});
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

beforeGenuine(genuineRuntimeFixture);
afterGenuine(closeGenuineRuntimeFixture);
