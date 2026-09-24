import { describe, expect, it } from "vitest";
import {
  blockingCount,
  findViolations,
  mayUseNode,
  parseImports,
  resolveFromPackage,
} from "./app-core-boundary.mjs";

const OPTIONS = { packageName: "@opensesame/app-core", packageDepth: 2 };

describe("parseImports", () => {
  it("finds static, re-export, side-effect, dynamic and mocked imports", () => {
    const source = [
      'import { a } from "./a.js";',
      'import type { B } from "./b.js";',
      'export { c } from "./c.js";',
      'export type { D } from "./d.js";',
      'import "./e.css";',
      'const f = await import("./f.js");',
      'vi.mock("./g.js", () => ({}));',
    ].join("\n");
    expect(parseImports(source)).toEqual(
      expect.arrayContaining([
        { specifier: "./a.js", typeOnly: false },
        { specifier: "./b.js", typeOnly: true },
        { specifier: "./c.js", typeOnly: false },
        { specifier: "./d.js", typeOnly: true },
        { specifier: "./e.css", typeOnly: false },
        { specifier: "./f.js", typeOnly: false },
        { specifier: "./g.js", typeOnly: false },
      ]),
    );
  });
});

describe("resolveFromPackage", () => {
  it.each([
    ["src/lib/x.ts", "./y.js", "src/lib/y.js"],
    ["src/lib/x.ts", "../host.js", "src/host.js"],
    ["src/lib/x.ts", "../../scripts/o.mjs", "scripts/o.mjs"],
    [
      "src/lib/x.ts",
      "../../../../apps/pages/public/a.json",
      "../../apps/pages/public/a.json",
    ],
    ["src/lib/x.ts", "./y.js?raw", "src/lib/y.js"],
  ])("%s + %s → %s", (from, specifier, expected) => {
    expect(resolveFromPackage(from, specifier)).toBe(expected);
  });
});

describe("findViolations", () => {
  it("reports escapes, React, Vite env, virtual modules and self-imports", () => {
    const files = new Map([
      [
        "src/lib/a.ts",
        [
          'import { useState } from "react";',
          'import type { ComponentType } from "react";',
          'import profile from "../../../../apps/pages/public/p.json";',
          'import { MODULE_TABLE } from "virtual:opensesame-capability-modules";',
          'import { env } from "@opensesame/app-core/host.js";',
          "const url = import.meta.env.VITE_X;",
        ].join("\n"),
      ],
      ["src/lib/b.ts", 'import { a } from "./a.js";'],
    ]);
    const report = findViolations(files, OPTIONS);
    expect(report.react.map((e) => e.to)).toEqual(["react"]);
    expect(report.reactTypes.map((e) => e.to)).toEqual(["react"]);
    expect(report.escapes).toEqual([
      {
        from: "src/lib/a.ts",
        to: "apps/pages/public/p.json",
        typeOnly: false,
      },
    ]);
    expect(report.virtual.map((e) => e.to)).toEqual([
      "virtual:opensesame-capability-modules",
    ]);
    expect(report.selfImports.map((e) => e.to)).toEqual([
      "@opensesame/app-core/host.js",
    ]);
    expect(report.viteEnv).toEqual(["src/lib/a.ts"]);
    expect(blockingCount(report)).toBe(5);
  });

  it("allows repo-level shared data and paths inside the package", () => {
    const files = new Map([
      [
        "src/lib/catalog.ts",
        [
          'import parity from "../../../../spec/connectors/fnox-parity.json";',
          'const vault = "../../../../tests/fixtures/kdbx/x.kdbx";',
          'import { oracle } from "../../scripts/sops-oracle/oracle.mjs";',
          'import { host } from "../host.js";',
        ].join("\n"),
      ],
    ]);
    const report = findViolations(files, OPTIONS);
    expect(blockingCount(report)).toBe(0);
  });

  it("counts test-library React as React", () => {
    const files = new Map([
      [
        "src/lib/c.test.ts",
        'import { waitFor } from "@testing-library/react";',
      ],
    ]);
    expect(findViolations(files, OPTIONS).react).toHaveLength(1);
  });

  it("keeps Node's built-ins in the Node host and tests", () => {
    const files = new Map([
      ["src/node/host.ts", 'import { homedir } from "node:os";'],
      ["src/lib/a.test.ts", 'import { readFileSync } from "node:fs";'],
      ["src/lib/sops/test/fixtures.ts", 'import { join } from "node:path";'],
      ["src/lib/vault/store.ts", 'import { readFileSync } from "node:fs";'],
      ["src/sandbox/host.ts", 'import { createHash } from "node:crypto";'],
    ]);
    const report = findViolations(files, OPTIONS);
    expect(report.nodeImports.map((edge) => edge.from)).toEqual([
      "src/lib/vault/store.ts",
      "src/sandbox/host.ts",
    ]);
    expect(blockingCount(report)).toBe(2);
  });

  it("knows which paths may use Node", () => {
    expect(mayUseNode("src/node/file-storage.ts")).toBe(true);
    expect(mayUseNode("src/test-host.ts")).toBe(true);
    expect(mayUseNode("src/lib/x.test.ts")).toBe(true);
    expect(mayUseNode("src/lib/kv.ts")).toBe(false);
    expect(mayUseNode("src/browser/host.ts")).toBe(false);
  });
});
