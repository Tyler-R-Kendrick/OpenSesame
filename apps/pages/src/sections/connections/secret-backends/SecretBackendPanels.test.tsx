/** @vitest-environment jsdom */
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { secretBackendDraft } from "@opensesame/app-core/lib/secret-backends/presets.js";
import type {
  SecretBackend,
  SecretBackendDraft,
} from "@opensesame/app-core/lib/secret-backends/types.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecretBackendPanels } from "./SecretBackendPanels.js";
import { secretBackendDependencies as dependencies } from "./secret-backend-dependencies.js";

let stored: SecretBackendDraft | null;
const locks = new Set<() => void>();
function makeConnection(overrides: Partial<Connection>): Connection {
  return {
    connectionId: "backend-one",
    providerId: "local-vault",
    connectionRef: "secret-backend://local-vault/one",
    logicalName: "local-vault/one",
    displayName: "Local vault",
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "",
    projectId: null,
    ownerKind: "person",
    shareability: "private",
    requestedScopes: [],
    grantedScopes: [],
    accountLabel: null,
    expiresAt: null,
    refreshable: false,
    lastRefreshedAt: null,
    maxInvokeLevel: 0,
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    bindings: [],
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}
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
function backend(): SecretBackend {
  return {
    id: "fixture",
    name: "Fixture",
    capabilities: {
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
      import: false,
    },
    authenticate: vi.fn(async () => ({
      id: "session",
      backendId: "fixture",
      authenticatedAt: "",
    })),
    listItems: vi.fn(async () => []),
    getItem: vi.fn<SecretBackend["getItem"]>(async () => ({
      id: "item",
      name: "Account",
      kind: "secret",
      secret: "stored-secret",
      notes: "Private notes",
    })),
    getNotes: vi.fn(async () => "Private notes"),
    disconnect: vi.fn(async () => undefined),
  };
}
let activeBackend: SecretBackend;
beforeEach(() => {
  stored = null;
  locks.clear();
  activeBackend = backend();
  vi.spyOn(vaultStore, "onLock").mockImplementation((handler) => {
    locks.add(handler);
    return () => locks.delete(handler);
  });
  vi.spyOn(dependencies, "listSecretBackendConnections").mockReturnValue([]);
  vi.spyOn(dependencies, "readSecretBackendConnection").mockImplementation(
    () => stored,
  );
  vi.spyOn(dependencies, "saveSecretBackendConnection").mockImplementation(
    async (draft) => {
      stored = { ...draft, token: "", clientSecret: "" };
      return makeConnection({
        connectionId: "backend-one",
        providerId: draft.providerId,
      });
    },
  );
  vi.spyOn(dependencies, "deleteSecretBackendConnection").mockResolvedValue(
    true,
  );
  vi.spyOn(dependencies, "probeSecretBackend").mockResolvedValue(undefined);
  vi.spyOn(dependencies, "connectSecretBackend").mockImplementation(
    async () => ({
      backend: activeBackend,
      session: { id: "session", backendId: "fixture", authenticatedAt: "" },
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function draw(id = "byo-secret-backend") {
  return render(
    <SecretBackendPanels
      key={id}
      provider={provider(id)}
      connection={null}
      online
      onFlash={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
}

it.each([
  "byo-secret-backend",
  "local-vault",
  "browser-credentials",
  "1password",
  "bitwarden",
  "vaultwarden",
  "bitwarden-sm",
  "infisical",
  "passwordstate",
  "proton-pass",
])("%s composes common configurable controls", (id) => {
  draw(id);
  expect(screen.getByLabelText("Connection name")).toBeTruthy();
  expect(screen.getByLabelText("Connection method")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Save secret backend" }),
  ).toBeTruthy();
  expect(screen.queryByText(/CLI required|No browser connection/)).toBeNull();
});

it("saves and reloads configuration without authenticating, then connects its saved snapshot", async () => {
  const user = userEvent.setup();
  draw("infisical");
  await user.type(
    screen.getByLabelText("API base URL"),
    "https://secrets.example.com",
  );
  await user.type(screen.getByLabelText("Access token"), "private-token");
  await user.click(screen.getByRole("button", { name: "Save secret backend" }));
  await screen.findByRole("button", { name: "Connect saved secret backend" });
  expect(dependencies.connectSecretBackend).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Access token")).toHaveProperty("value", "");
  await user.clear(screen.getByLabelText("API base URL"));
  await user.type(
    screen.getByLabelText("API base URL"),
    "https://draft.example.com",
  );
  await user.click(
    screen.getByRole("button", { name: "Reload secret backend" }),
  );
  expect(screen.getByLabelText("API base URL")).toHaveProperty(
    "value",
    "https://secrets.example.com",
  );
  await user.click(
    screen.getByRole("button", { name: "Connect saved secret backend" }),
  );
  await screen.findByRole("region", { name: "Secret backend items" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "List backend items" }),
  );
  expect(dependencies.connectSecretBackend).toHaveBeenCalledWith(
    "backend-one",
    "backend-one",
    expect.any(AbortSignal),
  );
});

it("tests current settings without saving or collecting a configured connection", async () => {
  const user = userEvent.setup();
  draw("passwordstate");
  await user.type(
    screen.getByLabelText("API base URL"),
    "https://passwords.example.com",
  );
  await user.click(screen.getByRole("button", { name: "Test secret backend" }));
  await screen.findByRole("img", {
    name: "Secret backend connection verified",
  });
  expect(dependencies.probeSecretBackend).toHaveBeenCalledWith(
    expect.objectContaining({ baseUrl: "https://passwords.example.com" }),
    undefined,
    expect.any(AbortSignal),
  );
  expect(dependencies.saveSecretBackendConnection).not.toHaveBeenCalled();
  expect(dependencies.connectSecretBackend).not.toHaveBeenCalled();
});

it("retains failed settings for retry and confirms removing saved configuration", async () => {
  vi.mocked(dependencies.saveSecretBackendConnection).mockRejectedValueOnce(
    new Error("Device storage refused the write"),
  );
  const user = userEvent.setup();
  draw();
  await user.clear(screen.getByLabelText("Connection name"));
  await user.type(screen.getByLabelText("Connection name"), "My vault");
  await user.click(screen.getByRole("button", { name: "Save secret backend" }));
  await screen.findByRole("img", { name: "Device storage refused the write" });
  expect(screen.getByLabelText("Connection name")).toHaveProperty(
    "value",
    "My vault",
  );
  await user.click(screen.getByRole("button", { name: "Save secret backend" }));
  await screen.findByRole("button", { name: "Connect saved secret backend" });
  await user.click(
    screen.getByRole("button", { name: "Remove secret backend" }),
  );
  expect(dependencies.deleteSecretBackendConnection).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Confirm remove secret backend" }),
  );
  await screen.findByRole("button", { name: "Connect secret backend" });
  expect(dependencies.deleteSecretBackendConnection).toHaveBeenCalledWith(
    "backend-one",
  );
});

it("keeps a file and its password transient and clears the authenticated view on vault lock", async () => {
  const user = userEvent.setup();
  draw("proton-pass");
  await user.selectOptions(
    screen.getByLabelText("Connection method"),
    "file-import",
  );
  const file = new File(['{"vaults":{}}'], "proton.json", {
    type: "application/json",
  });
  await user.upload(screen.getByLabelText("Export file"), file);
  await user.click(screen.getByText("Encrypted export"));
  await user.type(
    screen.getByLabelText("Export password"),
    "ephemeral-password",
  );
  await user.click(screen.getByRole("button", { name: "Save secret backend" }));
  await screen.findByRole("button", { name: "Connect saved secret backend" });
  expect(dependencies.saveSecretBackendConnection).toHaveBeenCalledWith(
    expect.not.objectContaining({ file, filePassword: "ephemeral-password" }),
    undefined,
  );
  await user.click(
    screen.getByRole("button", { name: "Connect saved secret backend" }),
  );
  await screen.findByRole("region", { name: "Secret backend items" });
  expect(dependencies.connectSecretBackend).toHaveBeenCalledWith(
    expect.objectContaining({
      file,
      filePassword: "ephemeral-password",
      mode: "file-import",
    }),
    "backend-one",
    expect.any(AbortSignal),
  );
  expect(screen.getByLabelText("Export password")).toHaveProperty("value", "");
  act(() => {
    for (const handler of locks) handler();
  });
  await screen.findByRole("button", { name: "Connect saved secret backend" });
  expect(
    screen.queryByRole("region", { name: "Secret backend items" }),
  ).toBeNull();
  expect(activeBackend.disconnect).toHaveBeenCalled();
  expect(screen.queryByLabelText("Selected file")).toBeNull();
});

it("rejects failed authentication without showing an active item workspace", async () => {
  vi.mocked(dependencies.connectSecretBackend).mockRejectedValueOnce(
    new Error("Credential refused by backend"),
  );
  const user = userEvent.setup();
  draw();
  await user.click(
    screen.getByRole("button", { name: "Connect secret backend" }),
  );
  await screen.findByRole("img", { name: "Credential refused by backend" });
  expect(
    screen.queryByRole("region", { name: "Secret backend items" }),
  ).toBeNull();
  expect(
    screen.queryByRole("img", { name: "Secret backend session connected" }),
  ).toBeNull();
});

it("closes a connection that finishes after vault lock instead of showing a stale session", async () => {
  let complete: (handle: {
    backend: SecretBackend;
    session: { id: string; backendId: string; authenticatedAt: string };
  }) => void = () => {
    throw new Error("Connect not started");
  };
  vi.mocked(dependencies.connectSecretBackend).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const user = userEvent.setup();
  draw();
  await user.click(
    screen.getByRole("button", { name: "Connect secret backend" }),
  );
  act(() => {
    for (const handler of locks) handler();
  });
  await act(async () =>
    complete({
      backend: activeBackend,
      session: { id: "late", backendId: "fixture", authenticatedAt: "" },
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Connect secret backend" }),
    ).toHaveProperty("disabled", false),
  );
  expect(activeBackend.disconnect).toHaveBeenCalledWith(
    expect.objectContaining({ id: "late" }),
  );
  expect(
    screen.queryByRole("region", { name: "Secret backend items" }),
  ).toBeNull();
  expect(
    screen.queryByRole("img", { name: "Secret backend session connected" }),
  ).toBeNull();
});

it("clears private credentials when the BYO connection method changes", async () => {
  const user = userEvent.setup();
  draw();
  await user.selectOptions(
    screen.getByLabelText("Connection method"),
    "infisical",
  );
  await user.type(
    screen.getByLabelText("Access token"),
    "infisical-only-token",
  );
  await user.selectOptions(
    screen.getByLabelText("Connection method"),
    "onepassword-connect",
  );
  expect(screen.getByLabelText("Access token")).toHaveProperty("value", "");
});

it("does not retain another provider's unsaved settings after switching partners", async () => {
  const user = userEvent.setup();
  const view = draw("infisical");
  await user.type(screen.getByLabelText("Access token"), "unsaved-token");
  view.rerender(
    <SecretBackendPanels
      key="passwordstate"
      provider={provider("passwordstate")}
      connection={null}
      online
      onFlash={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Connection name")).toHaveProperty(
    "value",
    secretBackendDraft("passwordstate").name,
  );
});
