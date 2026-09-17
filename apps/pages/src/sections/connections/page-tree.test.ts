import { describe, expect, it } from "vitest";
import type { Provider } from "../../lib/connections.js";
import { getBundledProviders } from "../../lib/embedded-catalog.js";
import { pageTreeLeaves } from "../../lib/page-to-tree.js";
import { catalogPageSections, connectionsPageTree } from "./page-tree.js";

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
    expect(groups.map((group) => group.label)).toEqual([
      "Password managers",
      "Developer tools",
    ]);
    expect(groups[0]?.items?.map((item) => item.label)).toEqual(["Mid Pass"]);
    expect(groups[1]?.items?.map((item) => item.label)).toEqual([
      "Zulu Cloud",
      "Alpha Cloud",
    ]);
  });

  it("leads with identity, backup/recovery, encryption, password managers, then agent harnesses", () => {
    const groups = catalogPageSections([
      provider("zulu", "Zulu Cloud", "developer"),
      provider("auth0", "Auth0", "identity"),
      provider("github", "GitHub", "backup_recovery"),
      provider("age", "age", "encryption"),
      provider("bitwarden", "Bitwarden", "password_managers"),
      provider("openai", "OpenAI", "agent_harnesses"),
      provider("tailscale", "Tailscale", "networking"),
      provider("google-wallet", "Google Wallet", "wallet"),
      provider("apple-wallet", "Apple Wallet", "wallet"),
      provider("samsung-wallet", "Samsung Wallet", "wallet"),
      provider("cloudflare-wallet", "Cloudflare Wallet", "wallet"),
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "Managed",
      "Identity",
      "Encryption (secrets in git)",
      "Password managers",
      "Agent harnesses",
      "Networking",
      "Wallet",
      "Developer tools",
    ]);
    expect(
      groups
        .find((group) => group.id === "managed")
        ?.items?.map((item) => item.id),
    ).toEqual(["github"]);
    expect(groups.map((group) => group.label)).not.toContain("Payments");
    expect(
      groups
        .find((group) => group.id === "networking")
        ?.items?.map((item) => item.id),
    ).toEqual(["tailscale"]);
    expect(
      groups
        .find((group) => group.id === "wallet")
        ?.items?.map((item) => item.id),
    ).toEqual([
      "google-wallet",
      "apple-wallet",
      "samsung-wallet",
      "cloudflare-wallet",
    ]);
    expect(
      groups.flatMap((group) => group.items ?? []).map((item) => item.id),
    ).not.toContain("stripe");
  });

  it("groups the bundled catalog under the new leading sections", () => {
    const groups = catalogPageSections(getBundledProviders());
    expect(groups.map((group) => group.label).slice(0, 6)).toEqual([
      "Managed",
      "Identity",
      "Backup/recovery",
      "Encryption (secrets in git)",
      "Password managers",
      "Agent harnesses",
    ]);
    expect(groups.map((group) => group.label)).not.toContain("Payments");
    expect(
      groups
        .find((group) => group.id === "networking")
        ?.items?.map((item) => item.id),
    ).toContain("tailscale");
    expect(
      groups
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
      groups.flatMap((group) => group.items ?? []).map((item) => item.id),
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
