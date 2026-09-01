import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TYPE_IDS,
  LEGACY_TYPE_IDS,
  builtinDefinitions,
  builtinRegistry,
} from "./builtin.js";
import { FIELD_TYPES } from "./catalogue.js";
import { BUILTIN_DEFINITION_JSON } from "./definitions.generated.js";
import { ItemTypeRegistry } from "./registry.js";
import { subtitleFor } from "./values.js";

function communityDefinition(
  id: string,
  publisher: string,
  version = "1.0.0",
): string {
  return JSON.stringify({
    apiVersion: "opensesame.dev/v1alpha1",
    kind: "VaultItemType",
    metadata: { id, version, publisher },
    spec: {
      title: "Community type",
      plural: "Community types",
      extension: ".ct",
      summary: "Installed at runtime, with no build.",
      categories: ["other"],
      sections: [
        {
          id: "main",
          title: "Main",
          fields: [{ id: "label", type: "string", label: "Label" }],
        },
      ],
      native: { secret: null, trailer: [{ key: "label", field: "label" }] },
      cxf: { credential: "custom-fields" },
      subtitle: ["label"],
      search: ["label"],
    },
  });
}

describe("the built-in corpus", () => {
  it("parses every shipped definition", () => {
    expect(builtinDefinitions()).toHaveLength(BUILTIN_TYPE_IDS.length);
  });

  it("still ships every kind that predates the registry", () => {
    for (const id of LEGACY_TYPE_IDS) {
      expect(BUILTIN_TYPE_IDS).toContain(id);
    }
  });

  it("gives every type a distinct VFS extension", () => {
    const extensions = builtinDefinitions().map((d) => d.spec.extension);
    expect(new Set(extensions).size).toBe(extensions.length);
  });

  it("names a ceremony handler only where the platform implements one", () => {
    const handlers = builtinDefinitions()
      .filter((d) => d.spec.handler !== undefined)
      .map((d) => d.metadata.id)
      .sort();
    expect(handlers).toEqual([
      "certificate",
      "drop",
      "login",
      "passkey",
      "secret",
    ]);
  });

  it("keeps concealed fields out of every preview surface", () => {
    for (const definition of builtinDefinitions()) {
      const byId = new Map(
        definition.spec.sections.flatMap((s) => s.fields).map((f) => [f.id, f]),
      );
      for (const id of [
        ...definition.spec.subtitle,
        ...definition.spec.search,
      ]) {
        const field = byId.get(id);
        expect(field).toBeDefined();
        if (field === undefined) continue;
        expect(FIELD_TYPES[field.type].concealed).toBe(false);
      }
    }
  });

  it("keeps the generated module in step with the JSON corpus", () => {
    // The JSON files are the corpus `crates/vault-item-types` embeds too, so
    // editing one without re-running `pnpm --filter @opensesame/vault-item-types
    // generate` would leave the two planes disagreeing (ADR 0087 §8).
    const dir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "definitions",
    );
    const onDisk = new Map(
      readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => [
          name.replace(/\.json$/, ""),
          readFileSync(join(dir, name), "utf8").trimEnd(),
        ]),
    );
    const embedded = new Map<string, string>(
      Object.entries(BUILTIN_DEFINITION_JSON),
    );
    expect([...embedded.keys()].sort()).toEqual([...onDisk.keys()].sort());
    for (const [id, text] of onDisk) {
      expect(embedded.get(id)).toBe(text);
    }
  });
});

describe("ItemTypeRegistry", () => {
  it("installs a community definition with no build step", () => {
    const registry = builtinRegistry();
    expect(registry.has("field-notes")).toBe(false);
    const outcome = registry.install(
      communityDefinition("field-notes", "https://community.test"),
      "vault",
    );
    expect(outcome.ok).toBe(true);
    expect(registry.has("field-notes")).toBe(true);
    expect(registry.sourceOf("field-notes")).toBe("vault");
    expect(registry.isBuiltin("field-notes")).toBe(false);
  });

  it("uninstalls without touching anything else", () => {
    const registry = builtinRegistry();
    registry.install(
      communityDefinition("field-notes", "https://community.test"),
      "vault",
    );
    expect(registry.uninstall("field-notes")).toBe(true);
    expect(registry.has("field-notes")).toBe(false);
    expect(registry.uninstall("field-notes")).toBe(false);
    expect(registry.has("login")).toBe(true);
  });

  it("refuses to shadow a built-in id", () => {
    const registry = builtinRegistry();
    const outcome = registry.install(
      communityDefinition("login", "https://community.test"),
      "vault",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]?.code).toBe("id");
    expect(registry.get("login")?.metadata.publisher).toBe(
      "https://opensesame.dev",
    );
  });

  it("refuses an install that claims a built-in extension", () => {
    const registry = builtinRegistry();
    // `.login` is how the VFS tree spells a login. A type that could claim it
    // could dress its items as logins.
    const outcome = registry.install(
      communityDefinition("impostor", "https://community.test").replace(
        '".ct"',
        '".login"',
      ),
      "vault",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]?.code).toBe("extension");
    expect(outcome.errors[0]?.message).toContain("login");
  });

  it("refuses an install that claims another installed type's extension", () => {
    const registry = builtinRegistry();
    registry.install(communityDefinition("first", "https://a.test"), "vault");
    const outcome = registry.install(
      communityDefinition("second", "https://b.test"),
      "vault",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]?.code).toBe("extension");
  });

  it("lets a type keep its own extension across an upgrade", () => {
    const registry = builtinRegistry();
    registry.install(
      communityDefinition("same", "https://a.test", "1.0.0"),
      "vault",
    );
    expect(
      registry.install(
        communityDefinition("same", "https://a.test", "1.1.0"),
        "vault",
      ).ok,
    ).toBe(true);
  });

  it("refuses a second publisher taking over an installed id", () => {
    const registry = builtinRegistry();
    registry.install(
      communityDefinition("shared", "https://first.test"),
      "vault",
    );
    const outcome = registry.install(
      communityDefinition("shared", "https://second.test"),
      "vault",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]?.code).toBe("publisher");
  });

  it("accepts an upgrade and refuses a downgrade from the same publisher", () => {
    const registry = builtinRegistry();
    registry.install(
      communityDefinition("shared", "https://first.test", "1.2.0"),
      "vault",
    );
    expect(
      registry.install(
        communityDefinition("shared", "https://first.test", "1.3.0"),
        "vault",
      ).ok,
    ).toBe(true);
    const downgrade = registry.install(
      communityDefinition("shared", "https://first.test", "1.0.0"),
      "vault",
    );
    expect(downgrade.ok).toBe(false);
    if (downgrade.ok) return;
    expect(downgrade.errors[0]?.code).toBe("version");
    expect(registry.get("shared")?.metadata.version).toBe("1.3.0");
  });

  it("reports only vault-installed definitions for persistence", () => {
    const registry = builtinRegistry();
    registry.install(
      communityDefinition("from-vault", "https://a.test"),
      "vault",
    );
    registry.install(
      communityDefinition("from-host", "https://b.test"),
      "host",
    );
    expect(registry.installed().map((d) => d.metadata.id)).toEqual([
      "from-vault",
    ]);
  });

  it("groups types by their declared categories", () => {
    const registry = builtinRegistry();
    const grouped = registry.categories();
    expect(grouped.get("identity")).toContain("passport");
    expect(grouped.get("finance")).toContain("bank-account");
  });

  it("holds a definition an empty registry has never seen", () => {
    const registry = new ItemTypeRegistry();
    expect(registry.get("login")).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });
});

describe("previews", () => {
  it("builds a subtitle from the declared, non-concealed fields", () => {
    const registry = builtinRegistry();
    const bank = registry.get("bank-account");
    expect(bank).toBeDefined();
    if (bank === undefined) return;
    expect(
      subtitleFor(bank, {
        bank: "Example Savings",
        accountType: "checking",
        accountNumber: "0001234567",
      }),
    ).toBe("Example Savings · checking");
  });
});
