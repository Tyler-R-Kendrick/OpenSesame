/** @vitest-environment jsdom */
/**
 * Identity › Organizations' sign-in panels (ADR 0140 plan step 12), ported
 * from `apps/console/src/pages/OrgSignInPage.test.tsx`: drawn only with an
 * Identity API and a session, an owner's upstream, domains and tokens, a
 * member told so without a call, and every refusal a glyph on its panel.
 * The minted token's own tests are in `OrgSignInTokens.test.tsx`.
 */
import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { registerTutorialRealm } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { OrgSignInPanels } from "./OrgSignInPanels.js";
import { ACME, orgSignInServer } from "./org-signin-server.test-support.js";

const originalIdentity = { ...identitySeams };
const originalDevice = { ...deviceIdentitySeams };
const SESSION = {
  principalId: "prn_1",
  accessToken: "at",
  issuerOrigin: "https://id.example",
};

let server = orgSignInServer();

function install(next = orgSignInServer()) {
  server = next;
  identitySeams.identityFetch = server.fetch;
  return server;
}

function panel(name: string) {
  return within(screen.getByRole("region", { name: new RegExp(`^${name}`) }));
}

async function owner() {
  render(<OrgSignInPanels online known={[]} />);
  await screen.findByRole("region", { name: "Email domains" });
}

// The upstream panel is a guide target `enterprise.directory-provisioning`
// declares on activation.
let revokeRealm = () => {};
beforeAll(() => {
  revokeRealm = registerTutorialRealm();
});
afterAll(() => revokeRealm());

beforeEach(() => {
  deviceIdentitySeams.remoteIdentityApi = () => "https://id.example";
  identitySeams.currentSession = () => SESSION;
  identitySeams.identityBase = () => "https://id.example";
  install();
});

afterEach(() => {
  cleanup();
  Object.assign(identitySeams, originalIdentity);
  Object.assign(deviceIdentitySeams, originalDevice);
});

describe("gating (ADR 0090)", () => {
  it("draws nothing and asks nothing without an Identity API", async () => {
    deviceIdentitySeams.remoteIdentityApi = () => "";
    const { container } = render(<OrgSignInPanels online known={[]} />);
    await Promise.resolve();
    expect(container.textContent).toBe("");
    expect(server.seen).toEqual([]);
  });

  it("draws nothing and asks nothing without a session", async () => {
    identitySeams.currentSession = () => null;
    const { container } = render(<OrgSignInPanels online known={[]} />);
    await Promise.resolve();
    expect(container.textContent).toBe("");
    expect(server.seen).toEqual([]);
  });

  it("waits for the section's own list before asking, then asks once", async () => {
    const view = render(<OrgSignInPanels online known={null} />);
    await Promise.resolve();
    expect(server.seen).toEqual([]);
    view.rerender(<OrgSignInPanels online known={[ACME]} />);
    await screen.findByRole("region", { name: "Email domains" });
    expect(
      server.seen.filter((call) => call.path === "/v1/organizations"),
    ).toHaveLength(1);
  });

  it("draws nothing when the session owns no organization", async () => {
    install(orgSignInServer({ organizations: [] }));
    const { container } = render(<OrgSignInPanels online known={[]} />);
    await waitFor(() => expect(server.seen).toHaveLength(1));
    expect(container.textContent).toBe("");
  });

  it("tells a member only an owner can change it, and asks nothing more", async () => {
    install(orgSignInServer({ organizations: [{ ...ACME, role: "member" }] }));
    render(<OrgSignInPanels online known={[]} />);
    expect(
      await screen.findByRole("img", {
        name: "Only an owner of Acme can change its sign-in",
      }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("OIDC issuer")).toBeNull();
    expect(server.seen.map((call) => call.path)).toEqual(["/v1/organizations"]);
  });

  it("marks a refused organization list on the panel, never a banner", async () => {
    identitySeams.identityFetch = async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    render(<OrgSignInPanels online known={[]} />);
    expect(
      await screen.findByRole("img", { name: /Sign in again as an owner/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the upstream", () => {
  it("shows the one redirect URI a provider must be given", async () => {
    await owner();
    const field = screen.getByLabelText<HTMLInputElement>("Redirect URI");
    expect(field.value).toBe("https://id.example/v1/federated/callback");
    expect(field.readOnly).toBe(true);
  });

  it("saves the upstream, leaving a stored secret alone when the box is empty", async () => {
    await owner();
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("SAML metadata URL"),
      "https://idp.acme.example/saml/metadata",
    );
    await user.click(
      screen.getByRole("button", { name: "Save the sign-in upstream" }),
    );
    await panel("Sign-in upstream").findByRole("img", {
      name: "Organization sign-in saved.",
    });
    const patch = server.seen.find((call) => call.method === "PATCH");
    expect(JSON.parse(String(patch?.body))).toEqual({
      ssoIssuer: "https://idp.acme.example",
      ssoClientId: null,
      samlIssuer: null,
      samlMetadataUrl: "https://idp.acme.example/saml/metadata",
    });
  });

  it("sends the client credentials a tenant registered, then clears the secret box", async () => {
    await owner();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Client ID"), "acme-client-id");
    const secret = screen.getByLabelText<HTMLInputElement>("Client secret");
    await user.type(secret, "acme-client-secret");
    await user.click(
      screen.getByRole("button", { name: "Save the sign-in upstream" }),
    );
    await screen.findByRole("img", { name: "A client secret is stored" });
    const patch = server.seen.find((call) => call.method === "PATCH");
    expect(JSON.parse(String(patch?.body))).toMatchObject({
      ssoClientId: "acme-client-id",
      ssoClientSecret: "acme-client-secret",
    });
    expect(secret.value).toBe("");
  });
});

describe("email domains", () => {
  it("shows the TXT record to publish, then verifies the domain", async () => {
    await owner();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Add a domain"), "acme.example");
    await user.click(screen.getByRole("button", { name: "Claim this domain" }));
    const domains = panel("Email domains");
    expect(
      await domains.findByText("opensesame-domain-verify=tok_1"),
    ).toBeTruthy();
    expect(
      domains.getByRole("img", { name: "Publish the TXT record, then verify" }),
    ).toBeTruthy();
    await user.click(
      domains.getByRole("button", { name: "Verify acme.example" }),
    );
    expect(
      await domains.findByRole("img", { name: "acme.example is verified." }),
    ).toBeTruthy();
    expect(domains.getByRole("img", { name: "Verified" })).toBeTruthy();
  });

  it("marks a domain another organization already holds", async () => {
    install(orgSignInServer({ taken: ["acme.example"] }));
    await owner();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Add a domain"), "acme.example");
    await user.click(screen.getByRole("button", { name: "Claim this domain" }));
    expect(
      await panel("Email domains").findByRole("img", {
        name: "That domain is already claimed by another organization.",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("arms a release before it sends one, and keeps the domain on Keep", async () => {
    install(
      orgSignInServer({
        domains: [
          { domain: "acme.example", txtRecord: "t", verifiedAt: "2026-09-01" },
        ],
      }),
    );
    await owner();
    const user = userEvent.setup();
    const domains = panel("Email domains");
    await user.click(
      await domains.findByRole("button", { name: "Release acme.example" }),
    );
    expect(server.seen.some((call) => call.method === "DELETE")).toBe(false);
    await user.click(
      domains.getByRole("button", { name: "Keep acme.example" }),
    );
    expect(domains.getByText("acme.example")).toBeTruthy();

    await user.click(
      domains.getByRole("button", { name: "Release acme.example" }),
    );
    await user.click(
      domains.getByRole("button", { name: "Confirm releasing acme.example" }),
    );
    expect(
      await domains.findByRole("img", { name: "acme.example released." }),
    ).toBeTruthy();
    expect(domains.queryByText("acme.example")).toBeNull();
    expect(server.domains()).toEqual([]);
  });
});
