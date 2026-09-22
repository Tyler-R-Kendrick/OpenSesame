import { describe, expect, it } from "vitest";
import {
  createClassifier,
  findViolations,
  globToRegExp,
  parseImports,
  resolveRelative,
} from "./app-core-partition.mjs";

describe("globToRegExp", () => {
  it.each([
    ["lib/**", "lib/vault/store.ts", true],
    ["lib/**", "lib/kv.ts", true],
    ["lib/**", "sections/x.ts", false],
    ["**/*.tsx", "components/A.tsx", true],
    ["**/*.tsx", "A.tsx", true],
    ["lib/keymap*.ts", "lib/keymap.test.ts", true],
    ["lib/keymap*.ts", "lib/sub/keymap.ts", false],
    ["lib/use-*.ts", "lib/use-settings.ts", true],
  ])("%s matches %s → %s", (glob, path, matches) => {
    expect(globToRegExp(glob).test(path)).toBe(matches);
  });
});

describe("createClassifier", () => {
  const classify = createClassifier({
    move: ["lib/**"],
    stay: ["**/*.tsx", "lib/theme*.ts"],
  });

  it("moves lib code", () => {
    expect(classify("lib/vault/store.ts")).toBe("move");
  });

  it("keeps stay patterns and anything unmatched", () => {
    expect(classify("lib/theme.ts")).toBe("stay");
    expect(classify("lib/identity-hooks.test.tsx")).toBe("stay");
    expect(classify("sections/VaultSection.tsx")).toBe("stay");
  });
});

describe("parseImports", () => {
  it("finds static, re-export, side-effect and dynamic imports", () => {
    const source = [
      'import { a } from "./a.js";',
      'import type { B } from "./b.js";',
      'export { c } from "./c.js";',
      'export type { D } from "./d.js";',
      'import "./e.css";',
      'const f = await import("./f.js");',
    ].join("\n");
    expect(parseImports(source)).toEqual(
      expect.arrayContaining([
        { specifier: "./a.js", typeOnly: false },
        { specifier: "./b.js", typeOnly: true },
        { specifier: "./c.js", typeOnly: false },
        { specifier: "./d.js", typeOnly: true },
        { specifier: "./e.css", typeOnly: false },
        { specifier: "./f.js", typeOnly: false },
      ]),
    );
  });
});

describe("resolveRelative", () => {
  const files = new Map([
    ["lib/kv.ts", ""],
    ["lib/vault/index.ts", ""],
    ["components/A.tsx", ""],
  ]);

  it("maps a .js specifier onto its .ts source", () => {
    expect(resolveRelative("lib/vault/store.ts", "../kv.js", files)).toBe(
      "lib/kv.ts",
    );
  });

  it("resolves directory imports to index", () => {
    expect(resolveRelative("lib/x.ts", "./vault", files)).toBe(
      "lib/vault/index.ts",
    );
  });

  it("keeps a climb out of the root visible and drops query suffixes", () => {
    expect(
      resolveRelative("lib/x.test.ts", "../../public/auth.js?raw", files),
    ).toBe("../public/auth.js");
  });

  it("ignores package specifiers", () => {
    expect(resolveRelative("lib/x.ts", "react", files)).toBeNull();
  });
});

describe("findViolations", () => {
  const classify = createClassifier({
    move: ["lib/**"],
    stay: ["**/*.tsx", "lib/theme*.ts"],
  });

  it("reports crossings, React, outside imports and Vite env", () => {
    const files = new Map([
      [
        "lib/a.ts",
        [
          'import { useState } from "react";',
          'import type { T } from "./theme.js";',
          'import { b } from "./b.js";',
          'import data from "../../connectors/x.json";',
          "const url = import.meta.env.VITE_X;",
        ].join("\n"),
      ],
      ["lib/b.ts", 'import { Panel } from "../components/Panel.js";'],
      ["lib/theme.ts", ""],
      ["components/Panel.tsx", ""],
    ]);
    const result = findViolations(files, classify);
    expect(result.crossings).toEqual([
      { from: "lib/a.ts", to: "lib/theme.ts", typeOnly: true },
    ]);
    expect(result.react).toEqual([
      { from: "lib/a.ts", to: "react", typeOnly: false },
      { from: "lib/b.ts", to: "components/Panel.tsx", typeOnly: false },
    ]);
    expect(result.outside).toEqual([
      { from: "lib/a.ts", to: "../connectors/x.json", typeOnly: false },
    ]);
    expect(result.viteEnv).toEqual(["lib/a.ts"]);
  });

  it("does not inspect staying code", () => {
    const files = new Map([["lib/theme.ts", 'import "react";']]);
    expect(findViolations(files, classify).react).toEqual([]);
  });
});
