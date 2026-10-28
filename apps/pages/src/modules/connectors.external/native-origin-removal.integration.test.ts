import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { removeNativeConnectorWithCleanup } from "@opensesame/app-core/lib/native-connector-lifecycle.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { bindNativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { originFixture } from "@opensesame/app-core/lib/native-origin.test-support.js";
import { vaultCredentialField } from "@opensesame/app-core/lib/vault-credential-custody.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://selfhost.example"} */
import { exportPKCS8, generateKeyPair } from "jose";
import { expect, it } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindProviderRuntime } from "./native-runtime.js";

it("removes Origin's superseded and active keys through the mounted runtime", async () => {
  const f = await originFixture();
  const test = createTestContext();
  const activation = createActivation(test.ctx, "connectors.external");
  try {
    activation.onDispose(bindNativeProviderTransport(f.owner.transport));
    bindProviderRuntime(test.ctx, activation);
    const driver = nativeConnectorDriver("oauth", "origin");
    const first = await driver.configure(f.input);
    const replacement = await generateKeyPair("Ed25519", {
      extractable: true,
    });
    const saved = await driver.configure({
      ...f.input,
      connectionId: first.connectionId,
      revision: first.revision,
      credentials: { private_key: await exportPKCS8(replacement.privateKey) },
    });
    expect(
      vaultStore
        .getSnapshot()
        .items.filter(
          (item) =>
            item.kind === "credential" &&
            vaultCredentialField(item) === "appPrivateKey",
        ),
    ).toHaveLength(2);
    await removeNativeConnectorWithCleanup(saved.connectionId);
    expect(readNativeConnector(saved.connectionId)).toBeNull();
    expect(
      vaultStore
        .getSnapshot()
        .items.filter(
          (item) =>
            item.kind === "credential" &&
            vaultCredentialField(item) === "appPrivateKey",
        ),
    ).toEqual([]);
  } finally {
    activation.dispose();
    await f.close();
  }
});
