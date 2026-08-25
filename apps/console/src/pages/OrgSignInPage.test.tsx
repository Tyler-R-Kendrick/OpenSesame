import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgSignInPage } from "./OrgSignInPage.js";

overlapCast(globalThis).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = { status?: number; body?: BoundaryValue };

let container: HTMLDivElement;
let root: Root | null = null;
let routes: Map<string, Reply>;
let seen: Array<{ method: string; path: string; body?: string }>;

function key(method: string, path: string): string {
  return `${method} ${path}`;
}

/** What the Identity API answers for one request; the latest wins. */
function reply(method: string, path: string, value: Reply): void {
  routes.set(key(method, path), value);
}

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init: RequestInit = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      const path = new URL(String(input)).pathname;
      seen.push({
        method,
        path,
        ...(init.body ? { body: String(init.body) } : undefined),
      });
      const next = routes.get(key(method, path));
      if (!next) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
        );
      }
      const status = next.status ?? 200;
      // 204 is exactly what the revoke route answers, and it carries no body.
      if (status === 204) {
        return Promise.resolve(new Response(null, { status }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(next.body ?? {}), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
}

async function render(): Promise<void> {
  const previous = root;
  if (previous) {
    await act(async () => {
      previous.unmount();
    });
    container.remove();
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(<OrgSignInPage />);
  });
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  if (!button) throw new Error(`button "${text}" not rendered`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

function typeInto(id: string, value: string): void {
  const field = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!field) throw new Error(`field "${id}" not rendered`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

const OWNER_ORG = {
  id: "org_1",
  slug: "acme",
  displayName: "Acme",
  role: "owner",
  ssoIssuer: "https://idp.acme.example",
};

function seedOwnerOrg(): void {
  reply("GET", "/v1/organizations", {
    body: { organizations: [OWNER_ORG] },
  });
  reply("GET", "/v1/organizations/org_1/domains", { body: { domains: [] } });
  reply("GET", "/v1/organizations/org_1/scim/tokens", { body: { tokens: [] } });
}

beforeEach(() => {
  root = null;
  routes = new Map();
  seen = [];
  installFetch();
});

afterEach(async () => {
  const current = root;
  if (current) {
    await act(async () => {
      current.unmount();
    });
  }
  container.remove();
  vi.unstubAllGlobals();
});

describe("OrgSignInPage", () => {
  it("says what to do when this session owns no organization", async () => {
    reply("GET", "/v1/organizations", { body: { organizations: [] } });
    await render();
    expect(container.textContent).toContain("No organizations on this session");
  });

  it("refuses to offer settings to a member who is not an owner", async () => {
    reply("GET", "/v1/organizations", {
      body: {
        organizations: [{ ...OWNER_ORG, role: "member" }],
      },
    });
    await render();
    expect(container.textContent).toContain("Only an owner of Acme");
    expect(container.querySelector("#sso-issuer")).toBeNull();
  });

  it("saves the organization's upstream configuration", async () => {
    seedOwnerOrg();
    reply("PATCH", "/v1/organizations/org_1", { body: { id: "org_1" } });
    await render();
    typeInto("saml-metadata", "https://idp.acme.example/saml/metadata");
    await click("Save upstream");
    const patch = seen.find((call) => call.method === "PATCH");
    expect(JSON.parse(String(patch?.body))).toEqual({
      ssoIssuer: "https://idp.acme.example",
      samlIssuer: null,
      samlMetadataUrl: "https://idp.acme.example/saml/metadata",
    });
    expect(container.textContent).toContain("Organization sign-in saved.");
  });

  it("shows the TXT record to publish, then verifies the domain", async () => {
    seedOwnerOrg();
    reply("POST", "/v1/organizations/org_1/domains", {
      status: 201,
      body: {
        domain: "acme.example",
        txtRecord: "opensesame-domain-verify=tok_1",
        verifiedAt: null,
      },
    });
    reply("POST", "/v1/organizations/org_1/domains/acme.example/verify", {
      body: {
        domain: "acme.example",
        txtRecord: "opensesame-domain-verify=tok_1",
        verifiedAt: "2026-08-25T00:00:00.000Z",
      },
    });
    await render();
    typeInto("new-domain", "acme.example");
    await click("Claim domain");
    expect(container.textContent).toContain("opensesame-domain-verify=tok_1");
    await click("Verify acme.example");
    expect(container.textContent).toContain("acme.example is verified.");
  });

  it("surfaces a domain another organization already holds", async () => {
    seedOwnerOrg();
    reply("POST", "/v1/organizations/org_1/domains", {
      status: 409,
      body: {
        error: "domain_taken",
        message: "That domain is already claimed by another organization.",
      },
    });
    await render();
    typeInto("new-domain", "acme.example");
    await click("Claim domain");
    expect(container.querySelector(".err")?.textContent).toContain(
      "already claimed by another organization",
    );
  });

  it("shows a minted provisioning token exactly once", async () => {
    seedOwnerOrg();
    reply("POST", "/v1/organizations/org_1/scim/tokens", {
      status: 201,
      body: { id: "sct_id_1", token: "sct_plaintext_value" },
    });
    await render();
    await click("Mint provisioning token");
    expect(container.textContent).toContain("sct_plaintext_value");
    expect(container.textContent).toContain("it is not shown again");

    await click("I have copied it");
    expect(container.textContent).not.toContain("sct_plaintext_value");

    // Nothing this page can do brings it back: the list endpoint carries ids
    // and timestamps only, and there is no second read of the plaintext.
    reply("GET", "/v1/organizations/org_1/scim/tokens", {
      body: {
        tokens: [
          {
            id: "sct_id_1",
            createdAt: "2026-08-25T00:00:00.000Z",
            revokedAt: null,
          },
        ],
      },
    });
    await render();
    expect(container.textContent).toContain("sct_id_1");
    expect(container.textContent).not.toContain("sct_plaintext_value");
    // And it was never written anywhere a later tab could read it.
    expect(sessionStorage.getItem("sct_id_1")).toBeNull();
    expect(document.location.search).not.toContain("sct_");
  });

  it("revokes a provisioning token", async () => {
    reply("GET", "/v1/organizations", { body: { organizations: [OWNER_ORG] } });
    reply("GET", "/v1/organizations/org_1/domains", { body: { domains: [] } });
    reply("GET", "/v1/organizations/org_1/scim/tokens", {
      body: {
        tokens: [
          {
            id: "sct_id_1",
            createdAt: "2026-08-25T00:00:00.000Z",
            revokedAt: null,
          },
        ],
      },
    });
    reply("DELETE", "/v1/organizations/org_1/scim/tokens/sct_id_1", {
      status: 204,
    });
    await render();
    await click("Revoke sct_id_1");
    expect(container.textContent).toContain("Provisioning token revoked.");
    expect(container.textContent).not.toContain("Revoke sct_id_1");
  });
});
