/** @vitest-environment jsdom */
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { secretBackendDraft } from "@opensesame/app-core/lib/secret-backends/presets.js";
import { publicSecretBackendDraft } from "@opensesame/app-core/lib/secret-backends/schema.js";
import type { SecretBackendDraft } from "@opensesame/app-core/lib/secret-backends/types.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecretBackendPanels } from "./SecretBackendPanels.js";
import { secretBackendDependencies as dependencies } from "./secret-backend-dependencies.js";

const provider: Provider = {
  id: "bitwarden",
  displayName: "Bitwarden",
  category: "developer",
  authKind: "configuration",
  configured: false,
  docsUrl: "https://bitwarden.com/help/bitwarden-apis/",
  supportsRefresh: false,
  autoConfigurable: false,
  missingConfig: [],
  callbackUrl: null,
  scopes: [],
  egress: { scheme: "https", authorities: [], pathPrefixes: [] },
  operations: [],
};
let stored: SecretBackendDraft | null;
let lock: () => void;
function connection(): Connection {
  return {
    connectionId: "saved-native",
    providerId: "bitwarden",
    connectionRef: "secret-backend://bitwarden/fixture",
    logicalName: "bitwarden/fixture",
    displayName: "Saved native",
    integrationId: null,
    status: "pending",
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
  };
}
function draw(id = "bitwarden") {
  const onFlash = vi.fn();
  const onChanged = vi.fn();
  return {
    ...render(
      <SecretBackendPanels
        provider={{ ...provider, id }}
        connection={stored ? connection() : null}
        online
        onFlash={onFlash}
        onChanged={onChanged}
      />,
    ),
    onFlash,
    onChanged,
  };
}
function displayed(): SecretBackendDraft {
  return {
    ...secretBackendDraft("bitwarden"),
    baseUrl: "https://api.owned.example",
    identityUrl: "https://identity.owned.example",
    accountEmail: "owned@example.test",
    clientId: "user.00000000-0000-4000-8000-000000000001",
    deviceIdentifier: "00000000-0000-4000-8000-000000000002",
  };
}
beforeEach(() => {
  stored = null;
  lock = () => {};
  vi.spyOn(vaultStore, "onLock").mockImplementation((callback) => {
    lock = callback;
    return () => {};
  });
  vi.spyOn(dependencies, "listSecretBackendConnections").mockReturnValue([]);
  vi.spyOn(dependencies, "readSecretBackendConnection").mockImplementation(
    () => stored,
  );
  vi.spyOn(dependencies, "saveSecretBackendConnection").mockImplementation(
    async (draft) => {
      stored = publicSecretBackendDraft(draft);
      return connection();
    },
  );
  vi.spyOn(dependencies, "probeSecretBackend").mockRejectedValue(
    new Error("Native authentication denied"),
  );
  vi.spyOn(dependencies, "connectSecretBackend").mockRejectedValue(
    new Error("Native authentication denied"),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("drops an unrelated organization target when BYO switches from Secrets Manager to a personal account", async () => {
  const user = userEvent.setup();
  draw("byo-secret-backend");
  await user.selectOptions(
    screen.getByLabelText("Connection method"),
    "bitwarden-secrets",
  );
  await user.type(
    screen.getByLabelText("Organization ID"),
    "previous-machine-organization",
  );
  await user.selectOptions(
    screen.getByLabelText("Connection method"),
    "bitwarden-api",
  );
  await user.type(
    screen.getByLabelText("Master password (this connection only)"),
    "one-attempt-password",
  );
  await user.click(screen.getByRole("button", { name: "Test secret backend" }));
  await waitFor(() =>
    expect(dependencies.probeSecretBackend).toHaveBeenCalledOnce(),
  );
  expect(
    vi.mocked(dependencies.probeSecretBackend).mock.calls[0]?.[0],
  ).toMatchObject({ organizationId: "", mode: "bitwarden-api" });
});
it.each(["bitwarden", "vaultwarden", "byo-secret-backend"])(
  "composes identical personal-account fields and an ephemeral concealed unlock control for %s",
  async (id) => {
    const user = userEvent.setup();
    draw(id);
    if (id === "byo-secret-backend")
      await user.selectOptions(
        screen.getByLabelText("Connection method"),
        "bitwarden-api",
      );
    for (const label of [
      "API base URL",
      "Identity API URL",
      "Account email",
      "Personal API client ID",
      "Personal API client secret",
      "Device identifier",
      "Personal folder ID (optional)",
    ])
      expect(screen.getByLabelText(label)).toBeTruthy();
    expect(screen.getByLabelText("Personal API client secret")).toHaveProperty(
      "type",
      "password",
    );
    expect(
      screen.getByLabelText("Master password (this connection only)"),
    ).toHaveProperty("type", "password");
    expect(
      screen.getByLabelText("Master password (this connection only)"),
    ).toHaveProperty("autocomplete", "off");
    expect(screen.getByLabelText("Device identifier")).toHaveProperty(
      "value",
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    expect(dependencies.probeSecretBackend).not.toHaveBeenCalled();
    expect(dependencies.connectSecretBackend).not.toHaveBeenCalled();
  },
);
it("saves shared native metadata without the master password, blanks the API secret, and retains the connection-specific device identifier", async () => {
  stored = displayed();
  const user = userEvent.setup();
  const view = draw();
  const device = screen
    .getByLabelText("Device identifier")
    .getAttribute("value");
  await user.type(
    screen.getByLabelText("Personal API client secret"),
    "owned-api-secret",
  );
  await user.type(
    screen.getByLabelText("Master password (this connection only)"),
    "never-save-this-password",
  );
  await user.click(screen.getByRole("button", { name: "Save secret backend" }));
  await waitFor(() => expect(view.onChanged).toHaveBeenCalledOnce());
  expect(dependencies.saveSecretBackendConnection).toHaveBeenCalledWith(
    expect.objectContaining({
      clientSecret: "owned-api-secret",
      accountEmail: "owned@example.test",
      deviceIdentifier: device,
    }),
    "saved-native",
  );
  expect(
    vi.mocked(dependencies.saveSecretBackendConnection).mock.calls[0]?.[0],
  ).not.toHaveProperty("masterPassword");
  expect(
    screen.getByLabelText("Master password (this connection only)"),
  ).toHaveProperty("value", "");
  expect(screen.getByLabelText("Personal API client secret")).toHaveProperty(
    "value",
    "",
  );
  expect(screen.getByLabelText("Device identifier")).toHaveProperty(
    "value",
    device,
  );
  expect(stored).not.toHaveProperty("masterPassword");
});
// These rejected boundary actions prove configuration dispatch, never successful provider authentication.
it.each(["Test", "Connect"])(
  "passes the supplied master password when explicitly using a saved native %s and clears denied input",
  async (action) => {
    stored = displayed();
    const user = userEvent.setup();
    const view = draw();
    await user.type(
      screen.getByLabelText("Master password (this connection only)"),
      "one-attempt-password",
    );
    await user.click(
      screen.getByRole("button", {
        name:
          action === "Test"
            ? "Test secret backend"
            : "Connect saved secret backend",
      }),
    );
    await waitFor(() =>
      expect(view.onFlash).toHaveBeenCalledWith({
        tone: "err",
        text: "Native authentication denied",
      }),
    );
    const call =
      action === "Test"
        ? vi.mocked(dependencies.probeSecretBackend).mock.calls[0]
        : vi.mocked(dependencies.connectSecretBackend).mock.calls[0];
    expect(call?.[0]).toMatchObject({
      mode: "bitwarden-api",
      accountEmail: "owned@example.test",
      masterPassword: "one-attempt-password",
      deviceIdentifier: stored.deviceIdentifier,
    });
    expect(call?.[1]).toBe("saved-native");
    expect(call?.[2]).toBeInstanceOf(AbortSignal);
    expect(
      screen.getByLabelText("Master password (this connection only)"),
    ).toHaveProperty("value", "");
    expect(
      screen.queryByRole("region", { name: "Secret backend items" }),
    ).toBeNull();
    expect(
      screen.queryByRole("img", { name: "Secret backend connection verified" }),
    ).toBeNull();
  },
);
it("clears temporary unlock input on target edit, reload, method change, and vault lock", async () => {
  stored = displayed();
  const user = userEvent.setup();
  draw();
  const password = () =>
    screen.getByLabelText("Master password (this connection only)");
  await user.type(password(), "target-bound");
  await user.type(screen.getByLabelText("Account email"), "x");
  expect(password()).toHaveProperty("value", "");
  await user.type(password(), "reload-bound");
  await user.click(
    screen.getByRole("button", { name: "Reload secret backend" }),
  );
  expect(password()).toHaveProperty("value", "");
  await user.type(password(), "lock-bound");
  act(() => lock());
  expect(password()).toHaveProperty("value", "");
  await user.type(password(), "method-bound");
  await user.selectOptions(
    screen.getByLabelText("Connection method"),
    "file-import",
  );
  await user.selectOptions(
    screen.getByLabelText("Connection method"),
    "bitwarden-api",
  );
  expect(password()).toHaveProperty("value", "");
});
