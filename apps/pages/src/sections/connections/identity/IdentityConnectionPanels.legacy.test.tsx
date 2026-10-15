/** @vitest-environment jsdom */
import { configureHost } from "@opensesame/app-core/host.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import {
  listIdentityConnections,
  readIdentityConnection,
} from "@opensesame/app-core/lib/identity-connections.js";
import { kvForgetAll, kvSeams } from "@opensesame/app-core/lib/kv.js";
import {
  type OperatorIdp,
  loadSettings,
  saveSettingsDurable,
  signInMethods,
} from "@opensesame/app-core/lib/settings.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IdentityConnectionPanels } from "./IdentityConnectionPanels.js";

const legacy: OperatorIdp = {
  providerId: "auth0",
  label: "Company Auth0",
  issuer: "https://company.auth0.com",
  clientId: "existing-spa",
  scope: "openid email profile",
};
const unrelated: OperatorIdp = {
  providerId: "workos",
  label: "Partner WorkOS",
  issuer: "https://partner.example.com",
  clientId: "partner-spa",
};
const disk = new Map<string, string>();

beforeEach(async () => {
  disk.clear();
  kvForgetAll();
  configureHost(createTestHost());
  vi.spyOn(kvSeams, "kvGet").mockImplementation((key) => disk.get(key) ?? null);
  vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(async (key, value) => {
    disk.set(key, value);
  });
  await saveSettingsDurable({
    ...loadSettings(),
    signIn: { builtin: true, providers: [legacy, unrelated] },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        issuer: legacy.issuer,
        authorization_endpoint: `${legacy.issuer}/authorize`,
        token_endpoint: `${legacy.issuer}/token`,
        jwks_uri: `${legacy.issuer}/jwks`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  kvForgetAll();
  configureHost(createTestHost());
});

function drawLegacyAuth0() {
  const provider = getBundledProviders().find((row) => row.id === "auth0");
  if (!provider) throw new Error("Auth0 is not bundled");
  render(
    <IdentityConnectionPanels
      provider={provider}
      connection={null}
      online
      onFlash={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
}

it("edits existing Auth0 settings and migrates their trust only after a successful save", async () => {
  const user = userEvent.setup();
  drawLegacyAuth0();
  expect(screen.getByLabelText("Connection name")).toHaveProperty(
    "value",
    legacy.label,
  );
  expect(screen.getByLabelText("Issuer URL")).toHaveProperty(
    "value",
    legacy.issuer,
  );
  expect(screen.getByLabelText("Public client ID")).toHaveProperty(
    "value",
    legacy.clientId,
  );
  expect(signInMethods().providers).toEqual([legacy, unrelated]);
  expect(listIdentityConnections()).toEqual([]);
  await user.clear(screen.getByLabelText("Public client ID"));
  await user.type(screen.getByLabelText("Public client ID"), "updated-spa");
  expect(signInMethods().providers).toEqual([legacy, unrelated]);
  await user.click(
    screen.getByRole("button", { name: "Save identity connection" }),
  );
  await screen.findByRole("button", { name: "Sign in to Company Auth0" });
  const saved = listIdentityConnections()[0];
  if (!saved) throw new Error("Auth0 connection was not saved");
  expect(readIdentityConnection(saved.connectionId)).toMatchObject({
    name: legacy.label,
    issuer: legacy.issuer,
    clientId: "updated-spa",
    scope: legacy.scope,
  });
  expect(signInMethods().providers).toEqual([
    unrelated,
    expect.objectContaining({
      providerId: "auth0",
      connectionId: saved.connectionId,
      issuer: legacy.issuer,
      clientId: "updated-spa",
    }),
  ]);
});

it("retains working legacy Auth0 trust when discovery rejects the edited settings", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("Refused", { status: 403 })),
  );
  const user = userEvent.setup();
  drawLegacyAuth0();
  await user.clear(screen.getByLabelText("Public client ID"));
  await user.type(screen.getByLabelText("Public client ID"), "updated-spa");
  await user.click(
    screen.getByRole("button", { name: "Save identity connection" }),
  );
  await screen.findByRole("img", { name: "OIDC discovery was refused (403)" });
  expect(signInMethods().providers).toEqual([legacy, unrelated]);
  expect(listIdentityConnections()).toEqual([]);
  expect(screen.getByLabelText("Public client ID")).toHaveProperty(
    "value",
    "updated-spa",
  );
});
