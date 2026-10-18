/** @vitest-environment jsdom */
import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import { aiHttpFixture } from "@opensesame/app-core/lib/ai-connections/protocol.test-support.js";
import { saveAiConnection } from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { approvedPlan } from "@opensesame/app-core/lib/capabilities/__tests__/plan-fixtures.js";
import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import { describeCapability } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { createEgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import { nativeDeviceViewSeams } from "@opensesame/app-core/lib/device-connector-view.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { saveModelFixture } from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { nativeBrowserApiPolicy } from "@opensesame/app-core/lib/native-browser-policy.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindAiConnectionRuntime } from "./ai-connection-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";

const endpoint = "https://configured-model.example/custom/v1";
let vault: Awaited<ReturnType<typeof runtimeFixture>>;
let http: Awaited<ReturnType<typeof aiHttpFixture>>;
const disposers: (() => void)[] = [];
beforeEach(async () => {
  vault = await runtimeFixture();
  http = await aiHttpFixture((_request, response) => {
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  });
});
afterEach(async () => {
  while (disposers.length) disposers.pop()?.();
  await http.close();
  await vault.close();
});
function activate(allow = true) {
  const descriptor = describeCapability("connectors.external");
  if (!descriptor) throw new Error("Missing actual provider capability");
  const plan = approvedPlan(["connectors.external"]);
  const currentPlan = {
    ...plan,
    network: {
      ...plan.network,
      externalServices: "allow" as const,
      allowedServiceOrigins: allow
        ? [new URL(endpoint).origin]
        : ["https://another-approved.example"],
    },
  };
  const fetcher = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(new URL(endpoint).origin);
    const local = new URL(http.baseUrl);
    url.protocol = local.protocol;
    url.host = local.host;
    return fetch(url, init);
  });
  const egress = createEgressPort({
    capability: descriptor,
    plan: () => currentPlan,
    allowedOrigins: [window.location.origin],
    fetchImpl: fetcher,
  });
  const decide = vi.spyOn(egress, "decide");
  const test = createTestContext();
  const ctx = { ...test.ctx, egress };
  const activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  bindAiConnectionRuntime(ctx, activation);
  disposers.push(activation.dispose);
  return { currentPlan, test, activation, fetcher, decide };
}
async function save() {
  return saveAiConnection({
    ...aiConnectionDraft("nvidia"),
    baseUrl: endpoint,
    model: "fixture-model",
    apiKey: "private-direct-ai-token",
  });
}

it("keeps actual direct custom inference active despite a dated default-provider refusal", async () => {
  const active = activate();
  expect(nativeBrowserApiPolicy("nvidia").available).toBe(true);
  const saved = await save();
  expect(deviceConnection(saved.connectionId)?.status).toBe("active");
  expect(http.requests).toHaveLength(1);
  expect(http.requests[0]?.path).toBe("/custom/v1/chat/completions");
  expect(active.decide).toHaveBeenCalledWith(endpoint, {
    capability: "connectors.external",
    purpose: NATIVE_PROVIDER_PURPOSE,
  });
  expect(
    JSON.stringify(nativeDeviceViewSeams.authorization(saved.connectionId)),
  ).not.toContain("private-direct-ai-token");
  expect(active.fetcher).toHaveBeenCalledTimes(1);
});

it("uses the configured endpoint's current operator allowlist without sending another request", async () => {
  const active = activate();
  const saved = await save();
  active.currentPlan.network.allowedServiceOrigins = [
    "https://another-approved.example",
  ];
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
  expect(active.fetcher).toHaveBeenCalledTimes(1);
  await expect(save()).rejects.toThrow();
  expect(active.fetcher).toHaveBeenCalledTimes(1);
});

it.each(["lease", "dispose"])(
  "withdraws actual AI readiness with its %s",
  async (withdraw) => {
    const active = activate();
    const saved = await save();
    if (withdraw === "lease") active.test.abort("withdrawn");
    else active.activation.dispose();
    expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
    expect(active.fetcher).toHaveBeenCalledTimes(1);
  },
);

it("does not borrow an old activation's endpoint admission for the current AI transport", async () => {
  const older = activate();
  const saved = await save();
  const newer = activate(false);
  older.activation.dispose();
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
  expect(newer.decide).toHaveBeenCalledWith(endpoint, {
    capability: "connectors.external",
    purpose: NATIVE_PROVIDER_PURPOSE,
  });
  expect(newer.fetcher).not.toHaveBeenCalled();
  expect(nativeBrowserApiPolicy("datadog").available).toBe(true);
});

it("keeps ordinary verified metadata without mistaking advice for a new provider request", async () => {
  const active = activate();
  const id = await saveModelFixture("datadog");
  expect(deviceConnection(id)).toMatchObject({
    status: "active",
    statusDetail: null,
  });
  expect(active.decide).not.toHaveBeenCalled();
  expect(active.fetcher).not.toHaveBeenCalled();
});
