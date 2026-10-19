/** @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import {
  encryptedRemoteFixture,
  independentOpen,
} from "@opensesame/app-core/lib/secret-backends/encrypted-remote.test-support.js";
import { runtimePassword } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { hydrateSecretBackendConnections } from "@opensesame/app-core/lib/secret-backends/store.js";
import { bindSecretBackendTransport } from "@opensesame/app-core/lib/secret-backends/transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
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
import { SecretBackendPanels } from "./SecretBackendPanels.js";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
});
function provider(id: string): Provider {
  return {
    id,
    displayName: id,
    category: "developer",
    authKind: "configuration",
    configured: false,
    docsUrl: "https://example.com",
    supportsRefresh: false,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    operations: [],
  };
}
function mount(id: string) {
  return render(
    <SecretBackendPanels
      provider={provider(id)}
      connection={null}
      online={true}
      onFlash={() => {}}
      onChanged={() => {}}
    />,
  );
}
function field(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
async function setup(id: string) {
  vi.stubGlobal("crypto", webcrypto);
  const f = await encryptedRemoteFixture();
  closes.push(f.close);
  const bind = () => {
    const unbind = bindSecretBackendTransport(f.capture().transport);
    closes.push(async () => unbind());
  };
  bind();
  const user = userEvent.setup();
  mount(id);
  if (id === "byo-secret-backend")
    await user.selectOptions(
      screen.getByLabelText("Connection method"),
      "encrypted-remote",
    );
  field("Encrypted object HTTPS URL", f.config.objectUrl);
  field("Encrypted store UUID", f.config.storeId);
  field("Inventory encryption key (base64, 32 bytes)", f.config.encryptionKey);
  field("Object bearer token (optional)", f.config.bearerToken);
  return { ...f, bind, user };
}
it("saves independent key credentials from the mounted native form, cold-remounts and performs actual TLS CRUD through its workspace", async () => {
  const f = await setup("encrypted-remote");
  await f.user.click(
    screen.getByRole("button", { name: "Save secret backend" }),
  );
  await screen.findByRole("button", {
    name: "Connect saved secret backend",
  });
  expect(
    screen.getByLabelText("Inventory encryption key (base64, 32 bytes)"),
  ).toHaveProperty("value", "");
  cleanup();
  await act(async () => {
    vaultStore.lock();
    kvForgetAll();
    await vaultStore.unlock(runtimePassword);
    await hydrateSecretBackendConnections();
  });
  f.bind();
  mount("encrypted-remote");
  await f.user.click(
    screen.getByRole("button", {
      name: "Connect saved secret backend",
    }),
  );
  await f.user.click(
    await screen.findByRole("button", {
      name: "List backend items",
    }),
  );
  await screen.findByText("Independent fixture note");
  await f.user.click(screen.getByRole("button", { name: "New backend item" }));
  field("Item name", "Mounted encrypted note");
  field("Notes", "Actual mounted plaintext");
  await f.user.click(
    screen.getByRole("button", { name: "Create backend item" }),
  );
  await waitFor(() =>
    expect(
      independentOpen(f.state.bytes, f.config.objectUrl).items,
    ).toContainEqual(
      expect.objectContaining({
        name: "Mounted encrypted note",
        notes: "Actual mounted plaintext",
      }),
    ),
  );
  await f.user.click(
    await screen.findByRole("button", {
      name: "Open backend item Mounted encrypted note",
    }),
  );
  await f.user.click(
    await screen.findByRole("button", {
      name: "Edit backend item",
    }),
  );
  field("Notes", "Updated mounted note");
  await f.user.click(
    screen.getByRole("button", { name: "Update backend item" }),
  );
  await waitFor(() =>
    expect(
      independentOpen(f.state.bytes, f.config.objectUrl).items,
    ).toContainEqual(
      expect.objectContaining({ notes: "Updated mounted note" }),
    ),
  );
  const reopened = await screen.findByRole("button", {
    name: "Open backend item Mounted encrypted note",
  });
  await waitFor(() => expect(reopened).toHaveProperty("disabled", false));
  await f.user.click(reopened);
  await f.user.click(
    await screen.findByRole("button", {
      name: "Delete backend item",
    }),
  );
  await f.user.click(
    screen.getByRole("button", {
      name: "Confirm delete backend item",
    }),
  );
  await waitFor(() =>
    expect(
      independentOpen(f.state.bytes, f.config.objectUrl).items,
    ).not.toContainEqual(
      expect.objectContaining({ name: "Mounted encrypted note" }),
    ),
  );
  expect(
    f.requests
      .filter((row) => row.method === "PUT")
      .every((row) => !row.body.includes("mounted")),
  ).toBe(true);
});
it("mounts the same fields in BYO and initializes only after the separate explicit action", async () => {
  const f = await setup("byo-secret-backend");
  f.state.missing = true;
  expect(
    screen.getByRole("button", {
      name: "Initialize empty encrypted remote",
    }),
  ).toHaveProperty("disabled", true);
  await f.user.click(
    screen.getByRole("button", { name: "Save secret backend" }),
  );
  await screen.findByRole("button", {
    name: "Connect saved secret backend",
  });
  await f.user.click(
    screen.getByRole("button", {
      name: "Connect saved secret backend",
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: "Initialize empty encrypted remote",
      }),
    ).toHaveProperty("disabled", false),
  );
  expect(f.requests.every((row) => row.method === "GET")).toBe(true);
  await f.user.click(
    screen.getByRole("button", {
      name: "Initialize empty encrypted remote",
    }),
  );
  await screen.findByRole("region", {
    name: "Secret backend items",
  });
  expect(f.requests.filter((row) => row.method === "PUT")).toEqual([
    expect.objectContaining({ noneMatch: "*", match: "" }),
  ]);
});
