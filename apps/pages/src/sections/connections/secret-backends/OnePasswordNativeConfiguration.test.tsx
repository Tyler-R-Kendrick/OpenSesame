/** @vitest-environment jsdom */
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import * as factory from "@opensesame/app-core/lib/secret-backends/factory.js";
import * as loader from "@opensesame/app-core/lib/secret-backends/onepassword-sdk-loader.js";
import { secretBackendDraft } from "@opensesame/app-core/lib/secret-backends/presets.js";
import {
  publicSecretBackendDraft,
  validateSecretBackendDraft,
} from "@opensesame/app-core/lib/secret-backends/schema.js";
import type { SecretBackendDraft } from "@opensesame/app-core/lib/secret-backends/types.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecretBackendPanels } from "./SecretBackendPanels.js";
import { secretBackendDependencies as dependencies } from "./secret-backend-dependencies.js";

let stored: SecretBackendDraft | null;
const provider: Provider = {
  id: "1password",
  displayName: "1Password",
  category: "developer",
  authKind: "configuration",
  configured: false,
  docsUrl: "https://www.1password.dev/sdks",
  supportsRefresh: false,
  autoConfigurable: false,
  missingConfig: [],
  callbackUrl: null,
  scopes: [],
  egress: { scheme: "https", authorities: [], pathPrefixes: [] },
  operations: [],
};
function connection(): Connection {
  return {
    connectionId: "saved-native",
    providerId: "1password",
    connectionRef: "secret-backend://1password/fixture",
    logicalName: "1password/fixture",
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
function draw(id = "1password") {
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
function displayed(
  mode: SecretBackendDraft["mode"] = "onepassword-sdk",
): SecretBackendDraft {
  return {
    ...secretBackendDraft("1password"),
    mode,
    baseUrl: "https://account.1password.invalid",
    vaultId: "native-vault",
  };
}
async function fillNative(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    screen.getByLabelText("1Password account URL"),
    "https://account.1password.invalid",
  );
  await user.type(
    screen.getByLabelText("Service account token"),
    "native-ui-private-fixture",
  );
  await user.type(screen.getByLabelText("Vault ID"), "native-vault");
}
function nativeFields() {
  const form = screen.getByRole("region", {
    name: "Secret backend configuration",
  });
  return within(form)
    .getAllByRole("textbox")
    .map((input) => input.getAttribute("id"));
}
beforeEach(() => {
  stored = null;
  vi.spyOn(vaultStore, "onLock").mockImplementation(() => () => {});
  vi.spyOn(dependencies, "listSecretBackendConnections").mockReturnValue([]);
  vi.spyOn(dependencies, "readSecretBackendConnection").mockImplementation(
    () => stored,
  );
  vi.spyOn(dependencies, "saveSecretBackendConnection").mockImplementation(
    async (draft) => {
      stored = publicSecretBackendDraft(validateSecretBackendDraft(draft));
      return connection();
    },
  );
  vi.spyOn(dependencies, "probeSecretBackend").mockRejectedValue(
    new Error("Native authentication denied"),
  );
  vi.spyOn(dependencies, "connectSecretBackend").mockRejectedValue(
    new Error("Native authentication denied"),
  );
  vi.spyOn(factory, "createSecretBackend");
  vi.spyOn(loader, "createBrowserOnePasswordClient");
  vi.spyOn(loader, "onePasswordBrowserAssets");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(["1password", "byo-secret-backend"])(
  "composes real shared native fields for %s",
  async (id) => {
    const user = userEvent.setup();
    draw(id);
    if (id === "byo-secret-backend")
      await user.selectOptions(
        screen.getByLabelText("Connection method"),
        "onepassword-sdk",
      );
    expect(screen.getByLabelText("Connection method")).toHaveProperty(
      "value",
      "onepassword-sdk",
    );
    expect(
      screen.getByRole("option", { name: "1Password native SDK" }),
    ).toHaveProperty("value", "onepassword-sdk");
    expect(screen.getByLabelText("1Password account URL")).toHaveProperty(
      "placeholder",
      "https://team.1password.com",
    );
    expect(screen.getByLabelText("Service account token")).toHaveProperty(
      "type",
      "password",
    );
    expect(screen.getByLabelText("Service account token")).toHaveProperty(
      "autocomplete",
      "new-password",
    );
    expect(screen.getByLabelText("Vault ID")).toHaveProperty("value", "");
    expect(nativeFields()).toHaveLength(3);
    expect(screen.queryByLabelText("API base URL")).toBeNull();
    expect(factory.createSecretBackend).not.toHaveBeenCalled();
    expect(loader.createBrowserOnePasswordClient).not.toHaveBeenCalled();
  },
);

it("saves native metadata through the shared form without invoking the SDK and blanks the displayed token", async () => {
  const user = userEvent.setup();
  const view = draw();
  await fillNative(user);
  await user.click(screen.getByRole("button", { name: "Save secret backend" }));
  await screen.findByRole("button", { name: "Connect saved secret backend" });
  expect(dependencies.saveSecretBackendConnection).toHaveBeenCalledWith(
    expect.objectContaining({
      providerId: "1password",
      mode: "onepassword-sdk",
      baseUrl: "https://account.1password.invalid",
      vaultId: "native-vault",
      token: "native-ui-private-fixture",
    }),
    undefined,
  );
  expect(screen.getByLabelText("Service account token")).toHaveProperty(
    "value",
    "",
  );
  expect(stored?.token).toBe("");
  expect(view.onChanged).toHaveBeenCalledOnce();
  expect(dependencies.probeSecretBackend).not.toHaveBeenCalled();
  expect(dependencies.connectSecretBackend).not.toHaveBeenCalled();
  expect(factory.createSecretBackend).not.toHaveBeenCalled();
  expect(loader.createBrowserOnePasswordClient).not.toHaveBeenCalled();
  expect(loader.onePasswordBrowserAssets).not.toHaveBeenCalled();
});

it("clears native credentials when switching to Connect and back", async () => {
  const user = userEvent.setup();
  draw();
  await fillNative(user);
  await user.selectOptions(
    screen.getByLabelText("Connection method"),
    "onepassword-connect",
  );
  expect(screen.getByLabelText("Access token")).toHaveProperty("value", "");
  await user.type(
    screen.getByLabelText("Access token"),
    "connect-only-fixture",
  );
  await user.selectOptions(
    screen.getByLabelText("Connection method"),
    "onepassword-sdk",
  );
  expect(screen.getByLabelText("Service account token")).toHaveProperty(
    "value",
    "",
  );
  expect(loader.createBrowserOnePasswordClient).not.toHaveBeenCalled();
});

it.each(["onepassword-sdk", "onepassword-connect", "file-import"] as const)(
  "opens a saved %s record without changing its method or allocating SDK state",
  (mode) => {
    stored = displayed(mode);
    draw();
    expect(screen.getByLabelText("Connection method")).toHaveProperty(
      "value",
      mode,
    );
    if (mode === "onepassword-sdk")
      expect(screen.getByLabelText("Service account token")).toHaveProperty(
        "value",
        "",
      );
    if (mode === "onepassword-connect")
      expect(screen.getByLabelText("Access token")).toHaveProperty("value", "");
    if (mode === "file-import")
      expect(screen.getByLabelText("Export format")).toHaveProperty(
        "value",
        "1password-1pux",
      );
    expect(loader.createBrowserOnePasswordClient).not.toHaveBeenCalled();
    expect(loader.onePasswordBrowserAssets).not.toHaveBeenCalled();
  },
);

// These rejected boundary requests verify native configuration dispatch, not provider authentication.
it.each(["Test", "Connect"])(
  "dispatches explicit native %s with its caller signal and keeps denied authentication out of the workspace",
  async (action) => {
    const user = userEvent.setup();
    const view = draw();
    await fillNative(user);
    await user.click(
      screen.getByRole("button", {
        name:
          action === "Test" ? "Test secret backend" : "Connect secret backend",
      }),
    );
    await waitFor(() =>
      expect(view.onFlash).toHaveBeenCalledWith({
        tone: "err",
        text: "Native authentication denied",
      }),
    );
    const calls =
      action === "Test"
        ? vi.mocked(dependencies.probeSecretBackend).mock.calls
        : vi.mocked(dependencies.connectSecretBackend).mock.calls;
    expect(calls[0]?.[0]).toEqual(
      expect.objectContaining({
        providerId: "1password",
        mode: "onepassword-sdk",
        token: "native-ui-private-fixture",
        baseUrl: "https://account.1password.invalid",
        vaultId: "native-vault",
      }),
    );
    expect(calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.[2]?.aborted).toBe(true);
    expect(
      screen.queryByRole("region", { name: "Secret backend items" }),
    ).toBeNull();
    expect(
      screen.queryByRole("img", { name: "Secret backend connection verified" }),
    ).toBeNull();
    expect(
      screen.queryByRole("img", { name: "Secret backend session connected" }),
    ).toBeNull();
    expect(view.onChanged).not.toHaveBeenCalled();
  },
);
