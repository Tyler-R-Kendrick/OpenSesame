import { describe, expect, it } from "vitest";
import {
  issuedScopes,
  nativeOAuthProviderContract,
  nativeOAuthResourceRequest,
  tokenTypeAdmissible,
} from "./native-oauth-client-contract.js";

describe("the authorization request a provider's own contract asks for", () => {
  it.each([
    ["jira", { audience: "api.atlassian.com", prompt: "consent" }],
    ["notion", { owner: "user" }],
    ["reddit", { duration: "permanent" }],
    ["slack", { user_scope: "users:read" }],
  ])(
    "%s names the parameters its authorization endpoint requires",
    (id, params) => {
      expect(nativeOAuthProviderContract(id).authorizationParams).toEqual(
        params,
      );
    },
  );

  it("separates scopes the way the provider does", () => {
    expect(nativeOAuthProviderContract("slack").scopeSeparator).toBe(",");
    expect(nativeOAuthProviderContract("shopify").scopeSeparator).toBe(",");
    expect(nativeOAuthProviderContract("asana").scopeSeparator).toBe(" ");
  });

  it("is the plain contract for a service with no preset, such as an MCP-only provider", () => {
    expect(nativeOAuthProviderContract("no-such-provider")).toEqual({
      authorizationParams: {},
      scopeSeparator: " ",
      verify: null,
      tokenTypes: ["bearer"],
      tokenTypeOptional: false,
    });
  });
});

describe("the token types a provider issues", () => {
  it("admits bearer, any case, for every provider", () => {
    for (const id of ["asana", "box", "zoom"]) {
      const contract = nativeOAuthProviderContract(id);
      expect(tokenTypeAdmissible(contract, "Bearer")).toBe(true);
      expect(tokenTypeAdmissible(contract, "bearer")).toBe(true);
      expect(tokenTypeAdmissible(contract, undefined)).toBe(false);
      expect(tokenTypeAdmissible(contract, "mac")).toBe(false);
      expect(tokenTypeAdmissible(contract, "dpop")).toBe(false);
    }
  });

  it("admits Slack's bot and user tokens, which it presents as bearer tokens", () => {
    const slack = nativeOAuthProviderContract("slack");
    expect(tokenTypeAdmissible(slack, "bot")).toBe(true);
    expect(tokenTypeAdmissible(slack, "user")).toBe(true);
    expect(tokenTypeAdmissible(slack, "mac")).toBe(false);
  });

  it("admits a missing token type only for Shopify, whose offline token carries none", () => {
    expect(
      tokenTypeAdmissible(nativeOAuthProviderContract("shopify"), undefined),
    ).toBe(true);
    expect(
      tokenTypeAdmissible(nativeOAuthProviderContract("slack"), undefined),
    ).toBe(false);
  });
});

describe("the scopes a token answer names", () => {
  it("splits on spaces and on commas, once each", () => {
    expect(issuedScopes("read write read")).toEqual(["read", "write"]);
    expect(issuedScopes("chat:write,channels:read")).toEqual([
      "chat:write",
      "channels:read",
    ]);
    expect(issuedScopes("a, b  c")).toEqual(["a", "b", "c"]);
    expect(issuedScopes("")).toEqual([]);
  });
});

describe("the request that reads the account behind a token", () => {
  const token = "issued-token";

  it("is a plain bearer read at an address the preset does not name", () => {
    const request = nativeOAuthResourceRequest(
      nativeOAuthProviderContract("notion"),
      "https://elsewhere.example/v1/users/me",
      token,
    );
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
    // Notion's version header goes to Notion, never to a host a person typed.
    expect(request.headers.has("notion-version")).toBe(false);
  });

  it("carries Notion's version header at Notion's address", () => {
    const request = nativeOAuthResourceRequest(
      nativeOAuthProviderContract("notion"),
      "https://api.notion.com/v1/users/me",
      token,
    );
    expect(request.headers.get("notion-version")).toBe("2022-06-28");
    expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
  });

  it("posts monday's GraphQL query at monday's address", () => {
    const request = nativeOAuthResourceRequest(
      nativeOAuthProviderContract("monday"),
      "https://api.monday.com/v2",
      token,
    );
    expect(request.method).toBe("POST");
    expect(request.body).toContain("me {");
    expect(request.headers.get("content-type")).toBe("application/json");
  });

  it("presents Shopify's token in its own header at the shop the person typed, and plainly at any other path", () => {
    const contract = nativeOAuthProviderContract("shopify");
    const at = nativeOAuthResourceRequest(
      contract,
      "https://acme.myshopify.com/admin/oauth/access_scopes.json",
      token,
    );
    expect(at.headers.get("x-shopify-access-token")).toBe(token);
    expect(at.headers.has("authorization")).toBe(false);
    const elsewhere = nativeOAuthResourceRequest(
      contract,
      "https://acme.myshopify.com/admin/api/2025-01/shop.json",
      token,
    );
    expect(elsewhere.headers.has("x-shopify-access-token")).toBe(false);
    expect(elsewhere.headers.get("authorization")).toBe(`Bearer ${token}`);
  });
});
