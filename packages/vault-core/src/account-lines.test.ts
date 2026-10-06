import { describe, expect, it } from "vitest";
import {
  apiKeyHeaderLine,
  bearerHeaderLine,
  credentialLine,
  headerName,
} from "./account-lines.js";
import type { AccountItem, LoginMethod } from "./account.js";

function account(methods: LoginMethod[]): AccountItem {
  return {
    id: "itm_a",
    kind: "account",
    name: "Service",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    deletedAt: null,
    username: "ada",
    uris: [],
    methods,
  };
}

const apiKey = (key: string, header = "X-Api-Key"): LoginMethod => ({
  id: "k",
  type: "api-key",
  key,
  header,
});
const token = (value: string): LoginMethod => ({
  id: "t",
  type: "token",
  token: value,
  expiresAt: "",
});
const password: LoginMethod = {
  id: "p",
  type: "password",
  generator: { id: "manual" },
  pepper: false,
  secret: "hunter2",
  changedAt: "2026-10-01T00:00:00Z",
};

describe("the header line a request takes", () => {
  it("names the header, a colon and a space, then the key", () => {
    expect(apiKeyHeaderLine("X-Api-Key", "sk_live_1")).toBe(
      "X-Api-Key: sk_live_1",
    );
    expect(apiKeyHeaderLine("api-key", "abc")).toBe("api-key: abc");
  });

  it("falls back to the usual header, drops a stray colon, and trims what was pasted", () => {
    expect(headerName("")).toBe("X-Api-Key");
    expect(headerName("   ")).toBe("X-Api-Key");
    expect(headerName(":")).toBe("X-Api-Key");
    expect(headerName(" X-Token : ")).toBe("X-Token");
    expect(apiKeyHeaderLine("X-Token:", " k\n")).toBe("X-Token: k");
  });

  it("sends a token as a bearer", () => {
    expect(bearerHeaderLine("abc.def")).toBe("Authorization: Bearer abc.def");
    expect(bearerHeaderLine(" abc \n")).toBe("Authorization: Bearer abc");
  });
});

describe("what copying an account without a password gives", () => {
  it("is its first API key's header line, before any token", () => {
    expect(credentialLine(account([token("t1"), apiKey("k1")]))).toBe(
      "X-Api-Key: k1",
    );
    expect(credentialLine(account([apiKey("k1", "X-Other")]))).toBe(
      "X-Other: k1",
    );
  });

  it("is a bearer line when there is only a token", () => {
    expect(credentialLine(account([token("t1")]))).toBe(
      "Authorization: Bearer t1",
    );
  });

  it("skips an empty key and falls to the token", () => {
    expect(credentialLine(account([apiKey("  "), token("t1")]))).toBe(
      "Authorization: Bearer t1",
    );
  });

  it("is nothing for an empty key and token, or no methods", () => {
    expect(credentialLine(account([apiKey(""), token("")]))).toBeNull();
    expect(credentialLine(account([]))).toBeNull();
  });

  it("is nothing when the account has a password: that is what copy gives", () => {
    expect(credentialLine(account([password, apiKey("k1")]))).toBeNull();
  });
});
