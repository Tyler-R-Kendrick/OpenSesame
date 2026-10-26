/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://pwa.example.test/OpenSesame/"} */
import { forgetAtRestKeyForTest } from "@opensesame/app-core/lib/at-rest/key.js";
import { SETTINGS_PERSIST_KEY } from "@opensesame/app-core/lib/capability-connector-scope.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { readNativeFederationSession } from "@opensesame/app-core/lib/federation-native-session.js";
import { readFederationSessionJson } from "@opensesame/app-core/lib/federation-session-store.js";
import {
  listIdentityConnections,
  readIdentityConnection,
} from "@opensesame/app-core/lib/identity-connections.js";
import {
  kvFlush,
  kvForgetAll,
  kvHydrate,
} from "@opensesame/app-core/lib/kv.js";
import { signInMethods } from "@opensesame/app-core/lib/settings.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  NativeOidcPeeringGate,
  NativeOidcPeeringWrapper,
} from "../../../modules/networking.tailnet/NativeOidcPeering.js";
import { startConfiguredIdentity } from "../../../screens/unlock/ConfiguredIdentityStage.js";
import { native, popup } from "./IdentityConnectionOidc.test-support.js";
import { IdentityConnectionPanels } from "./IdentityConnectionPanels.js";

afterEach(cleanup);
const provider: Provider = {
  id: "byo-identity",
  displayName: "Bring your own identity",
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
function field(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
async function configure(f: Awaited<ReturnType<typeof native>>) {
  render(
    <NativeOidcPeeringWrapper>
      <IdentityConnectionPanels
        provider={provider}
        connection={null}
        online
        onFlash={vi.fn()}
        onChanged={vi.fn()}
      />
    </NativeOidcPeeringWrapper>,
  );
  const user = userEvent.setup();
  await user.selectOptions(
    screen.getByLabelText("OIDC client type"),
    "confidential",
  );
  field("Connection name", f.draft.name);
  field("Issuer URL", f.draft.issuer);
  field("Client ID", f.draft.clientId);
  field("Client secret (server client)", f.draft.clientSecret);
  field("Organization ID (optional)", f.draft.organizationId);
  expect(screen.queryByLabelText("Identity service URL")).toBeNull();
  expect(screen.getByLabelText("Signed organization claim")).toHaveProperty(
    "value",
    "org_id",
  );
  expect(
    screen.getByLabelText("Organization authorization parameter"),
  ).toHaveProperty("value", "organization");
  expect(screen.getByLabelText("Redirect URI to register")).toHaveProperty(
    "value",
    "https://pwa.example.test/OpenSesame/auth/native-connector.html",
  );
  return user;
}
async function approve(
  f: Awaited<ReturnType<typeof native>>,
  user: ReturnType<typeof userEvent.setup>,
) {
  const dialog = await screen.findByRole("dialog", {
    name: "Connect identity browser node",
  });
  expect(within(dialog).getByText("https://control.example.test")).toBeTruthy();
  expect(within(dialog).getByText("ephemeral-original")).toBeTruthy();
  await user.click(
    within(dialog).getByRole("button", { name: "Sign in to Tailscale" }),
  );
  const link = within(dialog).getByRole("link", {
    name: "Continue signing in with Tailscale",
  });
  expect(link).toHaveProperty(
    "href",
    "https://control.example.test/register/original",
  );
  expect(link).toHaveProperty("target", "_blank");
  expect(link).toHaveProperty("rel", "noreferrer noopener");
  expect(
    within(dialog).getByRole("img", { name: /Approve this browser node/ }),
  ).toBeTruthy();
  f.approve();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}
it("shared BYO Test/Save and cold unlock consume genuine native OIDC evidence with explicit original-node enrollment", async () => {
  const f = await native();
  const user = await configure(f);
  await user.click(
    screen.getByRole("button", { name: "Test identity connection" }),
  );
  await approve(f, user);
  await screen.findByRole("img", { name: /Sign in to verify/ });
  expect(listIdentityConnections()).toEqual([]);
  expect(readNativeFederationSession()).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Save identity connection" }),
  );
  await approve(f, user);
  await waitFor(() => expect(listIdentityConnections()).toHaveLength(1));
  const saved = listIdentityConnections()[0];
  if (!saved) throw new Error("Missing saved native OIDC configuration");
  expect(readIdentityConnection(saved.connectionId)?.clientSecret).toBe("");
  expect(JSON.stringify([...f.storage.files.values()])).not.toContain(
    f.draft.clientSecret,
  );
  const idp = signInMethods().providers.find(
    (entry) => entry.connectionId === saved.connectionId,
  );
  if (!idp) throw new Error("Missing original public identity projection");
  expect(idp).toMatchObject({ protocol: "oidc", nativeIdentity: true });
  cleanup();
  await kvFlush();
  kvForgetAll();
  forgetAtRestKeyForTest();
  await kvHydrate([SETTINGS_PERSIST_KEY]);
  expect(readIdentityConnection(saved.connectionId)).toBeNull();
  const browser = popup(f.idp);
  const before = vaultStore.getSnapshot();
  let pending: Promise<void> | undefined;
  render(
    <>
      <button
        type="button"
        onClick={() =>
          startConfiguredIdentity(idp, {
            open: vi.fn(),
            legacy: vi.fn(),
            fail: vi.fn(),
            start: (run) => {
              pending = run();
            },
          })
        }
      >
        Use saved SSO
      </button>
      <NativeOidcPeeringGate />
    </>,
  );
  await user.click(screen.getByRole("button", { name: "Use saved SSO" }));
  expect(browser.open).toHaveBeenCalledOnce();
  expect(browser.locations).toEqual([]);
  await approve(f, user);
  await pending;
  expect(readNativeFederationSession()).toMatchObject({
    assertionFormat: "native-oidc",
    pairwiseSub: "owned-person",
    issuer: f.draft.issuer,
    idToken: "",
    jwksUri: "",
  });
  expect(vaultStore.getSnapshot()).toBe(before);
  expect(f.captures()).toBe(3);
  expect(f.retired()).toBe(3);
  expect(readFederationSessionJson()).toBeNull();
  expect(browser.locations).toHaveLength(1);
  expect(
    new URL(browser.locations[0] ?? "").searchParams.get("organization"),
  ).toBe("org_actual");
  await waitFor(() => expect(browser.acknowledgements()).toBe(1));
  expect(browser.errors).toEqual([]);
  expect(f.idp.errors).toEqual([]);
  expect(f.browserFetch).not.toHaveBeenCalled();
});
it("closing the real enrollment sheet retires its original node and publishes no configuration", async () => {
  const f = await native();
  const user = await configure(f);
  await user.click(
    screen.getByRole("button", { name: "Save identity connection" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Connect identity browser node",
  });
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await screen.findAllByRole("img", { name: /cancelled/ });
  expect(listIdentityConnections()).toEqual([]);
  expect(signInMethods().providers).toEqual([]);
  expect(readNativeFederationSession()).toBeNull();
  expect(f.retired()).toBe(1);
  expect(f.idp.requests).toEqual([]);
  expect(f.browserFetch).not.toHaveBeenCalled();
});
it("switching a confidential client to public clears its secret and preserves the existing public callback", async () => {
  const f = await native();
  const user = await configure(f);
  field("Organization ID (optional)", "");
  await user.selectOptions(screen.getByLabelText("OIDC client type"), "public");
  expect(screen.queryByLabelText("Client secret (server client)")).toBeNull();
  expect(screen.getByLabelText("Public client ID")).toHaveProperty(
    "value",
    f.draft.clientId,
  );
  expect(screen.getByLabelText("Redirect URI to register")).not.toHaveProperty(
    "value",
    "https://pwa.example.test/OpenSesame/auth/native-connector.html",
  );
  await user.selectOptions(
    screen.getByLabelText("OIDC client type"),
    "confidential",
  );
  expect(screen.getByLabelText("Client secret (server client)")).toHaveProperty(
    "value",
    "",
  );
  expect(f.captures()).toBe(0);
  expect(f.browserFetch).not.toHaveBeenCalled();
});

it("rendered native custom endpoints and Basic authentication round-trip through Test, Save and cold sign-in without discovery", async () => {
  const f = await native();
  const user = await configure(f);
  await user.click(
    screen.getByText("Sign-in options", { selector: "summary" }),
  );
  await user.selectOptions(screen.getByLabelText("Connection route"), "native");
  const endpoints = {
    "Authorization endpoint (optional)": `${f.idp.tokenBase}/authorize`,
    "Token endpoint (optional)": `${f.idp.tokenBase}/token`,
    "JWKS URI (optional)": `${f.idp.jwksBase}/jwks`,
  };
  for (const [label, value] of Object.entries(endpoints)) field(label, value);
  await user.selectOptions(
    screen.getByLabelText("Token endpoint authentication"),
    "client_secret_basic",
  );
  await user.click(
    screen.getByRole("button", { name: "Test identity connection" }),
  );
  await approve(f, user);
  await screen.findByRole("img", { name: /Sign in to verify/ });
  expect(f.idp.requests.map((row) => row.path)).toEqual(["/issuer/jwks"]);
  expect(listIdentityConnections()).toEqual([]);
  await user.click(
    screen.getByRole("button", { name: "Save identity connection" }),
  );
  await approve(f, user);
  await screen.findByRole("img", { name: "Identity configuration saved" });
  const saved = listIdentityConnections()[0];
  if (!saved) throw new Error("Missing saved custom endpoint configuration");
  expect(readIdentityConnection(saved.connectionId)).toMatchObject({
    oidcTransport: "native",
    oidcAuthorizationEndpoint: endpoints["Authorization endpoint (optional)"],
    oidcTokenEndpoint: endpoints["Token endpoint (optional)"],
    jwksUri: endpoints["JWKS URI (optional)"],
    oidcTokenAuthentication: "client_secret_basic",
    clientSecret: "",
  });
  for (const label of Object.keys(endpoints))
    field(label, "https://discarded.example.invalid/endpoint");
  await user.selectOptions(screen.getByLabelText("Connection route"), "auto");
  await user.selectOptions(
    screen.getByLabelText("Token endpoint authentication"),
    "client_secret_post",
  );
  await user.click(
    screen.getByRole("button", { name: "Reload identity configuration" }),
  );
  for (const [label, value] of Object.entries(endpoints))
    expect(screen.getByLabelText(label)).toHaveProperty("value", value);
  expect(screen.getByLabelText("Connection route")).toHaveProperty(
    "value",
    "native",
  );
  expect(screen.getByLabelText("Token endpoint authentication")).toHaveProperty(
    "value",
    "client_secret_basic",
  );
  expect(screen.getByLabelText("Client secret (server client)")).toHaveProperty(
    "value",
    "",
  );
  expect(JSON.stringify([...f.storage.files.values()])).not.toContain(
    f.draft.clientSecret,
  );
  const idp = signInMethods().providers.find(
    (entry) => entry.connectionId === saved.connectionId,
  );
  if (!idp) throw new Error("Missing saved custom endpoint projection");
  cleanup();
  await kvFlush();
  kvForgetAll();
  forgetAtRestKeyForTest();
  await kvHydrate([SETTINGS_PERSIST_KEY]);
  expect(readIdentityConnection(saved.connectionId)).toBeNull();
  const browser = popup(f.idp);
  let pending: Promise<void> | undefined;
  render(
    <>
      <button
        type="button"
        onClick={() =>
          startConfiguredIdentity(idp, {
            open: vi.fn(),
            legacy: vi.fn(),
            fail: vi.fn(),
            start: (run) => {
              pending = run();
            },
          })
        }
      >
        Use custom SSO
      </button>
      <NativeOidcPeeringGate />
    </>,
  );
  await user.click(screen.getByRole("button", { name: "Use custom SSO" }));
  expect(browser.locations).toEqual([]);
  await approve(f, user);
  await pending;
  expect(readNativeFederationSession()).toMatchObject({
    assertionFormat: "native-oidc",
    pairwiseSub: "owned-person",
    issuer: f.draft.issuer,
    idToken: "",
  });
  expect(f.idp.requests.map((row) => row.path)).toEqual([
    "/issuer/jwks",
    "/issuer/jwks",
    "/issuer/jwks",
    "/issuer/token",
    "/issuer/jwks",
  ]);
  expect(f.idp.requests.map((row) => row.host)).toEqual(
    Array(5).fill(new URL(f.idp.tokenBase).host),
  );
  expect(browser.locations).toHaveLength(1);
  const authorization = new URL(browser.locations[0] ?? "");
  expect(authorization.origin + authorization.pathname).toBe(
    endpoints["Authorization endpoint (optional)"],
  );
  expect(authorization.searchParams.get("organization")).toBe("org_actual");
  await waitFor(() => expect(browser.acknowledgements()).toBe(1));
  expect(f.captures()).toBe(3);
  expect(f.retired()).toBe(3);
  expect(f.idp.errors).toEqual([]);
  expect(browser.errors).toEqual([]);
  expect(f.browserFetch).not.toHaveBeenCalled();
  expect(readFederationSessionJson()).toBeNull();
});
