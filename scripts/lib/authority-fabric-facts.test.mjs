import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { moduleFacts, stripRustComments } from "./authority-fabric-facts.mjs";

describe("stripRustComments", () => {
  it("removes a line comment but keeps the code beside it", () => {
    expect(stripRustComments("pub mod a; // and a note")).toBe("pub mod a; ");
  });

  it("removes a block comment", () => {
    expect(stripRustComments("/* pub mod a; */\npub mod b;")).toBe(
      "\npub mod b;",
    );
  });

  it("removes nested block comments without ending early", () => {
    const source = "/* outer /* inner */ pub mod a; */\npub mod b;";
    expect(stripRustComments(source)).not.toContain("mod a");
    expect(stripRustComments(source)).toContain("mod b");
  });

  it("keeps line numbering, so a declaration is not shifted onto a comment", () => {
    const source = "/*\n\n*/\npub mod a;";
    expect(stripRustComments(source).split("\n")).toHaveLength(4);
  });
});

describe("moduleFacts", () => {
  let root;
  const crates = {
    "test-crate": {
      inWorkspace: true,
      member: "crates/test",
      libPath: "src/lib.rs",
      libExists: true,
    },
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "authority-fabric-facts-"));
    const src = join(root, "crates", "test", "src");
    mkdirSync(join(src, "budget"), { recursive: true });
    // The shape that made the first version of this probe report a false pass:
    // a complete module parked behind a commented-out declaration.
    writeFileSync(
      join(src, "lib.rs"),
      [
        "pub mod wired;",
        "/* WIP BUDGET incomplete ledger exports",
        "pub mod budget;",
        "*/",
      ].join("\n"),
    );
    writeFileSync(join(src, "wired.rs"), "pub mod nested;\n");
    writeFileSync(join(src, "budget", "mod.rs"), "mod limits;\n");
    writeFileSync(join(src, "budget", "limits.rs"), "");
  });

  const facts = (module) =>
    moduleFacts(root, crates, [{ crate: "test-crate", module }])[
      `test-crate:${module}`
    ];

  it("does not count a declaration that is commented out", () => {
    expect(facts("budget")).toBe(false);
  });

  it("does not count a submodule under a commented-out parent", () => {
    expect(facts("budget::limits")).toBe(false);
  });

  it("counts a declaration that is live", () => {
    expect(facts("wired")).toBe(true);
  });

  it("reports a module the crate root never names", () => {
    expect(facts("orphan")).toBe(false);
  });

  it("blocks a crate whose lib target does not exist without reading files", () => {
    const missing = {
      "no-lib": {
        inWorkspace: true,
        member: "crates/none",
        libPath: "src/lib.rs",
        libExists: false,
      },
    };
    const result = moduleFacts(root, missing, [
      { crate: "no-lib", module: "anything" },
    ]);
    expect(result["no-lib:anything"]).toBe(false);
  });
});
