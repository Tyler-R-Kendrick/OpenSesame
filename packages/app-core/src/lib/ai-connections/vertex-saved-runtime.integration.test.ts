import { afterEach, expect, it } from "vitest";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "../device-connector-records.js";
import { performHostedInference } from "../hosted-inference.js";
import { bindHostedModelAuthority } from "../hosted-model-authority.js";
import { kvFlush, kvForgetAll, kvHydrate } from "../kv.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "../native-connector-store.js";
import { gcpKeyFile, installGcpKey } from "../native-gcp.test-support.js";
import { nativeOAuthGuard } from "../native-oauth-session.js";
import {
  runtimeFixture,
  runtimePassword,
} from "../secret-backends/runtime.test-support.js";
import { initializeVaultCredentialCustody } from "../vault-credential-custody.js";
import { vaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import { aiConnectionDraft } from "./presets.js";
import {
  performSavedAiInference,
  saveAiConnection,
  testAiConnection,
} from "./runtime.js";
import { AI_CONNECTION_CLASSIFICATION, readAiConnection } from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";
import { TOKEN, vertexFixture } from "./vertex-http.test-support.js";
import type { VertexAiDraft } from "./vertex-target.js";
installGcpKey();
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
});
function selectedConnection(id: string) {
  const view = readNativeConnector(id);
  const draft = readAiConnection(id);
  return view && draft
    ? {
        connectionId: id,
        providerId: view.providerId,
        status: view.status,
        method: view.configuration.method,
        model: draft.model,
        endpoint: draft.baseUrl,
      }
    : null;
}
async function prepare() {
  const vault = await runtimeFixture();
  const http = await vertexFixture();
  releases.push(bindAiConnectionTransport(http.port));
  releases.push(
    bindHostedModelAuthority({
      fetch,
      assertCurrent: http.port.assertCurrent,
      read: selectedConnection,
      connections: () =>
        readDeviceRows().flatMap((row) => {
          const value = selectedConnection(row.connectionId);
          return value ? [value] : [];
        }),
      execute: async () => {
        throw new Error("Must use selected saved AI runtime");
      },
    }),
  );
  return {
    vault,
    http,
    async close() {
      for (const release of releases.splice(0).reverse()) release();
      await http.close();
      await vault.close();
    },
  };
}
function draft(
  providerId = "google-vertex",
  credential: "service-account" | "access-token" = "service-account",
): VertexAiDraft {
  return {
    ...aiConnectionDraft(providerId),
    family: "gemini_generate_content",
    baseUrl:
      providerId === "byo-ai"
        ? "http://localhost:41999/custom/vertex"
        : "https://us-central1-aiplatform.googleapis.com/v1",
    model: "gemini-2.5-flash",
    apiKey: credential === "service-account" ? gcpKeyFile() : TOKEN,
    vertex: { project: "my-project-123", location: "us-central1", credential },
  };
}
function required(id: string) {
  const record = loadNativeConnectorRecord(id);
  if (!record) throw new Error("Missing actual saved record");
  return record;
}
function input(model = "gemini-2.5-flash") {
  return {
    model,
    messages: [{ role: "user" as const, content: "Selected actual question." }],
    maxOutputTokens: 19,
  };
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
it.each([
  ["google-vertex", "service-account"],
  ["byo-ai", "service-account"],
  ["google-vertex", "access-token"],
  ["byo-ai", "access-token"],
] as const)(
  "saves, cold-reloads and actually invokes selected %s %s with sealed credential",
  async (provider, credential) => {
    const run = await prepare();
    try {
      const value = draft(provider, credential);
      await testAiConnection(value);
      expect(readDeviceRows()).toEqual([]);
      const saved = await saveAiConnection(value);
      const record = required(saved.connectionId);
      expect(record.configuration.parameters.vertex_target).toBe(
        JSON.stringify(value.vertex),
      );
      expect(record.privateState.credentials).not.toHaveProperty("api_key");
      expect(
        record.privateState.credentials.ai_credential_reference,
      ).toBeTruthy();
      expect(readAiConnection(saved.connectionId)).toMatchObject({
        apiKey: "",
        vertex: value.vertex,
      });
      expect(JSON.stringify(record.configuration)).not.toContain(value.apiKey);
      expect([...run.vault.files.values()].join(" ")).not.toContain(
        value.apiKey,
      );
      if (credential === "service-account")
        expect([...run.vault.files.values()].join(" ")).not.toContain(
          JSON.parse(value.apiKey).private_key,
        );
      await coldReload();
      await expect(
        performHostedInference(saved.connectionId, input(), {
          fetch,
          signal: run.http.port.signal,
          assertCurrent: run.http.port.assertCurrent,
        }),
      ).resolves.toMatchObject({
        providerId: provider,
        answer: "Exact Vertex answer.",
      });
      expect(
        run.http.records.filter((row) => row.path.endsWith(":generateContent")),
      ).toHaveLength(3);
      expect(run.http.records.every((row) => row.authenticated)).toBe(true);
    } finally {
      await run.close();
    }
  },
);
it("never replays retained credential after public target/model/mode changes", async () => {
  const run = await prepare();
  try {
    const saved = await saveAiConnection(draft("byo-ai"));
    const current = readAiConnection(saved.connectionId);
    if (!current?.vertex)
      throw new Error("Actual public Vertex metadata required");
    const before = run.http.records.length;
    for (const change of [
      { vertex: { ...current.vertex, project: "other-project-123" } },
      { vertex: { ...current.vertex, location: "europe-west4" } },
      { vertex: { ...current.vertex, credential: "access-token" as const } },
      { baseUrl: "http://localhost:41999/changed" },
      { model: "gemini-2.0-flash" },
    ])
      await expect(
        saveAiConnection({ ...current, ...change }, saved.connectionId),
      ).rejects.toThrow("Enter a new API key");
    expect(run.http.records).toHaveLength(before);
    const rebound = {
      ...current,
      vertex: { ...current.vertex, project: "other-project-123" },
      apiKey: gcpKeyFile(),
    };
    await saveAiConnection(rebound, saved.connectionId);
    await expect(
      performSavedAiInference(saved.connectionId, input()),
    ).resolves.toMatchObject({ answer: "Exact Vertex answer." });
    expect(run.http.records.at(-1)?.path).toContain(
      "/projects/other-project-123/",
    );
  } finally {
    await run.close();
  }
});
it("rejects a malformed or secret-bearing persisted target before resolving credential/egress", async () => {
  const run = await prepare();
  try {
    const saved = await saveAiConnection(draft());
    const record = required(saved.connectionId);
    const before = run.http.records.length;
    await updateNativeConnector(
      saved.connectionId,
      nativeOAuthGuard(record),
      AI_CONNECTION_CLASSIFICATION,
      (current) => ({
        ...current,
        configuration: {
          ...current.configuration,
          parameters: {
            ...current.configuration.parameters,
            vertex_target: JSON.stringify({
              ...draft().vertex,
              access_token: TOKEN,
            }),
          },
        },
      }),
    );
    expect(() => readAiConnection(saved.connectionId)).toThrow(
      "saved Vertex target is invalid",
    );
    await expect(
      performSavedAiInference(saved.connectionId, input()),
    ).rejects.toThrow();
    expect(run.http.records).toHaveLength(before);
  } finally {
    await run.close();
  }
});
it("keeps saved A and B inference bound to their own project and stops original held A after lock", async () => {
  const run = await prepare();
  try {
    const a = await saveAiConnection(draft());
    const other = draft("byo-ai", "access-token");
    other.vertex.project = "other-project-123";
    const b = await saveAiConnection(other);
    run.http.setMode("held");
    const before = run.http.records.length;
    const late = performSavedAiInference(a.connectionId, input());
    const refused = expect(late).rejects.toThrow();
    await expect.poll(() => run.http.records.length).toBe(before + 2);
    const held = run.http.records.at(-1);
    expect(held?.path).toContain("my-project-123");
    run.http.setMode("complete");
    await expect(
      performSavedAiInference(b.connectionId, input()),
    ).resolves.toMatchObject({ answer: "Exact Vertex answer." });
    expect(run.http.records.at(-1)?.path).toContain("other-project-123");
    vaultStore.lock();
    await refused;
    await expect.poll(() => held?.closed).toBe(true);
    expect(held?.ended).toBe(false);
  } finally {
    await run.close();
  }
});
