/** Real connector protocols and encrypted KV, with typed provider HTTP fixtures. */
import { configureHost } from "@opensesame/app-core/host.js";
import { webLocksDouble } from "@opensesame/app-core/lib/__tests__/web-locks-double.js";
import {
  atRestReady,
  forgetAtRestKeyForTest,
} from "@opensesame/app-core/lib/at-rest/key.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { makeOpfs } from "@opensesame/app-core/lib/duress/wipe/fake-opfs.test-support.js";
import { kvForgetAll, kvHydrate } from "@opensesame/app-core/lib/kv.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vercelConnectCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { createActivation } from "../../../modules/activation.js";
import { closeGenuineRuntimeFixture } from "../../../modules/connectors.external/genuine-runtime.test-support.js";
import { bindNativeApiRuntime } from "../../../modules/connectors.external/native-api-runtime.js";
import { bindNativeOAuthRuntime } from "../../../modules/connectors.external/native-oauth-runtime.js";
import { bindNativeRuntime } from "../../../modules/connectors.external/native-runtime.js";
import { createTestContext } from "../../../modules/test-context.js";
type ProviderRoute = { respond?: (request: Request) => Promise<Response> };
const releases: (() => void)[] = [];
export const connectorOwnerPassword =
  "controlled genuine connector integration owner";
let prepared: ReturnType<typeof makeConnectorIntegration> | undefined;
export function installConnectorIntegration(): void {
  beforeEach(async () => {
    await closeGenuineRuntimeFixture();
    kvForgetAll();
    forgetAtRestKeyForTest();
    prepared = makeConnectorIntegration();
    await atRestReady();
    vaultStore.loadActiveProjectScope();
    await vaultStore.create(connectorOwnerPassword);
  });
  afterEach(async () => {
    cleanup();
    for (const release of releases.splice(0).reverse()) release();
    await closeGenuineRuntimeFixture();
    prepared = undefined;
    kvForgetAll();
    forgetAtRestKeyForTest();
    configureHost(createTestHost());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}
export function connectorIntegration() {
  if (!prepared)
    throw new Error(
      "Install the authentic connector integration fixture first",
    );
  prepared.bindRuntime();
  return prepared;
}
function makeConnectorIntegration() {
  const disk = makeOpfs();
  const locks = overlapCast<ReturnType<typeof webLocksDouble>, LockManager>(
    webLocksDouble(),
  );
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => disk },
    locks,
  });
  configureHost(createTestHost({ locks }));
  const requests: Request[] = [];
  const route: ProviderRoute = {};
  const replies: { body: BoundaryValue; status?: number }[] = [];
  const test = createTestContext();
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    if (route.respond) return route.respond(request);
    const reply = replies.shift();
    if (!reply) throw new Error("No typed provider fixture queued");
    return Response.json(reply.body, { status: reply.status ?? 200 });
  };
  const ctx = { ...test.ctx, egress: { ...test.ctx.egress, fetch: fetcher } };
  const activation = createActivation(ctx, "connectors.external");
  let runtimeBound = false;
  const bindRuntime = () => {
    if (runtimeBound) return;
    runtimeBound = true;
    configureHost(
      createTestHost({ originFiles: async () => overlapCast(disk), locks }),
    );
    bindNativeRuntime(ctx, activation);
    bindNativeApiRuntime(activation);
    bindNativeOAuthRuntime(activation);
    releases.push(
      bindNativeOAuthBrowserPort({
        redirectUri: "https://selfhost.example/auth/native-connector.html",
        navigate,
        scrubCallback,
      }),
    );
  };
  releases.push(activation.dispose);
  const navigate = vi.fn();
  const scrubCallback = vi.fn();

  return {
    bindRuntime,
    disk,
    route,
    requests,
    replies,
    navigate,
    scrubCallback,
    activation,
    reload: async () => {
      kvForgetAll();
      await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
      return readDeviceRows();
    },
  };
}
export function integrationProvider(id: string) {
  const provider = vercelConnectCatalog().find((row) => row.id === id);
  if (!provider) throw new Error("Missing catalog provider");
  return provider;
}
