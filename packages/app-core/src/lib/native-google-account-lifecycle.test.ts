import { afterEach, describe, expect, it } from "vitest";
import { configureNativeOAuthClient } from "./native-oauth-client-config.js";
import { nativeOAuthClientFixture } from "./native-oauth-client.test-support.js";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

describe("Google account-only OAuth configuration", () => {
  it("refuses broader permissions before authorization", async () => {
    const fixture = await nativeOAuthClientFixture("none");
    closing.push(fixture.close);
    fixture.input.providerId = "google-drive";
    fixture.input.requestedScopes.user = [
      "openid",
      "email",
      "https://www.googleapis.com/auth/drive.readonly",
    ];
    Object.assign(fixture.input.parameters, {
      issuer: "https://accounts.google.com",
      authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      token_endpoint: "https://oauth2.googleapis.com/token",
      resource: "https://www.googleapis.com/oauth2/v3/userinfo",
    });
    await expect(
      configureNativeOAuthClient(fixture.input, fixture.owner),
    ).rejects.toMatchObject({ code: "scope" });
    expect(fixture.requests).toHaveLength(0);
  });
});
