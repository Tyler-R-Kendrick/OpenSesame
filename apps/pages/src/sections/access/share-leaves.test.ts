import type { LocalShare } from "@opensesame/app-core/lib/local-share-grants.js";
import { expect, it } from "vitest";
import { shareLeafLabels } from "./share-leaves.js";

function share(id: string, principalId: string, policy: string): LocalShare {
  return {
    id,
    principalId,
    resourceKind: "vault",
    resourceId: "guest-1",
    resourceLabel: "guest-1",
    policy,
    issuedAt: 0,
    expiresAt: 3_600_000,
  };
}

it("names a share as its card does, and adds the policy only to tell two apart", () => {
  const names = new Map([
    ["p_guest", "guest-1"],
    ["p_op", "open-sesame"],
  ]);
  expect(
    shareLeafLabels(
      [
        share("a", "p_guest", "open"),
        share("b", "p_guest", "items"),
        share("c", "p_op", "open"),
      ],
      names,
    ).map((leaf) => leaf.label),
  ).toEqual([
    "guest-1 → guest-1 · Open",
    "guest-1 → guest-1 · Use items",
    "open-sesame → guest-1",
  ]);
});
