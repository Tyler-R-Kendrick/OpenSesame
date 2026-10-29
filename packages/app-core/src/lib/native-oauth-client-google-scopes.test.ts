import { afterEach, describe, expect, it } from "vitest";
import {
  beginNativeOAuthClient,
  configureNativeOAuthClient,
} from "./native-oauth-client-config.js";
import { issued } from "./native-oauth-client-exchange.js";
import { nativeOAuthClientFixture } from "./native-oauth-client.test-support.js";
import { requireNativeOAuthRecord } from "./native-oauth-session.js";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

async function pendingUser() {
  const fixture = await nativeOAuthClientFixture("none");
  closing.push(fixture.close);
  const saved = await configureNativeOAuthClient(fixture.input, fixture.owner);
  await beginNativeOAuthClient(saved.connectionId, fixture.owner);
  const pending = requireNativeOAuthRecord(saved.connectionId).privateState
    .pending.user;
  if (!pending) throw new Error("Missing pending");
  return pending;
}

describe("Google account-only scope handling at token exchange", () => {
  it("retains an over-scoped Google token response as protocol-invalid", async () => {
    const pending = await pendingUser();
    const receipt = issued(
      {
        access_token: "issued-access-1",
        refresh_token: "issued-refresh-1",
        token_type: "Bearer",
        scope: "openid email https://www.googleapis.com/auth/drive.readonly",
      },
      200,
      { ...pending, providerId: "google-drive" },
    );
    expect(receipt.valid).toBe(false);
    expect(receipt.grant).toMatchObject({
      accessToken: "issued-access-1",
      refreshToken: "issued-refresh-1",
    });
  });

  it("accepts Google's documented URL-form email scope without granting Drive access", async () => {
    const pending = await pendingUser();
    const receipt = issued(
      {
        access_token: "issued-access-1",
        refresh_token: "issued-refresh-1",
        token_type: "Bearer",
        scope: "openid https://www.googleapis.com/auth/userinfo.email",
      },
      200,
      { ...pending, providerId: "google-drive", scopes: ["openid", "email"] },
    );
    expect(receipt.valid).toBe(true);
    expect(receipt.grant.scopes).toEqual(["openid", "email"]);
  });
});
