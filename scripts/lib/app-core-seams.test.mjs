import { describe, expect, it } from "vitest";
import {
  RESTRICTED_SEAMS,
  findRestrictedImports,
  resolveSpecifier,
} from "./app-core-seams.mjs";

const MODULE = "packages/app-core/src/lib/vault/store-device-key";
const find = (entries) => findRestrictedImports(new Map(entries));

describe("resolveSpecifier", () => {
  it.each([
    [
      "packages/app-core/src/lib/vault/store-merge.ts",
      "./store-device-key.js",
      MODULE,
    ],
    [
      "packages/app-core/src/lib/device-identity-key.ts",
      "./vault/store-device-key.js",
      MODULE,
    ],
    [
      "apps/pages/src/x.ts",
      "@opensesame/app-core/lib/vault/store-device-key.js",
      MODULE,
    ],
    [
      "apps/pages/src/x.ts",
      "@opensesame/app-core/lib/kv.js",
      "packages/app-core/src/lib/kv",
    ],
    ["apps/pages/src/x.ts", "react", null],
    ["apps/pages/src/x.ts", "@opensesame/vault-core", null],
  ])("%s + %s -> %s", (from, specifier, expected) => {
    expect(resolveSpecifier(from, specifier)).toBe(expected);
  });
});

describe("the seams only the store, the generator and tests may import", () => {
  it("names the three that hand out the open vault's body", () => {
    expect(RESTRICTED_SEAMS).toHaveLength(1);
    expect(RESTRICTED_SEAMS[0].names).toEqual([
      "bodyPortOf",
      "registerBodyPort",
      "installDeviceKeyCarrier",
    ]);
  });

  it("refuses an app, a lib module and a package that import them, by any road", () => {
    const violations = find([
      [
        "apps/pages/src/lib/x.ts",
        'import { bodyPortOf } from "@opensesame/app-core/lib/vault/store-device-key.js";',
      ],
      [
        "packages/app-core/src/lib/device-identity-host.ts",
        'import { installDeviceKeyCarrier } from "./vault/store-device-key.js";',
      ],
      [
        "packages/app-core/src/lib/y.ts",
        'const { registerBodyPort } = await import("./vault/store-device-key.js");',
      ],
      [
        "packages/cli/src/z.ts",
        'import * as seam from "@opensesame/app-core/lib/vault/store-device-key.js";\nseam.bodyPortOf(store);',
      ],
    ]);
    expect(violations.map((v) => [v.file, v.names])).toEqual([
      ["apps/pages/src/lib/x.ts", ["bodyPortOf"]],
      [
        "packages/app-core/src/lib/device-identity-host.ts",
        ["installDeviceKeyCarrier"],
      ],
      ["packages/app-core/src/lib/y.ts", ["registerBodyPort"]],
      ["packages/cli/src/z.ts", ["bodyPortOf"]],
    ]);
  });

  it("refuses a whole-module re-export", () => {
    const violations = find([
      [
        "packages/app-core/src/lib/vault/index.ts",
        'export * from "./store-device-key.js";',
      ],
    ]);
    expect(violations.map((v) => v.names)).toEqual([["*"]]);
  });

  it("lets the module, the store that wires it and the vector generator use them", () => {
    expect(
      find([
        [
          "packages/app-core/src/lib/vault/store.ts",
          'import { bodyPortOf, installDeviceKeyCarrier, registerBodyPort } from "./store-device-key.js";',
        ],
        [
          "packages/app-core/src/lib/vault/store-device-key.ts",
          "export function bodyPortOf() {}\nexport function registerBodyPort() {}",
        ],
        [
          "apps/pages/scripts/vault-vectors/emit.ts",
          'import { bodyPortOf } from "@opensesame/app-core/lib/vault/store-device-key.js";',
        ],
      ]),
    ).toEqual([]);
  });

  it("lets tests and test support use them", () => {
    const line = 'import { bodyPortOf } from "./store-device-key.js";';
    expect(
      find([
        ["packages/app-core/src/lib/vault/device-key-x.test.ts", line],
        ["packages/app-core/src/lib/__tests__/x.ts", line],
        ["packages/app-core/src/lib/tailnet-sync/x.fixture.ts", line],
        ["apps/pages/src/sections/y.test.tsx", line],
      ]),
    ).toEqual([]);
  });

  it("lets everyone import the module's other exports", () => {
    expect(
      find([
        [
          "packages/app-core/src/lib/vault/store-merge.ts",
          'import { type VaultBodyPort, levelDeviceKey } from "./store-device-key.js";',
        ],
        [
          "packages/app-core/src/lib/vault/store-import.ts",
          'import { type VaultBodyPort, levelDeviceKey, makeBodyPort } from "./store-device-key.js";',
        ],
      ]),
    ).toEqual([]);
  });

  it("does not mistake the same names from another module for the seam", () => {
    expect(
      find([
        [
          "apps/pages/src/other.ts",
          'import { bodyPortOf } from "./not-the-seam.js";',
        ],
      ]),
    ).toEqual([]);
  });
});
