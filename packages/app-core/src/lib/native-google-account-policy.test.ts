import type { JsonValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { googleAccountPolicy } from "../../scripts/emit-google-account-policy.mjs";
import { GOOGLE_ACCOUNT_POLICY } from "./native-google-account-policy.generated.js";
import {
  isGoogleDriveAccountScopeSet,
  normalizeGoogleDriveAccountScopes,
} from "./native-google-drive-account.js";

const row = {
  service: "google-drive",
  server_url: "https://accounts.example.test",
  authorization_endpoint: "https://accounts.example.test/authorize",
  token_endpoint: "https://accounts.example.test/token",
  userinfo_endpoint: "https://accounts.example.test/userinfo",
  verify: { url: "https://accounts.example.test/userinfo" },
  scopes: [
    { name: "openid", account_only: true },
    { name: "email", account_only: true },
    { name: "drive.readonly", account_only: false },
  ],
  account_only_policy: {
    scope_aliases: { "https://accounts.example.test/email": "email" },
    forbidden_parameters: ["token_relay_url"],
  },
};

describe("generated Google account policy", () => {
  it("matches the shared OAuth preset and freezes all policy components", () => {
    expect(GOOGLE_ACCOUNT_POLICY).toEqual(googleAccountPolicy());
    for (const value of Object.values(GOOGLE_ACCOUNT_POLICY))
      expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(GOOGLE_ACCOUNT_POLICY)).toBe(true);
  });

  it("retains the reviewed account-only boundaries", () => {
    expect(GOOGLE_ACCOUNT_POLICY.scopes).toEqual(["openid", "email"]);
    expect(GOOGLE_ACCOUNT_POLICY.forbiddenParameters).toEqual([
      "token_relay_url",
      "resource_protocol",
      "mcp_endpoint",
      "mcp_transport",
      "mcp_post_endpoint",
    ]);
  });

  it("selects only explicitly marked account scopes", () => {
    expect(googleAccountPolicy({ oauth: [row] }).scopes).toEqual([
      "openid",
      "email",
    ]);
  });

  it("rejects missing or ambiguous policy and unsafe endpoints", () => {
    const cases: JsonValue[] = [
      { oauth: [] },
      { oauth: [row, row] },
      { oauth: [{ ...row, account_only_policy: null }] },
      { oauth: [{ ...row, token_endpoint: "https://{host}/token" }] },
      { oauth: [{ ...row, verify: { url: "https://other.example.test" } }] },
      {
        oauth: [
          {
            ...row,
            scopes: [
              { name: "openid", account_only: true },
              { name: "openid", account_only: true },
            ],
          },
        ],
      },
      {
        oauth: [
          {
            ...row,
            account_only_policy: {
              ...row.account_only_policy,
              scope_aliases: { constructor: "email" },
            },
          },
        ],
      },
      {
        oauth: [
          {
            ...row,
            account_only_policy: {
              ...row.account_only_policy,
              scope_aliases: { openid: "email" },
            },
          },
        ],
      },
      {
        oauth: [
          {
            ...row,
            account_only_policy: {
              ...row.account_only_policy,
              scope_aliases: { alias: "drive.readonly" },
            },
          },
        ],
      },
      {
        oauth: [
          {
            ...row,
            account_only_policy: {
              ...row.account_only_policy,
              forbidden_parameters: ["mcp_endpoint", "mcp_endpoint"],
            },
          },
        ],
      },
    ];
    for (const candidate of cases)
      expect(() => googleAccountPolicy(candidate)).toThrow();
  });

  it("does not normalize inherited names and still rejects broader grants", () => {
    expect(
      normalizeGoogleDriveAccountScopes("google-drive", [
        "constructor",
        "__proto__",
      ]),
    ).toEqual(["constructor", "__proto__"]);
    expect(
      isGoogleDriveAccountScopeSet("google-drive", [
        "openid",
        "email",
        "https://www.googleapis.com/auth/drive.readonly",
      ]),
    ).toBe(false);
    expect(isGoogleDriveAccountScopeSet("google-drive", null)).toBe(true);
  });
});
