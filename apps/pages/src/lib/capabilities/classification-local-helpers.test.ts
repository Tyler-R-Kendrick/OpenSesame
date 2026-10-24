import { expect, it } from "vitest";
import { classify } from "./classification.js";

it.each([
  "local-actor",
  "local-share-audit",
  "local-share-match",
  "local-vault-session-code",
  "local-vault-session-shape",
])("retains shared record-helper ownership for %s", (stem) => {
  expect(classify(`src/lib/${stem}.ts`)).toMatchObject({
    pattern: `src/lib/${stem}`,
    classification: "shared",
    capability: null,
  });
  expect(classify(`src/lib/${stem}s.ts`)).toBeNull();
});
it("keeps the Local P2P implementation and its tests with the live protocol they import", () => {
  for (const suffix of [".ts", ".test.ts"])
    expect(classify(`src/lib/local-p2p${suffix}`)).toMatchObject({
      pattern: "src/lib/local-p2p",
      classification: "optional",
      capability: "sharing.live",
    });
  expect(classify("src/lib/local-p2ps.ts")).toBeNull();
});
