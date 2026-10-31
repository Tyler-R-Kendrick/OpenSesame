/** @vitest-environment jsdom */
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { identityConnectionDraft } from "@opensesame/app-core/lib/identity-connections-presets.js";
import type { IdentityConnectionDraft } from "@opensesame/app-core/lib/identity-connections-schema.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IdentityConnectionPanels,
  identityConnectionDependencies as dependencies,
} from "./IdentityConnectionPanels.js";

function provider(id = "better-auth"): Provider {
  return {
    id,
    displayName: id,
    category: "identity",
    authKind: "configuration",
    configured: false,
    docsUrl: "https://example.com/docs",
    supportsRefresh: false,
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    operations: [],
  };
}

function connection(id = "better-auth"): Connection {
  return {
    connectionId: `idc_${id}`,
    connectionRef: `identity://${id}/test`,
    logicalName: `${id}/test`,
    displayName: id,
    providerId: id,
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
  };
}

let stored: IdentityConnectionDraft | null;
let configuredService: string;
let onChanged = vi.fn<() => void>();

beforeEach(() => {
  stored = null;
  configuredService = "";
  vi.spyOn(dependencies, "readSignInService").mockImplementation(
    () => configuredService,
  );
  vi.spyOn(dependencies, "writeSignInService").mockImplementation((address) => {
    configuredService = address;
  });
  vi.spyOn(dependencies, "beginSignIn").mockResolvedValue(undefined);
  vi.spyOn(dependencies, "brokeredRealmUpstream").mockImplementation(() => ({
    id: "broker:realm",
    issuer: configuredService,
    displayName: "your organization",
    accountKind: "your work account",
  }));
  onChanged = vi.fn<() => void>();
  vi.spyOn(dependencies, "listIdentityConnections").mockReturnValue([]);
  vi.spyOn(dependencies, "readIdentityConnection").mockImplementation(
    () => stored,
  );
  vi.spyOn(dependencies, "readInitialIdentityDraft").mockImplementation(
    (providerId, existingId) =>
      (existingId && stored) || identityConnectionDraft(providerId),
  );
  vi.spyOn(dependencies, "saveIdentityConnection").mockImplementation(
    async (draft) => {
      stored = { ...draft, clientSecret: "", ldapBindPassword: "" };
      return connection(draft.providerId);
    },
  );
  vi.spyOn(dependencies, "testIdentityConnection").mockResolvedValue({
    message: "Provider verified",
  });
  vi.spyOn(dependencies, "beginIdentityConnectionSignIn").mockResolvedValue(
    undefined,
  );
  vi.spyOn(dependencies, "removeIdentityConnection").mockResolvedValue(
    undefined,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function draw(id = "better-auth") {
  return render(
    <IdentityConnectionPanels
      key={id}
      provider={provider(id)}
      connection={null}
      online
      onFlash={vi.fn()}
      onChanged={onChanged}
    />,
  );
}

describe("composed identity configuration", () => {
  it.each([
    "better-auth",
    "byo-identity",
    "supabase",
    "neon-auth",
    "clerk",
    "auth0",
    "workos",
    "okta",
  ])("%s uses the common configuration controls", (id) => {
    draw(id);
    expect(screen.getByLabelText("Connection name")).toBeTruthy();
    expect(screen.getByLabelText("Protocol")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save identity connection" }),
    ).toBeTruthy();
    expect(screen.queryByText("Why not")).toBeNull();
  });

  it("saves a native provider, reloads its settings, and signs in with transient credentials", async () => {
    const user = userEvent.setup();
    draw();
    await user.type(
      screen.getByLabelText("Auth API base URL"),
      "https://auth.example.com/api/auth",
    );
    await user.click(
      screen.getByRole("button", { name: "Save identity connection" }),
    );
    await screen.findByRole("button", { name: "Sign in to Better Auth" });
    expect(dependencies.saveIdentityConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "better-auth",
        baseUrl: "https://auth.example.com/api/auth",
      }),
      undefined,
    );
    expect(onChanged).toHaveBeenCalledOnce();
    await user.type(
      screen.getByLabelText("Email address"),
      "person@example.com",
    );
    await user.type(screen.getByLabelText("Password"), "passphrase");
    await user.click(
      screen.getByRole("button", { name: "Sign in to Better Auth" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Password")).toHaveProperty("value", ""),
    );
    expect(dependencies.beginIdentityConnectionSignIn).toHaveBeenCalledWith(
      "idc_better-auth",
      { credentials: { email: "person@example.com", password: "passphrase" } },
    );
    await user.clear(screen.getByLabelText("Auth API base URL"));
    await user.type(
      screen.getByLabelText("Auth API base URL"),
      "https://draft.example.com",
    );
    await user.click(
      screen.getByRole("button", { name: "Reload identity connection" }),
    );
    expect(screen.getByLabelText("Auth API base URL")).toHaveProperty(
      "value",
      "https://auth.example.com/api/auth",
    );
  });

  it("retains a failed save draft and permits retry", async () => {
    const user = userEvent.setup();
    vi.mocked(dependencies.saveIdentityConnection).mockRejectedValueOnce(
      new Error("Provider refused configuration"),
    );
    draw();
    await user.type(
      screen.getByLabelText("Auth API base URL"),
      "https://auth.example.com/api/auth",
    );
    await user.click(
      screen.getByRole("button", { name: "Save identity connection" }),
    );
    await screen.findByRole("img", { name: "Provider refused configuration" });
    expect(screen.getByLabelText("Auth API base URL")).toHaveProperty(
      "value",
      "https://auth.example.com/api/auth",
    );
    await user.click(
      screen.getByRole("button", { name: "Save identity connection" }),
    );
    await screen.findByRole("button", { name: "Sign in to Better Auth" });
  });

  it("tests the current draft without saving or announcing a connection", async () => {
    const user = userEvent.setup();
    draw("clerk");
    await user.type(
      screen.getByLabelText("Issuer URL"),
      "https://clerk.example.com",
    );
    await user.click(
      screen.getByRole("button", { name: "Test identity connection" }),
    );
    await screen.findByRole("img", { name: "Provider verified" });
    expect(dependencies.testIdentityConnection).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: "https://clerk.example.com" }),
      undefined,
    );
    expect(dependencies.saveIdentityConnection).not.toHaveBeenCalled();
  });

  it("composes native SAML and retains the LDAP organization service controls", async () => {
    const user = userEvent.setup();
    draw("byo-identity");
    await user.selectOptions(screen.getByLabelText("Protocol"), "saml");
    expect(screen.getByLabelText("SAML metadata URL")).toBeTruthy();
    expect(screen.queryByLabelText("Identity service URL")).toBeNull();
    expect(screen.queryByLabelText("Organization")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Protocol"), "ldap");
    expect(screen.getByLabelText("Identity service URL")).toBeTruthy();
    expect(screen.getByLabelText("Organization")).toBeTruthy();
    expect(screen.getByLabelText("LDAP server URL")).toBeTruthy();
    await user.click(screen.getByText("Directory options"));
    expect(screen.getByLabelText("Service bind password")).toHaveProperty(
      "type",
      "password",
    );
    await user.selectOptions(
      screen.getByLabelText("Bind mode"),
      "search_then_bind",
    );
    await user.click(
      screen.getByRole("button", { name: "Save identity connection" }),
    );
    await waitFor(() =>
      expect(dependencies.saveIdentityConnection).toHaveBeenCalledWith(
        expect.objectContaining({ ldapBindMode: "search_then_bind" }),
        undefined,
      ),
    );
  });

  it("does not leak unsaved fields when switching provider pages", async () => {
    const user = userEvent.setup();
    const view = draw();
    await user.type(
      screen.getByLabelText("Auth API base URL"),
      "https://draft.example.com",
    );
    view.rerender(
      <IdentityConnectionPanels
        key="supabase"
        provider={provider("supabase")}
        connection={null}
        online
        onFlash={vi.fn()}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByLabelText("Project URL")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Connection name")).toHaveProperty(
      "value",
      "Supabase Auth",
    );
  });

  it("requires a second action to remove a saved configuration", async () => {
    const user = userEvent.setup();
    stored = identityConnectionDraft("better-auth");
    vi.mocked(dependencies.listIdentityConnections).mockReturnValue([
      connection(),
    ]);
    draw();
    await user.click(
      screen.getByRole("button", { name: "Remove identity connection" }),
    );
    expect(dependencies.removeIdentityConnection).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Keep identity connection" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Remove identity connection" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Confirm remove identity connection",
      }),
    );
    await waitFor(() =>
      expect(dependencies.removeIdentityConnection).toHaveBeenCalledWith(
        "idc_better-auth",
      ),
    );
  });
});

it("connects the service before starting owner sign-in and returns to the same provider page", async () => {
  const user = userEvent.setup();
  window.history.replaceState(
    null,
    "",
    "/settings/connections/byo-identity?view=configuration#connector",
  );
  draw("byo-identity");
  await user.selectOptions(screen.getByLabelText("Protocol"), "ldap");
  await user.click(screen.getByText("Directory options"));
  await user.type(
    screen.getByLabelText("Service bind password"),
    "unsaved-directory-bind-secret",
  );
  await user.type(
    screen.getByLabelText("Identity service URL"),
    "https://identity.example.com/",
  );
  await user.click(
    screen.getByRole("button", { name: "Connect sign-in service" }),
  );
  await screen.findByRole("img", { name: "Sign-in service configured" });
  expect(dependencies.writeSignInService).toHaveBeenCalledWith(
    "https://identity.example.com",
  );
  await user.click(
    screen.getByRole("button", { name: "Sign in to organization service" }),
  );
  await waitFor(() =>
    expect(dependencies.beginSignIn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "broker:realm",
        issuer: "https://identity.example.com",
      }),
      {
        prompt: "login",
        returnTo:
          "/settings/connections/byo-identity?view=configuration#connector",
      },
    ),
  );
  expect(dependencies.saveIdentityConnection).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Service bind password")).toHaveProperty(
    "value",
    "unsaved-directory-bind-secret",
  );
});

it("does not authenticate to a different unsaved service endpoint", async () => {
  const user = userEvent.setup();
  configuredService = "https://current.example.com";
  draw("byo-identity");
  await user.selectOptions(screen.getByLabelText("Protocol"), "ldap");
  await user.clear(screen.getByLabelText("Identity service URL"));
  await user.type(
    screen.getByLabelText("Identity service URL"),
    "https://other.example.com",
  );
  await user.click(
    screen.getByRole("button", { name: "Sign in to organization service" }),
  );
  await screen.findByRole("img", {
    name: "Connect this sign-in service before signing in to it.",
  });
  expect(dependencies.beginSignIn).not.toHaveBeenCalled();
  expect(dependencies.writeSignInService).not.toHaveBeenCalled();
});
