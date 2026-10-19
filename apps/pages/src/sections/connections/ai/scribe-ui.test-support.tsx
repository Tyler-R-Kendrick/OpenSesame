import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import {
  SCRIBE_TOKEN,
  ownedSpeechAudio,
  speechTlsFixture,
} from "@opensesame/app-core/lib/ai-connections/speech-tls.test-support.js";
import { readAiConnection } from "@opensesame/app-core/lib/ai-connections/store.js";
import { bindAiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
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
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter, useParams } from "react-router";
import { afterEach, expect, vi } from "vitest";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";

const LocalFile = File;
const closes: (() => Promise<void>)[] = [];
declareConnectionsTutorial();
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
export function field(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), {
    target: { value },
  });
}
export function button(name: string) {
  return screen.getByRole("button", { name });
}
export function savedId() {
  const id = readDeviceRows()[0]?.connectionId;
  if (!id) throw new Error("Expected actual saved AI connection");
  return id;
}
export function draw(providerId: string, id?: string) {
  function Page() {
    const current = useParams().providerId ?? "";
    const provider = getBundledProviders().find((row) => row.id === current);
    if (!provider) throw new Error("Missing bundled provider");
    const connection = id ? deviceConnection(id) : null;
    return (
      <ConnectorSettingsPage
        provider={provider}
        providerId={current}
        connection={connection}
        connections={connection ? [connection] : []}
        loading={false}
        online
        canConfigure
        configureHint=""
        flash={null}
        rememberOffer={null}
        onFlash={vi.fn()}
        onRememberOffer={vi.fn()}
        onChanged={vi.fn()}
      />
    );
  }
  const router = createMemoryRouter(
    [{ path: "/settings/connections/:providerId", element: <Page /> }],
    { initialEntries: [`/settings/connections/${providerId}`] },
  );
  const mounted = render(<RouterProvider router={router} />);
  return {
    ...mounted,
    navigate: (provider: string) =>
      router.navigate(`/settings/connections/${provider}`),
  };
}
export async function setup(providerId = "elevenlabs") {
  // Native Request needs a coherent HTTP realm; uploads retain actual DOM files.
  const form = await new Response("x=y", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }).formData();
  vi.stubGlobal("FormData", form.constructor);
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("crypto", webcrypto);
  const vault = await runtimeFixture();
  const http = await speechTlsFixture(
    providerId === "byo-ai"
      ? "https://operator.example/custom/runtime"
      : "https://api.elevenlabs.io/v1",
  );
  closes.push(vault.close, http.close);
  const release = bindAiConnectionTransport(http.port);
  closes.push(async () => release());
  const user = userEvent.setup();
  const mounted = draw(providerId);
  if (providerId === "byo-ai")
    await user.selectOptions(
      screen.getByLabelText("API family"),
      "elevenlabs_scribe",
    );
  field("API base URL", http.baseUrl);
  field("Model ID", "scribe_v2");
  field("API key", SCRIBE_TOKEN);
  return { vault, http, user, mounted };
}
export function audioFile(
  name = "owned.wav",
  bytes = ownedSpeechAudio().bytes,
  type = "audio/wav",
) {
  return new LocalFile([new Uint8Array(bytes)], name, { type });
}
export async function sample(
  f: Awaited<ReturnType<typeof setup>>,
  label = "Verification audio",
  file = audioFile(),
) {
  await f.user.upload(screen.getByLabelText(label), file);
  await waitFor(() => {
    const section =
      label === "Verification audio"
        ? screen.getByRole("form", { name: "AI connection configuration" })
        : screen.getByRole("region", { name: "Model inference" });
    const control =
      label === "Verification audio"
        ? "Test AI connection"
        : "Transcribe audio";
    expect(
      within(section).getByRole("button", { name: control }),
    ).toHaveProperty("disabled", false);
  });
}
export async function save(f: Awaited<ReturnType<typeof setup>>) {
  await sample(f);
  await f.user.click(button("Save AI connection"));
  await screen.findByRole("region", { name: "Model inference" });
  return savedId();
}
export async function cold() {
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
export async function heldClosed(f: Awaited<ReturnType<typeof setup>>) {
  await waitFor(() =>
    expect(f.http.records.at(-1)).toMatchObject({ closed: true, ended: false }),
  );
}
export function storedDraft(id: string) {
  return readAiConnection(id);
}
