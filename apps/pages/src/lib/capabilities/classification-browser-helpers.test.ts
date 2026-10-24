import { expect, it } from "vitest";
import { classify } from "./classification.js";

it.each([
  ["file-system", null, [".ts", ".test.ts"]],
  ["wake-lock", null, [".ts", ".test.ts"]],
  ["direct-sockets", null, [".ts", ".test.ts"]],
  ["honey-tokens", null, [".ts", ".test.ts"]],
  ["save-request", null, [".ts", ".test.ts"]],
  ["pwa-refresh", "install.pwa", [".ts", ".test.ts"]],
  ["launch-intake", "install.pwa", [".ts", ".test.ts"]],
  ["share-target", "install.pwa", [".ts", "-intake.ts", "-intake.test.ts"]],
] as const)(
  "retains the actual core owner for %s and its inventory",
  (stem, capability, suffixes) => {
    for (const suffix of suffixes)
      expect(classify(`src/lib/${stem}${suffix}`)).toMatchObject({
        pattern: `src/lib/${stem}`,
        classification: "core",
        capability,
      });
    expect(classify(`src/lib/${stem}s.ts`)).toBeNull();
  },
);
