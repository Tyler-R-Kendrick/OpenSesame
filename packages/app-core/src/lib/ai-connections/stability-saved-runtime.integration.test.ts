import { afterEach, expect, it, vi } from "vitest";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "../device-connector-records.js";
import { bindHostedModelAuthority } from "../hosted-model-authority.js";
import { kvFlush, kvForgetAll, kvHydrate } from "../kv.js";
import { inferenceSlugOptions, voiceSlugOptions } from "../model-slugs.js";
import { loadNativeConnectorRecord } from "../native-connector-store.js";
import { createProject, setActiveProject } from "../projects.js";
import {
  runtimeFixture,
  runtimePassword,
} from "../secret-backends/runtime.test-support.js";
import { initializeVaultCredentialCustody } from "../vault-credential-custody.js";
import { vaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import { aiDelegationAvailable } from "./delegation.js";
import { AiImageOutput } from "./image-output.js";
import { inferAiConnection } from "./inference.js";
import {
  deleteAiConnection,
  saveAiConnection,
  testAiConnection,
} from "./runtime.js";
import { STABILITY_SD3_BASE, STABILITY_SD3_MODEL } from "./stability-target.js";
import {
  RASTER_FIXTURES,
  STABILITY_KEY,
  STABILITY_PROMPT,
  stabilityTlsFixture,
} from "./stability-tls.test-support.js";
import { readAiConnection } from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";
import type { AiConnectionDraft } from "./types.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function setup(providerId: "stability" | "byo-ai" = "stability") {
  const vault = await runtimeFixture();
  closes.push(vault.close);
  const baseUrl =
    providerId === "stability"
      ? STABILITY_SD3_BASE
      : "https://operator.example/custom/images";
  const model =
    providerId === "stability" ? STABILITY_SD3_MODEL : "operator-image-model";
  const http = await stabilityTlsFixture(baseUrl, model);
  closes.push(http.close);
  const capture = vi.fn(() => http.port);
  const unbind = bindAiConnectionTransport({ ...http.port, capture });
  closes.push(async () => unbind());
  const draft: AiConnectionDraft = {
    providerId,
    name: "Explicit image connection",
    family: "stability_sd3",
    baseUrl,
    model,
    authentication: "api-key",
    apiKey: STABILITY_KEY,
    tokenParameter: "max_tokens",
  };
  const options = { imagePrompt: STABILITY_PROMPT };
  return { vault, http, draft, options, capture };
}
async function coldReload() {
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
it.each(["stability", "byo-ai"] as const)(
  "actually tests, saves and cold-restores %s image verification with sealed credentials and no stored prompt/pixels",
  async (provider) => {
    const f = await setup(provider);
    const released = vi.spyOn(AiImageOutput.prototype, "release");
    await expect(
      testAiConnection(f.draft, undefined, undefined, f.options),
    ).resolves.toBe("Model inference verified");
    expect(readDeviceRows()).toEqual([]);
    const saved = await saveAiConnection(
      f.draft,
      undefined,
      undefined,
      f.options,
    );
    const record = loadNativeConnectorRecord(saved.connectionId);
    const reference = record?.privateState.credentials.ai_credential_reference;
    expect(reference).toBeTruthy();
    expect(readAiConnection(saved.connectionId)).toMatchObject({
      family: "stability_sd3",
      apiKey: "",
      model: f.draft.model,
    });
    expect(
      vaultStore
        .getSnapshot()
        .items.some(
          (item) =>
            item.kind === "credential" &&
            item.method.type === "token" &&
            item.method.token === STABILITY_KEY,
        ),
    ).toBe(true);
    for (const value of [STABILITY_KEY, STABILITY_PROMPT]) {
      expect(JSON.stringify(readDeviceRows())).not.toContain(value);
      expect([...f.vault.files.values()].join(" ")).not.toContain(value);
    }
    const transient = released.mock.contexts.at(-1);
    if (!(transient instanceof AiImageOutput))
      throw new Error("Expected actual owned raster release");
    expect(() => transient.copyBytes()).toThrow();
    expect(released).toHaveBeenCalledTimes(2);
    await coldReload();
    const retained = readAiConnection(saved.connectionId);
    if (!retained) throw new Error("Cold connection missing");
    await expect(
      testAiConnection(retained, saved.connectionId, undefined, f.options),
    ).resolves.toBe("Model inference verified");
    expect(
      loadNativeConnectorRecord(saved.connectionId)?.privateState.credentials
        .ai_credential_reference,
    ).toBe(reference);
    expect(f.capture).toHaveBeenCalledTimes(3);
    expect(f.http.records.map((row) => row.path)).toEqual(
      Array(3).fill(`${new URL(f.draft.baseUrl).pathname}/generate/sd3`),
    );
    expect(
      f.http.records.every(
        (row) =>
          row.headers.authorization === `Bearer ${STABILITY_KEY}` &&
          new Map(row.fields).get("prompt") === STABILITY_PROMPT,
      ),
    ).toBe(true);
  },
);
it("requires explicit bounded image prompts and rejects foreign media before HTTP or credential writes", async () => {
  const f = await setup();
  for (const imagePrompt of [
    undefined,
    "",
    " ",
    "x".repeat(8193),
    STABILITY_KEY,
  ]) {
    await expect(
      testAiConnection(f.draft, undefined, undefined, { imagePrompt }),
    ).rejects.toThrow();
    await expect(
      saveAiConnection(f.draft, undefined, undefined, { imagePrompt }),
    ).rejects.toThrow();
  }
  await expect(
    testAiConnection(
      f.draft,
      undefined,
      { prompt: "foreign prediction" },
      f.options,
    ),
  ).rejects.toThrow();
  expect(f.http.records).toEqual([]);
  expect(readDeviceRows()).toEqual([]);
  expect(
    vaultStore.getSnapshot().items.filter((item) => item.kind === "credential"),
  ).toEqual([]);
});
it("snapshots the explicit verification prompt before private vault hydration can yield", async () => {
  const f = await setup();
  const options = { imagePrompt: STABILITY_PROMPT };
  const result = testAiConnection(f.draft, undefined, undefined, options);
  options.imagePrompt = "later mutation";
  await result;
  expect(new Map(f.http.records[0].fields).get("prompt")).toBe(
    STABILITY_PROMPT,
  );
});
it.each(["filtered", "http-401", "bad-base64", "jpeg"])(
  "rejects %s retest without replacing the original row or credential reference",
  async (mode) => {
    const f = await setup();
    const saved = await saveAiConnection(
      f.draft,
      undefined,
      undefined,
      f.options,
    );
    const before = loadNativeConnectorRecord(saved.connectionId);
    if (!before) throw new Error("Saved row missing");
    f.http.state.mode = mode;
    const retained = readAiConnection(saved.connectionId);
    if (!retained) throw new Error("Saved draft missing");
    await expect(
      saveAiConnection(retained, saved.connectionId, undefined, f.options),
    ).rejects.toThrow();
    expect(loadNativeConnectorRecord(saved.connectionId)).toEqual(before);
  },
);
it("does not lend a saved image connection to inference, voice or delegated text keys", async () => {
  const f = await setup();
  const saved = await saveAiConnection(
    f.draft,
    undefined,
    undefined,
    f.options,
  );
  const projection = {
    connectionId: saved.connectionId,
    providerId: f.draft.providerId,
    status: "connected",
    method: "api-key",
    family: f.draft.family,
    model: f.draft.model,
    endpoint: f.draft.baseUrl,
  };
  const release = bindHostedModelAuthority({
    fetch,
    assertCurrent() {},
    read: () => projection,
    connections: () => [projection],
    async execute() {
      throw new Error("No text dispatch");
    },
  });
  closes.push(async () => release());
  expect(
    inferenceSlugOptions({
      browserReady: false,
      connectedProviderIds: [],
    }).some((row) => row.choice.connectionId === saved.connectionId),
  ).toBe(false);
  expect(
    voiceSlugOptions(true).some(
      (row) => row.choice.connectionId === saved.connectionId,
    ),
  ).toBe(false);
  expect(aiDelegationAvailable(saved.connectionId)).toBe(false);
  const count = f.http.records.length;
  await expect(
    inferAiConnection(
      f.draft,
      {
        model: f.draft.model,
        messages: [{ role: "user", content: STABILITY_PROMPT }],
      },
      f.http.port,
      () => {},
    ),
  ).rejects.toThrow("owned image-result");
  expect(f.http.records).toHaveLength(count);
});
it("refuses reauthentication from a different real vault before egress and retains the old secret reference", async () => {
  const f = await setup();
  const saved = await saveAiConnection(
    f.draft,
    undefined,
    undefined,
    f.options,
  );
  const before = loadNativeConnectorRecord(saved.connectionId);
  const project = await createProject("Image verification isolation");
  try {
    await setActiveProject(project.id);
    vaultStore.loadActiveProjectScope();
    await vaultStore.create(runtimePassword);
    expect(vaultStore.getSnapshot().tomb).toBe(project.id);
    const retained = readAiConnection(saved.connectionId);
    if (!retained) throw new Error("Saved row missing");
    const count = f.http.records.length;
    await expect(
      testAiConnection(retained, saved.connectionId, undefined, f.options),
    ).rejects.toThrow();
    expect(f.http.records).toHaveLength(count);
    expect(loadNativeConnectorRecord(saved.connectionId)).toEqual(before);
  } finally {
    await setActiveProject("personal");
    vaultStore.loadActiveProjectScope();
  }
});
it.each(["caller", "row", "vault", "route"])(
  "original %s withdrawal physically drains a held saved image test within2s",
  async (change) => {
    const f = await setup();
    const saved = await saveAiConnection(
      f.draft,
      undefined,
      undefined,
      f.options,
    );
    const retained = readAiConnection(saved.connectionId);
    if (!retained) throw new Error("Saved draft missing");
    f.http.state.mode = "hold-body";
    const caller = new AbortController();
    const result = expect(
      testAiConnection(retained, saved.connectionId, undefined, {
        ...f.options,
        signal: caller.signal,
      }),
    ).rejects.toThrow();
    await expect
      .poll(() => f.http.state.held !== undefined, { timeout: 1500 })
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(f.http.records.at(-1)?.closed).toBe(false);
    const start = performance.now();
    if (change === "caller") caller.abort();
    else if (change === "row") await deleteAiConnection(saved.connectionId);
    else if (change === "vault") vaultStore.lock();
    else f.http.withdraw();
    await result;
    await expect
      .poll(() => f.http.records.at(-1)?.closed, { timeout: 1500 })
      .toBe(true);
    expect(performance.now() - start).toBeLessThan(2000);
  },
);

it.each([
  ["test", "edit"],
  ["test", "delete"],
  ["save", "edit"],
  ["save", "delete"],
] as const)(
  "%s refuses credential %s while the original response is held",
  async (operation, change) => {
    const f = await setup();
    const saved = await saveAiConnection(
      f.draft,
      undefined,
      undefined,
      f.options,
    );
    const before = loadNativeConnectorRecord(saved.connectionId);
    const retained = readAiConnection(saved.connectionId);
    if (!retained) throw new Error("Saved draft missing");
    const token = vaultStore
      .getSnapshot()
      .items.find((item) => item.kind === "credential");
    if (!token || token.kind !== "credential" || token.method.type !== "token")
      throw new Error("Expected sealed token");
    f.http.state.mode = "hold-body";
    const execute = operation === "test" ? testAiConnection : saveAiConnection;
    const result = execute(
      retained,
      saved.connectionId,
      undefined,
      f.options,
    ).then(
      () => true,
      () => false,
    );
    await expect
      .poll(() => f.http.state.held !== undefined, { timeout: 1500 })
      .toBe(true);
    if (change === "edit")
      await vaultStore.saveItem({
        ...token,
        method: { ...token.method, token: "changed-unverified-token" },
      });
    else {
      await vaultStore.trashItem(token.id);
      await vaultStore.purgeItem(token.id);
    }
    f.http.state.held?.end(
      `${RASTER_FIXTURES.png}","finish_reason":"SUCCESS"}`,
    );
    expect
      .soft(
        await result,
        "A changed original credential must not authenticate stale work",
      )
      .toBe(false);
    expect
      .soft(
        loadNativeConnectorRecord(saved.connectionId),
        "No stale key may replace the original saved row",
      )
      .toEqual(before);
  },
);
