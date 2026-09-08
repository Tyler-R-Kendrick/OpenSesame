import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import type { TrustResolution } from "../interactions/trust.js";
import {
  emailClaimMayJoinAccounts,
  emailLinkFields,
} from "../services/email-authority.js";
describe("emailClaimMayJoinAccounts", () => {
  const ctx = (verifiedDomainOwner?: string) =>
    overlapCast<AppContext>({
      stores: {
        orgFederation: {
          emailDomains: {
            findVerified: async (domain: string) =>
              verifiedDomainOwner && domain === "acme.example"
                ? { organizationId: verifiedDomainOwner, domain }
                : null,
          },
        },
      },
    });

  const staticTrust = (emailAuthoritative?: boolean) =>
    overlapCast<TrustResolution>({
      source: "static",
      provider: {
        id: "p",
        kind: "oidc",
        label: "P",
        issuer: "https://idp.example",
        scopes: "openid email",
        clientAuth: "none",
        ...(emailAuthoritative !== undefined
          ? { emailAuthoritative }
          : undefined),
      },
    });

  it("never lets a visitor-registered issuer join an existing account", async () => {
    // The takeover this fence exists for: stand up an OIDC server, register it
    // through the BYO form with no account at all, and mint an id_token
    // claiming the victim's address is verified. The tuple still admits the
    // attacker — as a NEW principal, which is the whole of what BYO may do.
    const trust = overlapCast<TrustResolution>({
      source: "byo",
      record: {
        id: "byo_1",
        issuer: "https://idp.attacker.example",
        state: "active",
        registrationSource: "dcr",
      },
    });
    expect(
      await emailClaimMayJoinAccounts(ctx(), trust, "victim@corp.example"),
    ).toBe(false);
  });

  it("lets a provider the operator vouched for join", async () => {
    expect(
      await emailClaimMayJoinAccounts(
        ctx(),
        staticTrust(true),
        "someone@example.test",
      ),
    ).toBe(true);
  });

  it("refuses a configured provider nobody vouched for", async () => {
    // Off by default. An operator adding a provider is saying "people may sign
    // in with this", not "this checks the addresses it reports".
    expect(
      await emailClaimMayJoinAccounts(
        ctx(),
        staticTrust(),
        "someone@example.test",
      ),
    ).toBe(false);
    expect(
      await emailClaimMayJoinAccounts(
        ctx(),
        staticTrust(false),
        "someone@example.test",
      ),
    ).toBe(false);
  });

  it("lets an organization speak only for a domain it proved", async () => {
    const trust = overlapCast<TrustResolution>({
      source: "org",
      organizationId: "org_acme",
      issuer: "https://sso.acme.example",
      method: "sso",
    });
    expect(
      await emailClaimMayJoinAccounts(
        ctx("org_acme"),
        trust,
        "person@acme.example",
      ),
    ).toBe(true);
    // The owner runs the IdP, so nothing stops them asserting this address —
    // except that they never proved they run gmail.com.
    expect(
      await emailClaimMayJoinAccounts(
        ctx("org_acme"),
        trust,
        "victim@gmail.com",
      ),
    ).toBe(false);
    // Nor may one tenant borrow another tenant's proof.
    expect(
      await emailClaimMayJoinAccounts(
        ctx("org_other"),
        trust,
        "person@acme.example",
      ),
    ).toBe(false);
  });

  it("drops the verification claim rather than storing it unhonoured", async () => {
    // Storing an unhonoured `true` would leave a row that a later, genuinely
    // verified sign-in attaches itself to — the same takeover with the steps
    // reversed. The address is still recorded.
    const trust = overlapCast<TrustResolution>({
      source: "byo",
      record: { id: "byo_1", issuer: "https://idp.attacker.example" },
    });
    expect(
      await emailLinkFields(ctx(), trust, "Victim@Corp.Example", true),
    ).toEqual({ emailNormalized: "victim@corp.example" });
  });

  it("normalizes and reports a claim it does honour", async () => {
    expect(
      await emailLinkFields(
        ctx(),
        staticTrust(true),
        " Ada@Example.Test ",
        true,
      ),
    ).toEqual({ emailNormalized: "ada@example.test", emailVerified: true });
  });

  it("reports nothing when the upstream named no address", async () => {
    expect(
      await emailLinkFields(ctx(), staticTrust(true), undefined, true),
    ).toEqual({});
  });
});
