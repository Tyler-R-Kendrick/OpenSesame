import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { DEVICE_CONNECTOR_KEYS } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  kvFlush,
  kvForgetAll,
  kvHydrate,
} from "@opensesame/app-core/lib/kv.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { bindNativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { nativeOAuthClientFixture } from "@opensesame/app-core/lib/native-oauth-client.test-support.js";
import { runtimePassword } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vfsFlush } from "@opensesame/app-core/lib/vfs.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { NativeConnectorForm } from "../../sections/connections/connect/NativeConnectorForm.js";
import { nativeConnectorController } from "../../sections/connections/connect/native-connector-controller.js";
import { nativeScopeDefaults } from "../../sections/connections/connect/native-connector-ui-values.js";
import { nativeProviderDescriptor } from "../../sections/connections/connect/native-provider-descriptor.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import {
  bindNativeOAuthRuntime,
  nativeCallbackUrl,
} from "./native-oauth-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";
const closes: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
});
async function setup() {
  const f = await nativeOAuthClientFixture("client_secret_post");
  closes.push(f.close);
  f.input.providerId = "box";
  f.state.redirectUri = nativeCallbackUrl();
  const { ctx } = createTestContext();
  const activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  const original = f.owner.transport;
  const release = bindNativeProviderTransport({
    ...original,
    capture: () => ({
      ...original,
      supportsNativeOrigin: (origin) =>
        origin === new URL(f.state.resource).origin,
      assertCurrent: () => {
        original.assertCurrent();
        if (activation.disposed()) throw new Error("Original activation ended");
      },
    }),
  });
  activation.onDispose(release);
  bindNativeOAuthRuntime(activation);
  closes.push(activation.dispose);
  let consents = 0;
  closes.push(
    bindNativeOAuthBrowserPort({
      redirectUri: f.state.redirectUri,
      navigate: () => {
        throw new Error("Unexpected navigation");
      },
      scrubCallback: () => {},
      authorize: async (value) => {
        consents++;
        const url = new URL(value);
        f.state.challenge = url.searchParams.get("code_challenge") ?? "";
        f.state.scope = url.searchParams.get("scope") ?? "";
        return new URLSearchParams({
          native_state: url.searchParams.get("state") ?? "",
          native_code: "one-use-code",
        }).toString();
      },
    }),
  );
  const plan = connectPlan("box");
  if (!plan) throw new Error("Missing real provider");
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl: nativeCallbackUrl(),
    apiKey: { available: false },
    oauth: { available: true },
    mcp: { available: false, actor: "user" },
  });
  const method = descriptor.methods.find((row) => row.id === "oauth");
  if (!method) throw new Error("Missing actual OAuth controls");
  f.input.requestedScopes = nativeScopeDefaults(method);
  const controller = nativeConnectorController({ id: "box", refused: false });
  const view = await controller.connect(f.input);
  const changes: NativeConnectorView[] = [];
  function mount(saved = controller.load()) {
    if (!saved) throw new Error("Missing actually verified saved connection");
    return render(
      <NativeConnectorForm
        descriptor={descriptor}
        controller={controller}
        view={saved}
        onChanged={(next) => {
          if (next) changes.push(next);
        }}
        onFlash={() => {}}
      />,
    );
  }
  return {
    ...f,
    driver: nativeConnectorDriver("oauth", "box"),
    controller,
    view,
    mount,
    changes,
    consents: () => consents,
  };
}
it("saves the actual existing form with a blank client secret, preserves genuine access and performs an unchanged no-op", async () => {
  const f = await setup();
  const before = loadNativeConnectorRecord(f.view.connectionId);
  const form = f.mount();
  expect(
    screen.getByLabelText(/Leave blank to keep the saved credential/),
  ).toBeTruthy();
  expect(
    screen.getByLabelText("OAuth client secret", {
      selector: 'input[type="password"]',
    }),
  ).toHaveProperty("value", "");
  fireEvent.change(screen.getByLabelText("Connector name"), {
    target: { value: "Saved renamed Box" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Verify and connect Box" }),
  );
  await waitFor(() =>
    expect(f.changes.at(-1)?.configuration.displayName).toBe(
      "Saved renamed Box",
    ),
  );
  expect(f.changes.at(-1)?.status).toBe("connected");
  const changed = loadNativeConnectorRecord(f.view.connectionId);
  expect(changed?.privateState).toEqual(before?.privateState);
  expect(changed?.runtime).toEqual(before?.runtime);
  expect(changed?.revision).toBe(f.view.revision + 1);
  form.unmount();
  f.mount();
  fireEvent.click(
    screen.getByRole("button", { name: "Verify and connect Box" }),
  );
  await waitFor(() => expect(f.changes).toHaveLength(2));
  expect(f.changes[1]?.revision).toBe(changed?.revision);
  expect(f.consents()).toBe(1);
  expect(f.requests.map((row) => row.path)).toEqual(["/token", "/resource"]);
});
it("reopens the actual saved form after encrypted-storage reload without revealing or replacing its secret", async () => {
  const f = await setup();
  const before = loadNativeConnectorRecord(f.view.connectionId);
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  await vaultStore.unlock(runtimePassword);
  f.mount();
  expect(
    screen.getByLabelText("OAuth client secret", {
      selector: 'input[type="password"]',
    }),
  ).toHaveProperty("value", "");
  fireEvent.change(screen.getByLabelText("Connector name"), {
    target: { value: "Restored saved Box" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Verify and connect Box" }),
  );
  await waitFor(() =>
    expect(f.changes.at(-1)?.configuration.displayName).toBe(
      "Restored saved Box",
    ),
  );
  expect(readNativeConnector(f.view.connectionId)?.status).toBe("connected");
  expect(loadNativeConnectorRecord(f.view.connectionId)?.privateState).toEqual(
    before?.privateState,
  );
  expect(f.requests).toHaveLength(2);
  expect(f.consents()).toBe(1);
});
it("removes the retention promise through the real scope control and restores it only for the original selection", async () => {
  const f = await setup();
  f.mount();
  const choices = screen.getAllByRole("checkbox", { hidden: true });
  const choice = choices.find((input) => !input.hasAttribute("disabled"));
  if (!choice) throw new Error("Missing actual editable provider scope");
  expect(
    screen.getByLabelText(/Leave blank to keep the saved credential/),
  ).toBeTruthy();
  fireEvent.click(choice);
  expect(
    screen.queryByLabelText(/Leave blank to keep the saved credential/),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Verify and connect Box" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(choice);
  expect(
    screen.getByLabelText(/Leave blank to keep the saved credential/),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Verify and connect Box" }),
  ).toHaveProperty("disabled", false);
  expect(f.requests).toHaveLength(2);
  expect(f.consents()).toBe(1);
});
