import { describe, expect, it } from "vitest";
import cases from "../../../spec/conformance/item-type-cases.json" with {
  type: "json",
};
import { builtinRegistry } from "./builtin.js";
import {
  LEGACY_EXTENSION_ALIASES,
  LEGACY_TYPE_ALIASES,
  isLegacyTypeAlias,
  resolveExtension,
  resolveTypeId,
} from "./legacy-aliases.js";
import { communityDefinition } from "./registry.test-support.js";

describe("legacy aliases (ADR 0168)", () => {
  it("is the table crates/vault-item-types carries", () => {
    expect(LEGACY_TYPE_ALIASES).toEqual(cases.legacyAliases.types);
    expect(LEGACY_EXTENSION_ALIASES).toEqual(cases.legacyAliases.extensions);
  });

  it("resolves a retired id and extension, and leaves current ones alone", () => {
    expect(resolveTypeId("login")).toBe("account");
    expect(resolveTypeId("account")).toBe("account");
    expect(resolveTypeId("note")).toBe("note");
    expect(resolveTypeId("constructor")).toBe("constructor");
    expect(resolveExtension(".login")).toBe(".account");
    expect(resolveExtension(".account")).toBe(".account");
    expect(isLegacyTypeAlias("login")).toBe(true);
    expect(isLegacyTypeAlias("account")).toBe(false);
  });

  it("answers `login` with the account definition", () => {
    const registry = builtinRegistry();
    expect(registry.get("login")).toBe(registry.get("account"));
    expect(registry.get("login")?.metadata.id).toBe("account");
    expect(registry.get("login")?.spec.extension).toBe(".account");
    expect(registry.has("login")).toBe(true);
    expect(registry.sourceOf("login")).toBe("builtin");
    expect(registry.isBuiltin("login")).toBe(true);
  });

  it("lists no `login` type of its own", () => {
    const ids = builtinRegistry()
      .list()
      .map((entry) => entry.definition.metadata.id);
    expect(ids).toContain("account");
    expect(ids).not.toContain("login");
  });

  it("refuses an install that takes the retired id", () => {
    const outcome = builtinRegistry().install(
      communityDefinition("login", "https://community.test"),
      "vault",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]?.code).toBe("id");
  });

  it("refuses an install that claims the retired extension", () => {
    const outcome = builtinRegistry().install(
      communityDefinition("impostor", "https://community.test").replace(
        '".ct"',
        '".login"',
      ),
      "vault",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]?.code).toBe("extension");
    expect(outcome.errors[0]?.message).toContain("`account`");
  });
});
