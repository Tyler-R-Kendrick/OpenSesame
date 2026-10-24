/** @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { validateAiConnection } from "@opensesame/app-core/lib/ai-connections/configuration.js";
import {
  OLLAMA_KEY,
  OLLAMA_MODEL,
  OLLAMA_TEXT,
  ollamaTlsFixture,
} from "@opensesame/app-core/lib/ai-connections/ollama-tls.test-support.js";
import {
  aiConnectionDraft,
  aiConnectionFamilies,
} from "@opensesame/app-core/lib/ai-connections/presets.js";
import {
  deleteAiConnection,
  performSavedAiInference,
  saveAiConnection,
  testAiConnection,
} from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { readAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import { bindAiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { loadNativeConnectorRecord } from "@opensesame/app-core/lib/native-connector-store.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import * as ui from "./scribe-ui.test-support.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
});
async function setup(authenticated = false) {
  vi.stubGlobal("crypto", webcrypto);
  const vault = await runtimeFixture();
  const http = await ollamaTlsFixture(authenticated);
  closes.push(vault.close, http.close);
  const release = bindAiConnectionTransport(http.port);
  closes.push(async () => release());
  const user = userEvent.setup();
  const mounted = ui.draw("ollama");
  ui.field("API base URL", http.baseUrl);
  ui.field("Model ID", OLLAMA_MODEL);
  if (authenticated) {
    await user.selectOptions(
      screen.getByLabelText("Authentication"),
      "api-key",
    );
    ui.field("API key", OLLAMA_KEY);
  }
  const draft = {
    ...aiConnectionDraft("ollama"),
    baseUrl: http.baseUrl,
    model: OLLAMA_MODEL,
    authentication: authenticated ? ("api-key" as const) : ("none" as const),
    apiKey: authenticated ? OLLAMA_KEY : "",
  };
  return { vault, http, user, mounted, draft };
}

it("offers the native Ollama form with official local defaults and no credential or network on mount", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const vault = await runtimeFixture();
  closes.push(vault.close);
  const fetcher = vi.spyOn(globalThis, "fetch");
  ui.draw("ollama");
  expect(catalogProvider("ollama")).toMatchObject({
    id: "ollama",
    category: "ai_model_provider",
    authKind: "configuration",
    modelApi: { protocol: "openai_chat" },
  });
  expect(screen.getByLabelText("Connection name")).toHaveProperty(
    "value",
    "Ollama",
  );
  expect(screen.getByLabelText("API base URL")).toHaveProperty(
    "value",
    "http://localhost:11434/v1",
  );
  expect(screen.getByLabelText("Authentication")).toHaveProperty(
    "value",
    "none",
  );
  expect(screen.queryByLabelText("API key")).toBeNull();
  expect(aiConnectionFamilies("ollama").map((family) => family.id)).toEqual([
    "openai_chat",
  ]);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([false, true])(
  "tests, saves and cold-restores actual native Ollama inference (authenticated=%s)",
  async (authenticated) => {
    const f = await setup(authenticated);
    await f.user.click(ui.button("Test AI connection"));
    await screen.findByLabelText("Model inference verified");
    expect(readDeviceRows()).toEqual([]);
    await f.user.click(ui.button("Save AI connection"));
    await screen.findByRole("region", { name: "Model inference" });
    const id = ui.savedId();
    expect(readAiConnection(id)).toMatchObject({
      providerId: "ollama",
      family: "openai_chat",
      baseUrl: f.http.baseUrl,
      model: OLLAMA_MODEL,
      authentication: authenticated ? "api-key" : "none",
      apiKey: "",
      tokenParameter: "max_tokens",
    });
    expect(JSON.stringify(readDeviceRows())).not.toContain(OLLAMA_KEY);
    expect(JSON.stringify(readDeviceSecrets())).not.toContain(OLLAMA_KEY);
    expect([...f.vault.files.values()].join()).not.toContain(OLLAMA_KEY);
    expect(
      vaultStore
        .getSnapshot()
        .items.filter((item) => item.kind === "credential"),
    ).toHaveLength(authenticated ? 1 : 0);
    cleanup();
    await ui.cold();
    ui.draw("ollama", id);
    expect(screen.getByLabelText("API base URL")).toHaveProperty(
      "value",
      f.http.baseUrl,
    );
    if (authenticated)
      expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
    ui.field("Prompt", "Explain the actual configured Ollama model");
    await f.user.click(ui.button("Send prompt"));
    await waitFor(() =>
      expect(screen.getByLabelText("Model answer").textContent).toBe(
        OLLAMA_TEXT,
      ),
    );
    expect(f.http.records).toHaveLength(3);
    expect(
      f.http.records.every(
        (row) =>
          row.finished &&
          row.model === OLLAMA_MODEL &&
          row.authenticated === authenticated,
      ),
    ).toBe(true);
    expect(f.http.records[2]?.stream).toBe(true);
    expect(f.http.errors).toEqual([]);
    const result = await performSavedAiInference(id, {
      model: OLLAMA_MODEL,
      messages: [{ role: "user", content: "Finite completion" }],
    });
    expect(result.answer).toBe(OLLAMA_TEXT);
    expect(f.http.records.at(-1)).toMatchObject({
      stream: false,
      finished: true,
    });
  },
);

it.each(["caller", "owner", "vault", "remove"] as const)(
  "physically closes an Ollama response and refuses its result after %s withdrawal",
  async (kind) => {
    const f = await setup(true);
    const saved = await saveAiConnection(f.draft);
    const caller = new AbortController();
    f.http.state.hold = true;
    const result = performSavedAiInference(
      saved.connectionId,
      {
        model: OLLAMA_MODEL,
        messages: [{ role: "user", content: "Hold original owner" }],
      },
      {
        signal: caller.signal,
        assertCurrent: () => caller.signal.throwIfAborted(),
      },
    ).then(
      () => "accepted",
      () => "refused",
    );
    await waitFor(() => expect(f.http.records).toHaveLength(2));
    if (kind === "caller") caller.abort();
    if (kind === "owner") f.http.lifetime.abort();
    if (kind === "vault") vaultStore.lock();
    if (kind === "remove") await deleteAiConnection(saved.connectionId);
    expect(await result).toBe("refused");
    await waitFor(() =>
      expect(f.http.records[1]).toMatchObject({
        closed: true,
        finished: false,
      }),
    );
    expect(f.http.errors).toEqual([]);
  },
);

it("the actual workspace route withdrawal closes its original HTTP response", async () => {
  const f = await setup();
  await f.user.click(ui.button("Save AI connection"));
  await screen.findByRole("region", { name: "Model inference" });
  f.http.state.hold = true;
  await f.user.click(screen.getByLabelText("Stream response"));
  ui.field("Prompt", "Do not deliver after leaving this route");
  await f.user.click(ui.button("Send prompt"));
  await waitFor(() => expect(f.http.records).toHaveLength(2));
  await act(async () => {
    await f.mounted.navigate("openai");
  });
  await waitFor(() =>
    expect(f.http.records[1]).toMatchObject({ closed: true, finished: false }),
  );
  expect(screen.queryByLabelText("Model answer")).toBeNull();
});

it.each(["malformed", "oversized", "reflected"] as const)(
  "does not save a credential-probe-only success for %s actual inference response",
  async (kind) => {
    const f = await setup(true);
    f.http.state[kind] = true;
    await expect(testAiConnection(f.draft)).rejects.toThrow();
    expect(readDeviceRows()).toEqual([]);
    expect(vaultStore.getSnapshot().items).toEqual([]);
    expect(f.http.records).toHaveLength(1);
  },
);

it("refuses endpoint, model and credential confusion before sending any new request", async () => {
  const f = await setup(true);
  const saved = await saveAiConnection(f.draft);
  const record = loadNativeConnectorRecord(saved.connectionId);
  expect(record?.privateState.credentials.ai_credential_reference).toBeTruthy();
  await expect(
    saveAiConnection(
      { ...f.draft, apiKey: "", baseUrl: "https://elsewhere.example/v1" },
      saved.connectionId,
    ),
  ).rejects.toThrow(/new API key/);
  expect(() =>
    validateAiConnection({ ...f.draft, model: "invalid model" }),
  ).toThrow();
  expect(() =>
    validateAiConnection({
      ...f.draft,
      baseUrl: "http://elsewhere.example/v1",
    }),
  ).toThrow();
  expect(() =>
    validateAiConnection({ ...f.draft, name: OLLAMA_KEY }),
  ).toThrow();
  expect(f.http.records).toHaveLength(1);
});
