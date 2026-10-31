import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
/* SAFETY: the JSON schema of spec/plugins/catalog.json is checked by crates/plugin-settings; this test reads only ids and kinds. */
const catalog = JSON.parse(
  readFileSync(
    join(here, "..", "..", "..", "spec", "plugins", "catalog.json"),
    "utf8",
  ),
) as { plugins: { id: string; kind: string }[] };
const pluginIds = new Set(catalog.plugins.map((p) => p.id));
const plugged = CAPABILITIES.filter((c) => c.plugin !== undefined);

describe("optional runtime plugins (ADR 0150 §7)", () => {
  it("every plugin a capability names is in spec/plugins/catalog.json", () => {
    for (const capability of plugged) {
      expect(
        pluginIds.has(capability.plugin ?? ""),
        `${capability.id} names unknown plugin ${capability.plugin}`,
      ).toBe(true);
    }
  });

  it("the browser-autofill plugin carries fill, pairing, and independent local authorization", () => {
    const ids = plugged
      .filter((c) => c.plugin === "browser-autofill")
      .map((c) => c.id);
    expect(ids).toEqual([
      "vault.autofill.requests",
      "vault.autofill.authorize",
      "vault.autofill.fill",
      "vault.autofill.pairing",
    ]);
  });

  it("no agent surface maps a plugin capability: a model never triggers a fill", () => {
    for (const capability of plugged) {
      for (const surface of ["mcp_host", "mcp_client", "webmcp"] as const) {
        expect(
          capability.surfaces[surface],
          `${capability.id} maps ${surface}`,
        ).toBeNull();
        expect(
          capability.excluded?.[surface]?.adr,
          `${capability.id} must exclude ${surface} citing ADR 0150`,
        ).toBe("0150-surrogate-credentials-at-the-last-hop.md");
      }
    }
  });

  it("the companion cannot authorize its own operations; other plugin actions use its messages", () => {
    const companions = new Set(
      catalog.plugins
        .filter((p) => p.kind === "browser-extension")
        .map((p) => p.id),
    );
    for (const capability of plugged) {
      if (!companions.has(capability.plugin ?? "")) continue;
      expect(capability.surfaces.pwa, capability.id).toBeNull();
      if (
        ["vault.autofill.requests", "vault.autofill.authorize"].includes(
          capability.id,
        )
      ) {
        expect(capability.surfaces.extension).toBeNull();
        expect(capability.surfaces.cli).toBe(
          `opensesame daemon fill ${capability.id.split(".").at(-1)}`,
        );
        expect(capability.excluded?.extension?.reason).toContain(
          "independent local operator",
        );
        continue;
      }
      expect(capability.surfaces.extension, capability.id).toMatch(
        /^message:opensesame\.fill(\.[a-z]+)?$/,
      );
    }
  });
});
