import { expect, it } from "vitest";
import { requiredBrowserOAuthProfile } from "./native-browser-oauth-profile.js";
import { parseNativeOAuthToken } from "./native-browser-oauth-token.js";

it.each([
  { expires_in: "invalid" },
  {
    scope: Array.from({ length: 257 }, (_, index) => `scope${index}`).join(" "),
  },
  { refresh_token: "malformed refresh value" },
])(
  "retains the known issued access credential while refusing malformed protocol metadata: %j",
  (invalid) => {
    const token = parseNativeOAuthToken(
      {
        access_token: "known-issued-access",
        refresh_token: "known-issued-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read_user",
        ...invalid,
      },
      requiredBrowserOAuthProfile("gitlab"),
    );
    expect(token.accessToken).toBe("known-issued-access");
    expect(token.protocolValid).toBe(false);
    expect(token.scopes).toBeNull();
  },
);
it("short-lived Dropbox browser profiles refuse an unexpected refresh grant while retaining the pair for cleanup", () => {
  const token = parseNativeOAuthToken(
    {
      access_token: "issued-access",
      refresh_token: "unexpected-refresh",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "account_info.read",
    },
    requiredBrowserOAuthProfile("dropbox"),
  );
  expect(token.refreshToken).toBe("unexpected-refresh");
  expect(token.protocolValid).toBe(false);
});
