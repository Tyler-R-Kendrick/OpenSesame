import { expect, it } from "vitest";
import {
  defaultScopeRoles,
  isScopeRoles,
  permitsApplicationScopes,
} from "./local-application-policy.js";

it("defaults to identity only and never infers authority from owner status", () => {
  const policy = defaultScopeRoles(["openid", "records:read"]);
  expect(permitsApplicationScopes(policy, "owner", ["records:read"])).toBe(
    false,
  );
  expect(permitsApplicationScopes(policy, "member", ["openid"])).toBe(true);
  expect(
    permitsApplicationScopes(
      [{ scope: "records:read", roles: ["member"] }],
      "owner",
      ["records:read"],
    ),
  ).toBe(false);
});

it("rejects missing, duplicated, unknown and malformed scope policies", () => {
  for (const policy of [
    [],
    [{ scope: "openid", roles: ["root"] }],
    [{ scope: "other", roles: ["owner"] }],
    [{ scope: "openid", roles: ["owner", "owner"] }],
    [{ scope: "openid", roles: ["owner"], wildcard: true }],
    [
      { scope: "openid", roles: [] },
      { scope: "openid", roles: [] },
    ],
  ])
    expect(isScopeRoles(policy, ["openid"])).toBe(false);
  expect(isScopeRoles([{ scope: "openid", roles: [] }], ["openid"])).toBe(true);
});
