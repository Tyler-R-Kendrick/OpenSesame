/**
 * One directory and one name per registered type: the rules that keep two
 * types from drawing as one in the vault rail or the type picker.
 */
import { describe, expect, it } from "vitest";
import { builtinDefinitions, builtinRegistry } from "./builtin.js";
import {
  RESERVED_DIRECTORIES,
  RESERVED_TYPE_IDS,
  directoryName,
} from "./registry.js";
import { communityDefinition } from "./registry.test-support.js";

describe("the built-in corpus", () => {
  it("gives every type a distinct title and vault directory", () => {
    const titles = builtinDefinitions().map((d) => d.spec.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
    const directories = builtinDefinitions().map(directoryName);
    expect(new Set(directories).size).toBe(directories.length);
    for (const directory of directories) {
      expect(RESERVED_DIRECTORIES).not.toContain(directory);
    }
  });
});

describe("registered names", () => {
  it("derives a type's directory from its plural", () => {
    const registry = builtinRegistry();
    const directory = (id: string) => {
      const definition = registry.get(id);
      return definition === undefined ? undefined : directoryName(definition);
    };
    expect(directory("login")).toBe("logins");
    expect(directory("wifi")).toBe("wi-fi-networks");
    expect(directory("api-credential")).toBe("api-credentials");
    const unspellable = registry.install(
      communityDefinition("glyphs", "https://community.test").replace(
        '"Community types"',
        '"\u00e9\u00e9"',
      ),
      "vault",
    );
    expect(unspellable.ok && directoryName(unspellable.definition)).toBe(
      "glyphs",
    );
  });

  it("refuses an install whose directory is another type's", () => {
    const registry = builtinRegistry();
    // `Logins` is the directory every login already lives in; a second type
    // there would pour its items in with them.
    const outcome = registry.install(
      communityDefinition("impostor", "https://community.test").replace(
        '"Community types"',
        '" LOGINS "',
      ),
      "vault",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]).toMatchObject({
      code: "name",
      path: "spec.plural",
    });
    expect(outcome.errors[0]?.message).toContain("login");
  });

  it("refuses an install whose title is another type's", () => {
    const registry = builtinRegistry();
    const outcome = registry.install(
      communityDefinition("impostor", "https://community.test").replace(
        '"Community type"',
        '"secure NOTE"',
      ),
      "vault",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]).toMatchObject({
      code: "name",
      path: "spec.title",
    });
  });

  it("refuses an id that is already a vault filter", () => {
    for (const reserved of RESERVED_TYPE_IDS) {
      const outcome = builtinRegistry().install(
        communityDefinition(reserved, "https://community.test"),
        "vault",
      );
      expect(outcome.ok ? "installed" : outcome.errors[0]?.code).toBe("id");
    }
  });

  it("compares titles without case or surrounding ASCII space", () => {
    const outcome = builtinRegistry().install(
      communityDefinition("impostor", "https://community.test").replace(
        '"Community type"',
        '"\\t LOGIN \\n"',
      ),
      "vault",
    );
    expect(outcome.ok ? "installed" : outcome.errors[0]?.code).toBe("name");
    // A byte-order mark is not space on both planes, so it is part of the
    // title on both, and the install is not a clash on either.
    const marked = builtinRegistry().install(
      communityDefinition("marked", "https://community.test").replace(
        '"Community type"',
        '"\\ufeffLogin"',
      ),
      "vault",
    );
    expect(marked.ok).toBe(true);
  });

  it("refuses a directory the rail keeps for itself", () => {
    for (const reserved of RESERVED_DIRECTORIES) {
      const outcome = builtinRegistry().install(
        communityDefinition("impostor", "https://community.test").replace(
          '"Community types"',
          JSON.stringify(reserved),
        ),
        "vault",
      );
      expect(outcome.ok ? "installed" : outcome.errors[0]?.code).toBe("name");
    }
  });

  it("refuses a second installed type under the same names", () => {
    const registry = builtinRegistry();
    expect(
      registry.install(communityDefinition("first", "https://a.test"), "vault")
        .ok,
    ).toBe(true);
    const outcome = registry.install(
      communityDefinition("second", "https://b.test").replace('".ct"', '".c2"'),
      "vault",
    );
    expect(outcome.ok ? "installed" : outcome.errors[0]?.code).toBe("name");
    // Uninstalling frees the names for the next type.
    registry.uninstall("first");
    expect(
      registry.install(
        communityDefinition("second", "https://b.test").replace(
          '".ct"',
          '".c2"',
        ),
        "vault",
      ).ok,
    ).toBe(true);
  });
});
