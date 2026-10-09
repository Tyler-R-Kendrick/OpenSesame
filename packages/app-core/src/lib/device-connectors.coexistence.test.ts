import { beforeEach, expect, it } from "vitest";
import { initialDraftState } from "./connect-draft.js";
import { connectPlan } from "./connect-plan.js";
import {
  createDeviceConnection,
  runFeatureConnector,
  sealDeviceCredential,
} from "./device-connectors.js";
import { kvForgetAll } from "./kv.js";
import { saveSelfHostedConnectorDurable } from "./self-hosted-connectors.js";
import { vercelConnectCatalog } from "./vercel-connect-catalog.js";

beforeEach(kvForgetAll);

const linear = connectPlan("linear");
const provider = vercelConnectCatalog().find((row) => row.id === "linear");
if (!linear || !provider) throw new Error("Linear configuration missing");
const plan = linear;
const linearProvider = provider;

async function pendingConfiguration() {
  const state = initialDraftState(plan, "oauth");
  state.oauth.clientId = "deployment-client";
  state.oauth.clientSecret = "deployment-secret";
  return saveSelfHostedConnectorDurable(plan, state, {
    mode: "managed",
    workspace: "example",
    appScopes: ["read"],
    userScopes: [],
    webhookResourceTypes: [],
    icon: "",
  });
}

it("keeps an existing native operation available after a pending configuration is saved for the same provider", async () => {
  const native = createDeviceConnection({ providerId: plan.id });
  sealDeviceCredential(native.connectionId, "working-native-credential");
  expect(runFeatureConnector(linearProvider).ok).toBe(true);
  await pendingConfiguration();
  const run = runFeatureConnector(linearProvider);
  expect(run.ok).toBe(true);
  if (!run.ok) throw new Error("Native operation was shadowed");
  expect(run.secrets).toEqual({ credential: "working-native-credential" });
  expect(run.fields).not.toHaveProperty("self_hosted_configuration");
});

it("does not use a pending configuration when no native record exists", async () => {
  await pendingConfiguration();
  expect(runFeatureConnector(linearProvider)).toEqual({
    ok: false,
    providerId: plan.id,
  });
});
