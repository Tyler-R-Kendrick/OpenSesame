import { describe, expect, it } from "vitest";
import type { Provider } from "../../lib/connections.js";
import { getBundledProviders } from "../../lib/embedded-catalog.js";
import { pageTreeLeaves } from "../../lib/page-to-tree.js";
import {
  catalogPageSections,
  connectionsPageTree,
  featureBindingSections,
} from "./page-tree.js";

const template = getBundledProviders()[0];
if (!template) throw new Error("Bundled catalog must not be empty");

function provider(
  id: string,
  displayName: string,
  category: Provider["category"],
): Provider {
  return { ...template, id, displayName, category, autoConfigurable: false };
}

describe("connections page tree", () => {
  it("keeps catalog source order under page subheaders, not alphabetical", () => {
    const groups = catalogPageSections([
      provider("zulu", "Zulu Cloud", "developer"),
      provider("alpha", "Alpha Cloud", "developer"),
      provider("mid", "Mid Pass", "password_managers"),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["Developer tools"]);
    expect(groups[0]?.items?.map((item) => item.label)).toEqual([
      "Zulu Cloud",
      "Alpha Cloud",
    ]);
    const bindings = featureBindingSections([
      provider("mid", "Mid Pass", "password_managers"),
    ]);
    expect(bindings.map((group) => group.label)).toEqual(["Password managers"]);
    expect(bindings[0]?.items?.map((item) => item.label)).toEqual(["Mid Pass"]);
    expect(bindings[0]?.items?.map((item) => item.href)).toEqual([
      "/settings/connections/mid",
    ]);
  });

  it("ships wallet issuers in the bundled catalog", () => {
    const ids = getBundledProviders()
      .filter((provider) => provider.category === "wallet")
      .map((provider) => provider.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "privacy",
        "lithic",
        "marqeta",
        "stripe-issuing",
        "google-wallet",
      ]),
    );
  });

  it("leads with identity, backup/recovery, encryption, password managers, then agent harnesses", () => {
    const groups = catalogPageSections([
      provider("zulu", "Zulu Cloud", "developer"),
      provider("auth0", "Auth0", "identity"),
      provider("github", "GitHub", "backup_recovery"),
      provider("aws-kms", "AWS KMS", "encryption"),
      provider("age", "age", "encryption"),
      provider("bitwarden", "Bitwarden", "password_managers"),
      provider("openai", "OpenAI", "agent_harnesses"),
      provider("tailscale", "Tailscale", "networking"),
      provider("linear", "Linear", "productivity"),
      provider("google-wallet", "Google Wallet", "wallet"),
      provider("apple-wallet", "Apple Wallet", "wallet"),
      provider("samsung-wallet", "Samsung Wallet", "wallet"),
      provider("cloudflare-wallet", "Cloudflare Wallet", "wallet"),
    ]);
    const bindings = featureBindingSections([
      provider("zulu", "Zulu Cloud", "developer"),
      provider("auth0", "Auth0", "identity"),
      provider("github", "GitHub", "backup_recovery"),
      provider("aws-kms", "AWS KMS", "encryption"),
      provider("age", "age", "encryption"),
      provider("bitwarden", "Bitwarden", "password_managers"),
      provider("openai", "OpenAI", "agent_harnesses"),
      provider("tailscale", "Tailscale", "networking"),
      provider("linear", "Linear", "productivity"),
      provider("google-wallet", "Google Wallet", "wallet"),
      provider("apple-wallet", "Apple Wallet", "wallet"),
      provider("samsung-wallet", "Samsung Wallet", "wallet"),
      provider("cloudflare-wallet", "Cloudflare Wallet", "wallet"),
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "Managed",
      "Developer tools",
    ]);
    expect(bindings.map((group) => group.label)).toEqual([
      "Identity",
      "Backup/recovery",
      "Encryption (secrets in git)",
      "Password managers",
      "Agent harnesses",
      "Networking",
      "Wallet",
    ]);
    // age is a Settings key SOP — never a Connections catalog row.
    expect(
      bindings
        .find((group) => group.id === "encryption")
        ?.items?.map((item) => item.id),
    ).toEqual(["aws-kms"]);
    expect(
      groups
        .find((group) => group.id === "managed")
        ?.items?.map((item) => item.id),
    ).toEqual(["linear"]);
    expect(groups.map((group) => group.label)).not.toContain("Payments");
    expect(bindings.map((group) => group.label)).not.toContain("Payments");
    expect(
      bindings
        .find((group) => group.id === "networking")
        ?.items?.map((item) => item.id),
    ).toEqual(["tailscale"]);
    expect(
      bindings
        .find((group) => group.id === "wallet")
        ?.items?.map((item) => item.id),
    ).toEqual([
      "google-wallet",
      "apple-wallet",
      "samsung-wallet",
      "cloudflare-wallet",
    ]);
    expect(
      [...groups, ...bindings]
        .flatMap((group) => group.items ?? [])
        .map((item) => item.id),
    ).not.toContain("stripe");
    expect(
      groups.flatMap((group) => group.items ?? []).map((item) => item.id),
    ).not.toContain("github");
  });

  it("groups the bundled catalog under the new leading sections", () => {
    const groups = catalogPageSections(getBundledProviders());
    const bindings = featureBindingSections(getBundledProviders());
    expect(bindings.map((group) => group.label).slice(0, 5)).toEqual([
      "Identity",
      "Backup/recovery",
      "Encryption (secrets in git)",
      "Password managers",
      "Agent harnesses",
    ]);
    expect(groups.map((group) => group.label)).not.toContain("Identity");
    expect(groups.map((group) => group.label)).not.toContain("Backup/recovery");
    expect(groups.map((group) => group.label)).toContain("Managed");
    expect(groups.map((group) => group.label)).not.toContain("Payments");
    expect(
      bindings
        .find((group) => group.id === "networking")
        ?.items?.map((item) => item.id),
    ).toContain("tailscale");
    expect(
      bindings
        .find((group) => group.id === "wallet")
        ?.items?.map((item) => item.id),
    ).toEqual(
      expect.arrayContaining([
        "cloudflare-wallet",
        "google-wallet",
        "apple-wallet",
        "samsung-wallet",
      ]),
    );
    expect(
      [...groups, ...bindings]
        .flatMap((group) => group.items ?? [])
        .map((item) => item.id),
    ).not.toContain("stripe");
  });

  it("puts Needs attention and Connected before catalog groups", () => {
    const tree = connectionsPageTree(
      [provider("zulu", "Zulu Cloud", "developer")],
      [],
    );
    expect(tree.map((node) => node.label)).toEqual([
      "Connected",
      "Add a connection",
    ]);
    expect(pageTreeLeaves(tree).map((node) => node.label)).toEqual([
      "Zulu Cloud",
    ]);
  });
});
