import { webcrypto } from "node:crypto";
import {
  REPLICATE_TOKEN,
  replicateTlsFixture,
} from "@opensesame/app-core/lib/ai-connections/replicate-tls.test-support.js";
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
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter, useParams } from "react-router";
import { afterEach, vi } from "vitest";
import { ConnectorSettingsPage } from "../SettingsPage.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";

const closes: (() => Promise<void>)[] = [];
declareConnectionsTutorial();
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
export const verification = {
  subject: "Transient mounted verification",
  iterations: 1,
};
export const operation = {
  subject: "Actual cold model operation",
  iterations: 3,
};
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
export async function setup(providerId = "replicate") {
  vi.stubGlobal("crypto", webcrypto);
  const vault = await runtimeFixture();
  const http = await replicateTlsFixture(
    providerId === "byo-ai"
      ? "https://operator.example/custom/runtime"
      : "https://api.replicate.com/v1",
  );
  http.state.pollsBeforeSuccess = 0;
  closes.push(vault.close, http.close);
  const release = bindAiConnectionTransport(http.port);
  closes.push(async () => release());
  const user = userEvent.setup();
  const mounted = draw(providerId);
  if (providerId === "byo-ai")
    await user.selectOptions(
      screen.getByLabelText("API family"),
      "replicate_predictions",
    );
  field("API base URL", http.baseUrl);
  field("Model ID", "owner/model");
  field("API key", REPLICATE_TOKEN);
  return { vault, http, user, mounted };
}
export async function clickTerminal(
  f: Awaited<ReturnType<typeof setup>>,
  label: string,
) {
  let complete = () => {};
  const terminal = new Promise<void>((resolve) => {
    complete = resolve;
  });
  f.http.state.onTerminal = complete;
  await act(async () => {
    await f.user.click(button(label));
    await terminal;
  });
}
export async function save(f: Awaited<ReturnType<typeof setup>>) {
  field("Prediction verification input JSON", JSON.stringify(verification));
  await clickTerminal(f, "Save AI connection");
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
  await waitFor(() => {
    const held = [...f.http.requests]
      .reverse()
      .find((row) => row.method === "GET");
    if (!held?.closed || held.ended)
      throw new Error("Expected original held HTTP to close");
  });
}
export function storedDraft(id: string) {
  return readAiConnection(id);
}
