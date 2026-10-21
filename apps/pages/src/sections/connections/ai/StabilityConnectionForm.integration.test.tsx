/** @vitest-environment jsdom */
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { saveAiConnection } from "@opensesame/app-core/lib/ai-connections/runtime.js";
import {
  STABILITY_SD3_BASE,
  STABILITY_SD3_MODEL,
} from "@opensesame/app-core/lib/ai-connections/stability-target.js";
import {
  STABILITY_KEY,
  STABILITY_PROMPT,
  stabilityTlsFixture,
} from "@opensesame/app-core/lib/ai-connections/stability-tls.test-support.js";
import { readAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import { bindAiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import type { AiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/types.js";
import { DEVICE_CONNECTOR_KEYS } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  kvFlush,
  kvForgetAll,
  kvHydrate,
} from "@opensesame/app-core/lib/kv.js";
import { loadNativeConnectorRecord } from "@opensesame/app-core/lib/native-connector-store.js";
import {
  runtimeFixture,
  runtimePassword,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { initializeVaultCredentialCustody } from "@opensesame/app-core/lib/vault-credential-custody.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vfsFlush } from "@opensesame/app-core/lib/vfs.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AiConnectionForm } from "./AiConnectionForm.js";
import { useAiConnection } from "./useAiConnection.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function Configuration({
  providerId,
  id,
  onFlash,
}: { providerId: string; id: string; onFlash: (flash: Flash) => void }) {
  const state = useAiConnection(providerId, id, onFlash);
  return <AiConnectionForm {...state} saved={state.hasSavedCredentials} />;
}
function field(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), {
    target: { value },
  });
}
function button(name: string) {
  return screen.getByRole("button", { name });
}
async function setup(providerId: "stability" | "byo-ai" = "stability") {
  const form = await new Response("x=y", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }).formData();
  vi.stubGlobal("FormData", form.constructor);
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("crypto", webcrypto);
  const vault = await runtimeFixture();
  closes.push(vault.close);
  const baseUrl =
    providerId === "stability"
      ? STABILITY_SD3_BASE
      : "https://operator.example/custom/images";
  const model =
    providerId === "stability" ? STABILITY_SD3_MODEL : "custom-medium";
  const http = await stabilityTlsFixture(baseUrl, model);
  closes.push(http.close);
  const release = bindAiConnectionTransport(http.port);
  closes.push(async () => release());
  const draft: AiConnectionDraft = {
    providerId,
    name: "Saved image configuration",
    family: "stability_sd3",
    baseUrl,
    model,
    authentication: "api-key",
    apiKey: STABILITY_KEY,
    tokenParameter: "max_tokens",
  };
  // The picker stays hidden until checkpoint C. Seed this exact draft through REAL charged Save.
  const saved = await saveAiConnection(draft, undefined, undefined, {
    imagePrompt: STABILITY_PROMPT,
  });
  const onFlash = vi.fn<(flash: Flash) => void>();
  const view = render(
    <Configuration
      providerId={providerId}
      id={saved.connectionId}
      onFlash={onFlash}
    />,
  );
  return { vault, http, draft, saved, onFlash, view };
}
it.each(["stability", "byo-ai"] as const)(
  "the shared saved %s form requires its shown verification prompt and consumes actual Test/Save image responses",
  async (providerId) => {
    const f = await setup(providerId);
    expect(button("Test AI connection")).toHaveProperty("disabled", true);
    expect(button("Save AI connection")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Verification image prompt")).toHaveProperty(
      "maxLength",
      8192,
    );
    expect(
      screen.getByText(/Testing and saving generate an actual PNG/).textContent,
    ).toContain("may incur service charges");
    expect(screen.queryByLabelText("Authentication")).toBeNull();
    expect(screen.queryByLabelText("Output token parameter")).toBeNull();
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
    field("Verification image prompt", STABILITY_PROMPT);
    expect(button("Test AI connection")).toHaveProperty("disabled", false);
    fireEvent.click(button("Test AI connection"));
    await waitFor(() => expect(f.http.records).toHaveLength(2));
    await waitFor(() =>
      expect(button("Test AI connection")).toHaveProperty("disabled", false),
    );
    const before = loadNativeConnectorRecord(f.saved.connectionId);
    fireEvent.click(button("Save AI connection"));
    await waitFor(() => expect(f.http.records).toHaveLength(3));
    await waitFor(() =>
      expect(loadNativeConnectorRecord(f.saved.connectionId)?.revision).toBe(
        (before?.revision ?? 0) + 1,
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Verification image prompt")).toHaveProperty(
        "value",
        "",
      ),
    );
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
    expect(readAiConnection(f.saved.connectionId)?.baseUrl).toBe(
      f.draft.baseUrl,
    );
    expect(
      f.http.records.every(
        (row) =>
          new Map(row.fields).get("prompt") === STABILITY_PROMPT &&
          new Map(row.fields).get("model") === f.draft.model,
      ),
    ).toBe(true);
    expect(f.onFlash).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(STABILITY_KEY);
  },
);
it("cold restored shared configuration retains a sealed key and requires new transient verification input", async () => {
  const f = await setup();
  f.view.unmount();
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
  render(
    <Configuration
      providerId="stability"
      id={f.saved.connectionId}
      onFlash={f.onFlash}
    />,
  );
  expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Verification image prompt")).toHaveProperty(
    "value",
    "",
  );
  field("Verification image prompt", STABILITY_PROMPT);
  fireEvent.click(button("Test AI connection"));
  await waitFor(() => expect(f.http.records).toHaveLength(2));
  await waitFor(() =>
    expect(button("Test AI connection")).toHaveProperty("disabled", false),
  );
  expect(f.onFlash).not.toHaveBeenCalled();
});
it("changing image binding clears the old key/prompt without changing the saved secret reference or sending requests", async () => {
  const f = await setup("byo-ai");
  const before = loadNativeConnectorRecord(f.saved.connectionId);
  field("Verification image prompt", STABILITY_PROMPT);
  field("API base URL", "https://operator.example/another/images");
  expect(screen.getByLabelText("Verification image prompt")).toHaveProperty(
    "value",
    "",
  );
  expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
  field("Verification image prompt", STABILITY_PROMPT);
  expect(button("Test AI connection")).toHaveProperty("disabled", true);
  expect(button("Save AI connection")).toHaveProperty("disabled", true);
  expect(loadNativeConnectorRecord(f.saved.connectionId)).toEqual(before);
  expect(f.http.records).toHaveLength(1);
});
it.each(["unmount", "cancel", "vault"])(
  "shared %s ownership ends a held Test request before2s without a late success or failure notice",
  async (change) => {
    const f = await setup();
    f.http.state.mode = "hold-body";
    field("Verification image prompt", STABILITY_PROMPT);
    fireEvent.click(button("Test AI connection"));
    await waitFor(() => expect(f.http.state.held).toBeTruthy());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(f.http.records.at(-1)?.closed).toBe(false);
    const start = performance.now();
    act(() => {
      if (change === "unmount") f.view.unmount();
      else if (change === "cancel")
        fireEvent.click(button("Cancel image generation"));
      else vaultStore.lock();
    });
    await waitFor(() => expect(f.http.records.at(-1)?.closed).toBe(true), {
      timeout: 1500,
    });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(f.onFlash).not.toHaveBeenCalled();
    if (change !== "unmount")
      expect(
        screen.queryByRole("button", { name: "Cancel image generation" }),
      ).toBeNull();
  },
);
