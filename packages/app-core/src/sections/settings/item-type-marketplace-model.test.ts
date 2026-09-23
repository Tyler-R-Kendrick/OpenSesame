import {
  type ItemTypeDefinition,
  builtinRegistry,
  parseDefinition,
} from "@opensesame/vault-item-types";
import { describe, expect, it } from "vitest";
import type { MarketplaceOffer } from "../../lib/item-type-marketplace/load.js";
import {
  offerRank,
  offerState,
  offerStateLabel,
  publisherLabel,
} from "./item-type-marketplace-model.js";

function manifest(
  id: string,
  version = "1.0.0",
  publisher = "https://example.org",
  extension = ".mtest",
) {
  return JSON.stringify({
    apiVersion: "opensesame.dev/v1alpha1",
    kind: "VaultItemType",
    metadata: { id, version, publisher },
    spec: {
      title: "Model test",
      plural: "Model tests",
      extension,
      summary: "A type for the model test.",
      categories: [],
      sections: [
        {
          id: "s",
          title: "S",
          fields: [{ id: "a", type: "string", label: "A" }],
        },
      ],
      native: { secret: "a", trailer: [] },
      cxf: { credential: "custom-fields" },
      subtitle: [],
      search: [],
    },
  });
}

function offer(text: string): MarketplaceOffer {
  const parsed = parseDefinition(text, "community");
  if (!parsed.ok) throw new Error("fixture does not parse");
  const definition: ItemTypeDefinition = parsed.definition;
  return { ok: true, path: "t.json", text, sha256: "", definition };
}

describe("offerState", () => {
  it("offers what is not installed", () => {
    const state = offerState(builtinRegistry(), offer(manifest("m1")));
    expect(state).toEqual({ kind: "available" });
    expect(offerStateLabel(state)).toBe("Not installed");
  });

  it("withholds a built-in id", () => {
    const state = offerState(builtinRegistry(), offer(manifest("wifi")));
    expect(state.kind).toBe("builtin");
  });

  it("names installed, update and conflict against what the vault holds", () => {
    const registry = builtinRegistry();
    registry.install(manifest("m1", "1.0.0"), "vault");
    expect(offerState(registry, offer(manifest("m1", "1.0.0"))).kind).toBe(
      "installed",
    );
    const update = offerState(registry, offer(manifest("m1", "1.2.0")));
    expect(update).toEqual({ kind: "update", from: "1.0.0" });
    const other = offerState(
      registry,
      offer(manifest("m1", "2.0.0", "https://other.example")),
    );
    expect(other).toEqual({
      kind: "conflict",
      reason: "Installed from example.org",
    });
  });

  it("refuses an extension another type already renders", () => {
    const state = offerState(
      builtinRegistry(),
      offer(manifest("m2", "1.0.0", "https://example.org", ".wifi")),
    );
    expect(state.kind).toBe("conflict");
  });

  it("asks the registry: title, directory and filter names conflict", () => {
    const registry = builtinRegistry();
    const titled = manifest("m3").replace('"Model test"', '"Wi-Fi network"');
    const titleState = offerState(registry, offer(titled));
    expect(titleState.kind).toBe("conflict");
    expect(offerStateLabel(titleState)).toMatch(/already the title/);
    const filter = manifest("favorites");
    expect(offerStateLabel(offerState(registry, offer(filter)))).toMatch(
      /vault filter/,
    );
    const plural = manifest("m4").replace('"Model tests"', '"Notes"');
    expect(offerState(registry, offer(plural)).kind).toBe("conflict");
    for (const text of [titled, filter, plural]) {
      expect(registry.install(text, "vault").ok).toBe(false);
    }
  });

  it("withholds an update the registry would refuse", () => {
    const registry = builtinRegistry();
    registry.install(manifest("m5", "1.0.0"), "vault");
    const clashing = manifest("m5", "1.1.0").replace(".mtest", ".wifi");
    const state = offerState(registry, offer(clashing));
    expect(state.kind).toBe("conflict");
    expect(registry.install(clashing, "vault").ok).toBe(false);
    expect(offerState(registry, offer(manifest("m5", "1.1.0")))).toEqual({
      kind: "update",
      from: "1.0.0",
    });
  });

  it("carries a refused definition's reason", () => {
    const state = offerState(builtinRegistry(), {
      ok: false,
      path: "x.json",
      problem: "Not found in the repository.",
    });
    expect(offerStateLabel(state)).toBe("Not found in the repository.");
  });

  it("ranks updates first", () => {
    expect(offerRank({ kind: "update", from: "1" })).toBeLessThan(
      offerRank({ kind: "available" }),
    );
    expect(publisherLabel("https://opensesame.dev")).toBe("opensesame.dev");
  });
});
