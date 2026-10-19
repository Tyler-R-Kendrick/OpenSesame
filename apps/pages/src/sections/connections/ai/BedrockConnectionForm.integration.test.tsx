/** @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import {
  BEDROCK_CREDENTIAL,
  bedrockFixture,
} from "@opensesame/app-core/lib/ai-connections/bedrock-http.test-support.js";
import { performSavedAiInference } from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { readAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import { bindAiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import { approvedPlan } from "@opensesame/app-core/lib/capabilities/__tests__/plan-fixtures.js";
import { describeCapability } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { createEgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import {
  kvFlush,
  kvForgetAll,
  kvHydrate,
} from "@opensesame/app-core/lib/kv.js";
import {
  runtimeFixture,
  runtimePassword,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { initializeVaultCredentialCustody } from "@opensesame/app-core/lib/vault-credential-custody.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vfsFlush } from "@opensesame/app-core/lib/vfs.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createActivation } from "../../../modules/activation.js";
import { bindAiConnectionRuntime } from "../../../modules/connectors.external/ai-connection-runtime.js";
import { bindNativeRuntime } from "../../../modules/connectors.external/native-runtime.js";
import { createTestContext } from "../../../modules/test-context.js";
import { AiConnectionPanels } from "./AiConnectionPanels.js";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
});
function mount(providerId: string, id?: string) {
  return render(
    <AiConnectionPanels
      providerId={providerId}
      connectionId={id}
      onFlash={() => {}}
    />,
  );
}
function field(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), {
    target: { value },
  });
}
const credentialLabels = [
  "AWS access key ID",
  "AWS secret access key",
  "AWS session token (optional)",
];
function credentials(session = true) {
  field(credentialLabels[0], BEDROCK_CREDENTIAL.accessKeyId);
  field(credentialLabels[1], BEDROCK_CREDENTIAL.secretAccessKey);
  if (session) field(credentialLabels[2], BEDROCK_CREDENTIAL.sessionToken);
}
function writeOnlyEmpty() {
  for (const label of credentialLabels) {
    expect(screen.getByLabelText(label)).toHaveProperty("value", "");
    expect(screen.getByLabelText(label)).toHaveProperty("type", "password");
  }
}
async function setup(providerId = "aws-bedrock", withSession = true) {
  vi.stubGlobal("crypto", webcrypto);
  const vault = await runtimeFixture();
  const http = await bedrockFixture(withSession, true);
  closes.push(vault.close, http.close);
  const release = bindAiConnectionTransport(http.port);
  closes.push(async () => release());
  const user = userEvent.setup();
  mount(providerId);
  if (providerId === "byo-ai")
    await user.selectOptions(
      screen.getByLabelText("API family"),
      "bedrock_converse",
    );
  field("Model ID", "amazon.nova-lite-v1:0");
  if (providerId === "byo-ai")
    field(
      "Bedrock runtime endpoint",
      "https://bedrock-runtime.us-east-1.amazonaws.com/custom/runtime",
    );
  credentials(withSession);
  return { vault, http, user };
}
async function cold() {
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
  ["aws-bedrock", false],
  ["byo-ai", true],
  ["byo-ai", false],
] as const)(
  "mounts shared %s Test/Save/cold selected inference with real TLS and session=%s",
  async (provider, session) => {
    const f = await setup(provider, session);
    expect(screen.getByLabelText("Bedrock runtime endpoint")).toHaveProperty(
      "readOnly",
      provider === "aws-bedrock",
    );
    await f.user.click(
      screen.getByRole("button", { name: "Test AI connection" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Model inference verified")).toBeTruthy(),
    );
    expect(readDeviceRows()).toEqual([]);
    await f.user.click(
      screen.getByRole("button", { name: "Save AI connection" }),
    );
    await screen.findByRole("region", { name: "Model inference" });
    const id = readDeviceRows()[0]?.connectionId;
    if (!id) throw new Error("Missing actual saved Bedrock connection.");
    writeOnlyEmpty();
    expect(readAiConnection(id)).toMatchObject({
      bedrock: { region: "us-east-1", credential: "sigv4" },
      apiKey: "",
    });
    expect(screen.queryByLabelText("Stream response")).toBeNull();
    expect(JSON.stringify(readDeviceRows())).not.toContain(
      BEDROCK_CREDENTIAL.secretAccessKey,
    );
    cleanup();
    await act(cold);
    mount(provider, id);
    writeOnlyEmpty();
    field("Prompt", "Mounted actual Bedrock question.");
    await f.user.click(screen.getByRole("button", { name: "Send prompt" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Model answer").textContent).toBe(
        "Exact Bedrock answer.",
      ),
    );
    expect(f.http.records).toHaveLength(3);
    expect(f.http.records.every((row) => row.authenticated)).toBe(true);
    expect(f.http.records.at(-1)?.path).toBe(
      `${provider === "byo-ai" ? "/custom/runtime" : ""}/model/amazon.nova-lite-v1%3A0/converse`,
    );
    expect(JSON.parse(f.http.records.at(-1)?.body ?? "").messages).toEqual([
      { role: "user", content: [{ text: "Mounted actual Bedrock question." }] },
    ]);
    field("Model ID", "amazon.nova-pro-v1:0");
    expect(
      screen.getByRole("button", { name: "Save AI connection" }),
    ).toHaveProperty("disabled", true);
    expect(f.http.records).toHaveLength(3);
  },
);
it("changes region through the common typed hook, clears write-only credentials on target changes and actual vault lock", async () => {
  const f = await setup();
  field("AWS region", "us-west-2");
  expect(screen.getByLabelText("Bedrock runtime endpoint")).toHaveProperty(
    "value",
    "https://bedrock-runtime.us-west-2.amazonaws.com/",
  );
  writeOnlyEmpty();
  expect(
    screen.getByRole("button", { name: "Save AI connection" }),
  ).toHaveProperty("disabled", true);
  credentials();
  await act(async () => vaultStore.lock());
  writeOnlyEmpty();
  expect(f.http.records).toHaveLength(0);
});

it("clears AWS credentials before the common BYO form can switch to an API-key family", async () => {
  const f = await setup("byo-ai");
  await f.user.selectOptions(
    screen.getByLabelText("API family"),
    "openai_chat",
  );
  for (const label of credentialLabels)
    expect(screen.queryByLabelText(label)).toBeNull();
  expect(screen.getByLabelText("API key", { exact: true })).toHaveProperty(
    "value",
    "",
  );
  expect(f.http.records).toHaveLength(0);
});

it("retains the actual approved PWA AI egress policy and captured carrier for signed Bedrock, including allowlist and activation withdrawal", async () => {
  const f = await setup();
  const descriptor = describeCapability("connectors.external");
  if (!descriptor) throw new Error("Missing actual provider capability.");
  const plan = approvedPlan(["connectors.external"]);
  const currentPlan = {
    ...plan,
    network: {
      ...plan.network,
      externalServices: "allow" as const,
      allowedServiceOrigins: [
        "https://bedrock-runtime.us-east-1.amazonaws.com",
      ],
    },
  };
  const carrier = vi.fn<typeof fetch>((input, init) =>
    f.http.port.fetch(
      input instanceof Request ? input.url : String(input),
      init,
    ),
  );
  const egress = createEgressPort({
    capability: descriptor,
    plan: () => currentPlan,
    allowedOrigins: [window.location.origin],
    fetchImpl: carrier,
  });
  const ctx = { ...createTestContext().ctx, egress };
  const activation = createActivation(ctx, "connectors.external");
  closes.push(async () => activation.dispose());
  bindNativeRuntime(ctx, activation);
  bindAiConnectionRuntime(ctx, activation);
  const ambient = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No ambient fallback"));
  await f.user.click(
    screen.getByRole("button", { name: "Save AI connection" }),
  );
  await screen.findByRole("region", { name: "Model inference" });
  const id = readDeviceRows()[0]?.connectionId;
  if (!id) throw new Error("Missing real saved Bedrock connection.");
  expect(deviceConnection(id)?.status).toBe("active");
  expect(carrier).toHaveBeenCalledTimes(1);
  expect(f.http.records[0]?.authenticated).toBe(true);
  expect(ambient).not.toHaveBeenCalled();
  currentPlan.network.allowedServiceOrigins = ["https://withdrawn.example"];
  expect(deviceConnection(id)?.status).toBe("pending");
  const input = {
    model: "amazon.nova-lite-v1:0",
    messages: [
      { role: "user" as const, content: "Withheld by original policy." },
    ],
  };
  await expect(performSavedAiInference(id, input)).rejects.toThrow();
  expect(carrier).toHaveBeenCalledTimes(1);
  activation.dispose();
  await expect(performSavedAiInference(id, input)).rejects.toThrow();
  expect(carrier).toHaveBeenCalledTimes(1);
  expect(ambient).not.toHaveBeenCalled();
});

it.each(["AWS access key ID", "AWS secret access key"])(
  "requires %s in the shared form without sending incomplete credentials",
  async (label) => {
    const f = await setup();
    field(label, "");
    for (const name of ["Test AI connection", "Save AI connection"])
      expect(screen.getByRole("button", { name })).toHaveProperty(
        "disabled",
        true,
      );
    expect(f.http.records).toHaveLength(0);
  },
);

it("physically cancels a held finite Converse answer when its mounted workspace unmounts", async () => {
  const f = await setup();
  await f.user.click(
    screen.getByRole("button", { name: "Save AI connection" }),
  );
  await screen.findByRole("region", { name: "Model inference" });
  f.http.setMode("held");
  const count = f.http.records.length;
  field("Prompt", "Hold this original mounted request.");
  await f.user.click(screen.getByRole("button", { name: "Send prompt" }));
  await waitFor(() => expect(f.http.records).toHaveLength(count + 1));
  cleanup();
  await waitFor(
    () =>
      expect(f.http.records.at(-1)).toMatchObject({
        closed: true,
        ended: false,
      }),
    { timeout: 2000 },
  );
  expect(document.body.textContent).not.toContain("Exact Bedrock answer.");
});
