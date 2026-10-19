import { afterEach, expect, it, vi } from "vitest";
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
import { nativeOAuthGuard } from "../native-oauth-session.js";
import {
  runtimeFixture,
  runtimePassword,
} from "../secret-backends/runtime.test-support.js";
import { initializeVaultCredentialCustody } from "../vault-credential-custody.js";
import { vaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import {
  BEDROCK_CREDENTIAL,
  bedrockFixture,
} from "./bedrock-http.test-support.js";
import { aiConnectionBinding, validateAiConnection } from "./configuration.js";
import { aiDelegationAvailable } from "./delegation.js";
import {
  aiConnectionDraft,
  aiConnectionFamilies,
  isAiConnectionProvider,
} from "./presets.js";
import {
  performSavedAiInference,
  saveAiConnection,
  testAiConnection,
} from "./runtime.js";
import { AI_CONNECTION_CLASSIFICATION, readAiConnection } from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
function selected(id: string) {
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
async function setup(withSession = true) {
  const vault = await runtimeFixture();
  const http = await bedrockFixture(withSession, true);
  closes.push(vault.close, http.close);
  const capture = vi.fn(() => http.port);
  const projectionFetch = vi.fn(async () => {
    throw new Error("Projection cannot send provider requests.");
  });
  const release = bindAiConnectionTransport({
    ...http.port,
    capture,
    fetch: projectionFetch,
  });
  closes.push(async () => release());
  const hosted = bindHostedModelAuthority({
    fetch,
    assertCurrent: http.port.assertCurrent,
    read: selected,
    connections: () =>
      readDeviceRows().flatMap((row) => {
        const value = selected(row.connectionId);
        return value ? [value] : [];
      }),
    execute: async () => {
      throw new Error("Must use selected saved AI consumer.");
    },
  });
  closes.push(async () => hosted());
  return { vault, http, capture, projectionFetch };
}
function draft(providerId = "aws-bedrock", withSession = true) {
  const { sessionToken, ...longTerm } = BEDROCK_CREDENTIAL;
  return {
    ...aiConnectionDraft(providerId),
    family: "bedrock_converse" as const,
    bedrock: { region: "us-east-1", credential: "sigv4" as const },
    baseUrl: `https://bedrock-runtime.us-east-1.amazonaws.com${providerId === "byo-ai" ? "/custom/runtime" : ""}`,
    model: "amazon.nova-lite-v1:0",
    apiKey: JSON.stringify(
      withSession ? BEDROCK_CREDENTIAL : longTerm,
      null,
      2,
    ),
  };
}
function required(id: string) {
  const row = loadNativeConnectorRecord(id);
  if (!row) throw new Error("Missing actual saved AI row.");
  return row;
}
const input = {
  model: "amazon.nova-lite-v1:0",
  messages: [
    { role: "user" as const, content: "Actual selected Bedrock question." },
  ],
  maxOutputTokens: 19,
};
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
  ["aws-bedrock", true],
  ["byo-ai", true],
  ["aws-bedrock", false],
  ["byo-ai", false],
] as const)(
  "actually tests/saves/cold-reloads/infers %s session=%s through common hosted inference and sealed Token custody",
  async (provider, session) => {
    const f = await setup(session);
    const value = draft(provider, session);
    await expect(testAiConnection(value)).resolves.toBe(
      "Model inference verified",
    );
    expect(readDeviceRows()).toEqual([]);
    const saved = await saveAiConnection(value);
    const record = required(saved.connectionId);
    expect(aiDelegationAvailable(saved.connectionId)).toBe(false);
    expect(record.configuration.parameters.bedrock_target).toBe(
      JSON.stringify(value.bedrock),
    );
    expect(
      record.privateState.credentials.ai_credential_reference,
    ).toBeTruthy();
    expect(record.privateState.credentials).not.toHaveProperty("api_key");
    expect(readAiConnection(saved.connectionId)).toMatchObject({
      family: "bedrock_converse",
      bedrock: value.bedrock,
      apiKey: "",
    });
    for (const secret of [
      BEDROCK_CREDENTIAL.secretAccessKey,
      BEDROCK_CREDENTIAL.sessionToken,
    ]) {
      expect(JSON.stringify(readDeviceRows())).not.toContain(secret);
      expect([...f.vault.files.values()].join(" ")).not.toContain(secret);
    }
    const keys = vaultStore
      .getSnapshot()
      .items.filter(
        (item) => item.kind === "credential" && item.method.type === "token",
      );
    expect(
      keys.some(
        (item) =>
          item.kind === "credential" &&
          item.method.type === "token" &&
          item.method.token.includes(BEDROCK_CREDENTIAL.secretAccessKey),
      ),
    ).toBe(true);
    await coldReload();
    await expect(
      performHostedInference(saved.connectionId, input, {
        fetch,
        signal: f.http.port.signal,
        assertCurrent: f.http.port.assertCurrent,
      }),
    ).resolves.toMatchObject({
      providerId: provider,
      answer: "Exact Bedrock answer.",
    });
    expect(f.http.records).toHaveLength(3);
    expect(f.capture).toHaveBeenCalledTimes(3);
    expect(f.projectionFetch).not.toHaveBeenCalled();
    expect(f.http.records.every((row) => row.authenticated)).toBe(true);
    expect(f.http.records.at(-1)?.path).toBe(
      `${provider === "byo-ai" ? "/custom/runtime" : ""}/model/amazon.nova-lite-v1%3A0/converse`,
    );
  },
);
it("refuses retained AWS credential replay after region/model/endpoint/auth changes before any request", async () => {
  const f = await setup();
  const saved = await saveAiConnection(draft("byo-ai"));
  const current = readAiConnection(saved.connectionId);
  if (!current?.bedrock) throw new Error("Missing actual public target.");
  const count = f.http.records.length;
  for (const change of [
    { bedrock: { ...current.bedrock, region: "us-west-2" } },
    { baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/other" },
    { model: "amazon.nova-pro-v1:0" },
    { authentication: "none" as const },
    { family: "openai_chat" as const },
  ])
    await expect(
      saveAiConnection({ ...current, ...change }, saved.connectionId),
    ).rejects.toThrow();
  expect(f.http.records).toHaveLength(count);
});
it("rejects malformed public persisted Bedrock metadata before resolving any credential or sending inference", async () => {
  const f = await setup();
  const saved = await saveAiConnection(draft());
  const record = required(saved.connectionId);
  const count = f.http.records.length;
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
          bedrock_target: JSON.stringify({
            region: "us-east-1",
            credential: "sigv4",
            secretAccessKey: BEDROCK_CREDENTIAL.secretAccessKey,
          }),
        },
      },
    }),
  );
  await expect(
    performSavedAiInference(saved.connectionId, input),
  ).rejects.toThrow();
  expect(f.http.records).toHaveLength(count);
});
it("withdraws a held common inference after actual vault lock and never admits its late TLS answer", async () => {
  const f = await setup();
  const saved = await saveAiConnection(draft());
  f.http.setMode("held");
  const answer = vi.fn();
  const count = f.http.records.length;
  const result = expect(
    performSavedAiInference(saved.connectionId, input, undefined, answer),
  ).rejects.toThrow();
  await vi.waitFor(() => expect(f.http.records).toHaveLength(count + 1));
  vaultStore.lock();
  await result;
  await vi.waitFor(() =>
    expect(f.http.records.at(-1)).toMatchObject({ closed: true, ended: false }),
  );
  expect(answer).not.toHaveBeenCalled();
});
it.each(["aws-bedrock", "byo-ai"])(
  "validates and normalizes actual %s AWS credentials while keeping region/model public",
  (provider) => {
    const valid = validateAiConnection(draft(provider));
    expect(valid.apiKey).toBe(JSON.stringify(BEDROCK_CREDENTIAL));
    expect(valid.bedrock).toEqual({ region: "us-east-1", credential: "sigv4" });
    expect(isAiConnectionProvider("aws-bedrock")).toBe(true);
    expect(aiConnectionFamilies(provider)).toContainEqual({
      id: "bedrock_converse",
      label: "Amazon Bedrock Converse",
    });
    const { sessionToken, ...longTerm } = BEDROCK_CREDENTIAL;
    expect(
      validateAiConnection({
        ...draft(provider),
        apiKey: JSON.stringify(longTerm),
      }).apiKey,
    ).not.toContain(sessionToken);
    expect(
      validateAiConnection({ ...draft(provider), apiKey: "" }, false).apiKey,
    ).toBe("");
    expect(() =>
      validateAiConnection({ ...draft(provider), apiKey: "" }),
    ).toThrow();
  },
);
it("binds Bedrock target independently of credential/property order and preserves exact legacy binding bytes", () => {
  const first = validateAiConnection(draft());
  const reordered = validateAiConnection({
    ...draft(),
    bedrock: { credential: "sigv4", region: "us-east-1" },
  });
  expect(aiConnectionBinding(first)).toBe(aiConnectionBinding(reordered));
  expect(aiConnectionBinding(first)).not.toBe(
    aiConnectionBinding(
      validateAiConnection({
        ...draft(),
        baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
        bedrock: { region: "us-west-2", credential: "sigv4" },
      }),
    ),
  );
  const generic = validateAiConnection({
    ...aiConnectionDraft("byo-ai"),
    baseUrl: "https://models.example/v1",
    model: "m",
    apiKey: "secret-key",
  });
  expect(aiConnectionBinding(generic)).toBe(
    '["byo-ai","openai_chat","https://models.example/v1","m","api-key","max_completion_tokens"]',
  );
});
it.each([
  {
    bedrock: {
      region: "us-east-1",
      credential: "sigv4",
      secretAccessKey: BEDROCK_CREDENTIAL.secretAccessKey,
    },
  },
  { baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com" },
  { authentication: "none" },
  { family: "openai_chat" },
  {
    vertex: {
      project: "p",
      location: "us-central1",
      credential: "access-token",
    },
  },
  { name: `Public ${BEDROCK_CREDENTIAL.secretAccessKey}` },
  { model: BEDROCK_CREDENTIAL.accessKeyId },
  { apiKey: JSON.stringify({ ...BEDROCK_CREDENTIAL, extra: "not allowed" }) },
  { apiKey: JSON.stringify({ ...BEDROCK_CREDENTIAL, sessionToken: "short" }) },
])(
  "refuses invalid or ambiguous public Bedrock targets and malformed/echoed credentials %#",
  (change) => {
    expect(() => validateAiConnection({ ...draft(), ...change })).toThrow();
  },
);
it.each(["target", "mode", "key"])(
  "refuses changed saved %s before any further signed request",
  async (field) => {
    const f = await setup();
    const saved = await saveAiConnection(draft());
    const count = f.http.records.length;
    if (field === "key") {
      const item = vaultStore
        .getSnapshot()
        .items.find(
          (item) => item.kind === "credential" && item.method.type === "token",
        );
      if (!item || item.kind !== "credential" || item.method.type !== "token")
        throw new Error("Missing sealed AWS credential.");
      await vaultStore.saveItems([
        {
          ...item,
          method: {
            ...item.method,
            token: JSON.stringify({
              ...BEDROCK_CREDENTIAL,
              secretAccessKey: "differentOwnedSecretAccessKey0123456789",
            }),
          },
        },
      ]);
    } else {
      const record = required(saved.connectionId);
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
              [field === "mode" ? "family" : "bedrock_target"]:
                field === "mode"
                  ? "openai_chat"
                  : JSON.stringify({
                      region: "us-west-2",
                      credential: "sigv4",
                    }),
            },
          },
        }),
      );
    }
    await expect(
      performSavedAiInference(saved.connectionId, input),
    ).rejects.toThrow();
    expect(f.http.records).toHaveLength(count);
  },
);
