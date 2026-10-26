import { expect, it } from "vitest";
import { classify } from "./classification.js";

it("keeps pairwise local subjects with their local issuer consumer", () => {
  const issuer = classify("src/lib/local-issuer-channel.ts");
  expect(issuer?.capability).toBe("identity.local-iam");
  for (const suffix of [".ts", ".test.ts"])
    expect(classify(`src/lib/local-pairwise-subject${suffix}`)).toMatchObject({
      classification: issuer?.classification,
      capability: issuer?.capability,
    });
  expect(classify("src/lib/local-pairwise-subjects.ts")).toBeNull();
});

it("names only the authored lock manager test stand-in as shared infrastructure", () => {
  expect(classify("src/test-support/lock-manager.ts")).toMatchObject({
    classification: "shared",
    capability: null,
  });
  expect(classify("src/test-support/lock-manager-production.ts")).toBeNull();
  expect(classify("src/test-support/unrelated.ts")).toBeNull();
});

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
