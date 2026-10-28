import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { describe, expect, it } from "vitest";
import { pageTreeLeaves } from "../../lib/page-to-tree.js";
import {
  catalogPageItems,
  connectionsPageTree,
  featureBindingSections,
} from "./page-tree.js";

const providers = mergeVercelCatalog(getBundledProviders());

function provider(
  id: string,
  displayName: string,
  category: Provider["category"],
): Provider {
  const template = providers[0];
  if (!template) throw new Error("Bundled catalog must not be empty");
  return { ...template, id, displayName, category, autoConfigurable: false };
}

describe("connections page tree", () => {
  it("puts the curated connector set in one flat list", () => {
    const items = catalogPageItems(providers);
    const ids = items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "linear",
        "microsoft",
        "salesforce",
        "slack",
        "snowflake",
        "openai",
        "asana",
        "google",
        "notion",
        "discord",
        "granola",
        "box",
        "clickhouse",
        "attio",
        "stripe",
        "zomato",
        "github",
        "vercel",
      ]),
    );
    expect(ids[0]).toBe("alibaba");
    expect(ids).not.toContain("byo-ai");
    expect(ids).not.toContain("cohere");
    expect(ids).not.toContain("deepgram");
    expect(ids).not.toContain("mistral");
    expect(ids).not.toContain("photon");
    expect(ids).not.toContain("replicate");
    expect(ids).not.toContain("stability");
    expect(ids).not.toContain("together");
    expect(ids).not.toContain("zai");
    expect(ids).not.toContain("linq");
    expect(ids).not.toContain("whoop");
    expect(ids).not.toContain("auth0");
  });

  it("searches tags as well as names", () => {
    const managed = catalogPageItems(providers, "managed").map(
      (item) => item.id,
    );
    expect(managed).toEqual(expect.arrayContaining(["linear", "slack"]));
    expect(managed).not.toContain("openai");

    const backup = catalogPageItems(providers, "backup").map((item) => item.id);
    expect(backup).toEqual(
      expect.arrayContaining(["github", "gitlab", "bitbucket", "codeberg"]),
    );

    const models = catalogPageItems(providers, "model provider").map(
      (item) => item.id,
    );
    expect(models).toEqual(expect.arrayContaining(["openai", "anthropic"]));
  });

  it("keeps feature bindings under Settings › Integrations", () => {
    const bindings = featureBindingSections([
      provider("auth0", "Auth0", "identity"),
      provider("github", "GitHub", "backup_recovery"),
      provider("linear", "Linear", "productivity"),
    ]);
    expect(bindings.map((group) => group.label)).toEqual([
      "Identity",
      "Backup/recovery",
    ]);
    expect(bindings[0]?.items?.map((item) => item.href)).toEqual([
      "/settings/connections/auth0",
    ]);
  });

  it("puts Needs attention and Connected before the flat catalog", () => {
    const tree = connectionsPageTree(providers, []);
    expect(tree.map((node) => node.label)).toEqual([
      "Connected",
      "Add a connection",
    ]);
    const leaves = pageTreeLeaves(tree);
    expect(leaves.length).toBe(catalogPageItems(providers).length);
    expect(leaves[0]?.href).toMatch(/^\/connections\//);
    expect(tree.find((node) => node.id === "catalog")?.children).toHaveLength(
      catalogPageItems(providers).length,
    );
  });
});
