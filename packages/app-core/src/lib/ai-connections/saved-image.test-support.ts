import { DEVICE_CONNECTOR_KEYS } from "../device-connector-records.js";
import { kvFlush, kvForgetAll, kvHydrate } from "../kv.js";
import {
  runtimeFixture,
  runtimePassword,
} from "../secret-backends/runtime.test-support.js";
import { initializeVaultCredentialCustody } from "../vault-credential-custody.js";
import { vaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import { aiConnectionDraft } from "./presets.js";
import { saveAiConnection } from "./runtime.js";
import { STABILITY_SD3_BASE, STABILITY_SD3_MODEL } from "./stability-target.js";
import {
  STABILITY_KEY,
  STABILITY_PROMPT,
  stabilityTlsFixture,
} from "./stability-tls.test-support.js";
import { bindAiConnectionTransport } from "./transport.js";

/** The same public preset, sealed Save, and owned TLS protocol used by the PWA. */
export async function savedImageFixture(
  provider: "stability" | "byo-ai" = "stability",
) {
  const vault = await runtimeFixture();
  const baseUrl =
    provider === "stability"
      ? STABILITY_SD3_BASE
      : "https://operator.example/custom/images";
  const model =
    provider === "stability" ? STABILITY_SD3_MODEL : "operator-image-model";
  const http = await stabilityTlsFixture(baseUrl, model);
  let captures = 0;
  const unbind = bindAiConnectionTransport({
    ...http.port,
    capture() {
      captures++;
      return http.port;
    },
  });
  const draft = {
    ...aiConnectionDraft(provider),
    family: "stability_sd3" as const,
    baseUrl,
    model,
    apiKey: STABILITY_KEY,
  };
  return {
    vault,
    http,
    draft,
    captures: () => captures,
    withdrawFeature: unbind,
    save: () =>
      saveAiConnection(draft, undefined, undefined, {
        imagePrompt: STABILITY_PROMPT,
      }),
    async close() {
      unbind();
      await http.close();
      await vault.close();
    },
  };
}

export async function coldSavedImageVault() {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  await vaultStore.unlock(runtimePassword);
  await initializeVaultCredentialCustody();
}
