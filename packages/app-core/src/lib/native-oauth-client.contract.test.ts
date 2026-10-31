import { afterEach, describe, expect, it } from "vitest";
import {
  beginNativeOAuthClient,
  configureNativeOAuthClient,
} from "./native-oauth-client-config.js";
import { exchangeNativeOAuthClient } from "./native-oauth-client-exchange.js";
import { nativeOAuthClientFixture } from "./native-oauth-client.test-support.js";
import { requireNativeOAuthRecord } from "./native-oauth-session.js";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

/** What the fixture provider answers with, where it differs from the plain contract. */
type TokenAnswer = {
  scope?: string;
  tokenType?: string | null;
  expiresAsText?: boolean;
};

/** A configured client for a provider whose preset names a contract of its own (ADR 0217). */
async function setup(
  providerId: string,
  requested: readonly string[],
  answer: TokenAnswer = {},
) {
  const fixture = await nativeOAuthClientFixture("client_secret_post");
  closing.push(fixture.close);
  fixture.input.providerId = providerId;
  fixture.input.requestedScopes.user = [...requested];
  fixture.state.scope = answer.scope ?? requested.join(" ");
  if (answer.tokenType !== undefined)
    fixture.state.tokenType = answer.tokenType;
  if (answer.expiresAsText) fixture.state.expiresAsText = true;
  const saved = await configureNativeOAuthClient(fixture.input, fixture.owner);
  const authorization = new URL(
    await beginNativeOAuthClient(saved.connectionId, fixture.owner),
  );
  fixture.state.challenge =
    authorization.searchParams.get("code_challenge") ?? "";
  const search = new URLSearchParams({
    native_state: authorization.searchParams.get("state") ?? "",
    native_code: "one-use-code",
  }).toString();
  return { ...fixture, saved, authorization, search };
}

describe("the authorization request names what the provider's contract asks for", () => {
  it("adds Atlassian's audience and consent prompt, and nothing the flow already set", async () => {
    const f = await setup("jira", ["read:me", "offline_access"]);
    expect(f.authorization.searchParams.get("audience")).toBe(
      "api.atlassian.com",
    );
    expect(f.authorization.searchParams.get("prompt")).toBe("consent");
    expect(f.authorization.searchParams.get("scope")).toBe(
      "read:me offline_access",
    );
    expect(f.authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
  });

  it("separates Slack's scopes with commas and asks for its user scope", async () => {
    const f = await setup("slack", ["chat:write", "channels:read"]);
    expect(f.authorization.searchParams.get("scope")).toBe(
      "chat:write,channels:read",
    );
    expect(f.authorization.searchParams.get("user_scope")).toBe("users:read");
  });

  it("sends no scope at all for a provider that takes none (Notion)", async () => {
    const f = await setup("notion", []);
    expect(f.authorization.searchParams.has("scope")).toBe(false);
    expect(f.authorization.searchParams.get("owner")).toBe("user");
  });

  it("sends a provider with no preset the plain request it always had", async () => {
    const f = await setup("byo-oauth", ["read:items"]);
    expect(f.authorization.searchParams.get("scope")).toBe("read:items");
    expect(f.authorization.searchParams.has("audience")).toBe(false);
    expect(f.authorization.searchParams.has("owner")).toBe(false);
  });
});

describe("the token answer is read as the provider gives it", () => {
  it("accepts Slack's bot token with comma-separated scopes", async () => {
    const f = await setup("slack", ["chat:write", "channels:read"], {
      scope: "chat:write,channels:read",
      tokenType: "bot",
    });
    const receipt = await exchangeNativeOAuthClient(f.search, f.owner);
    const grant = requireNativeOAuthRecord(
      receipt.connectionId,
    ).privateState.recovery.find(
      (entry) => entry.id === receipt.intentId,
    )?.grant;
    expect(grant?.scopes).toEqual(["chat:write", "channels:read"]);
  });

  it("accepts a token with no type only where the provider's contract has none (Shopify)", async () => {
    const shopify = await setup("shopify", ["read_products"], {
      scope: "read_products",
      tokenType: null,
    });
    await expect(
      exchangeNativeOAuthClient(shopify.search, shopify.owner),
    ).resolves.toMatchObject({ connectionId: shopify.saved.connectionId });
    const other = await setup("asana", ["read:items"], { tokenType: null });
    await expect(
      exchangeNativeOAuthClient(other.search, other.owner),
    ).rejects.toMatchObject({ code: "provider" });
  });

  it("accepts an expiry the provider gives as a numeric string", async () => {
    const f = await setup("box", ["read:items"], { expiresAsText: true });
    const receipt = await exchangeNativeOAuthClient(f.search, f.owner);
    const grant = requireNativeOAuthRecord(
      receipt.connectionId,
    ).privateState.recovery.find(
      (entry) => entry.id === receipt.intentId,
    )?.grant;
    expect(grant?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("still refuses a token type that is not a bearer token", async () => {
    const f = await setup("slack", ["chat:write"], { tokenType: "mac" });
    await expect(
      exchangeNativeOAuthClient(f.search, f.owner),
    ).rejects.toMatchObject({ code: "provider" });
  });
});
