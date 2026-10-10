import { expect, it } from "vitest";
import { createNativeImplicitKey } from "./native-implicit-crypto.js";
import { captureNativeImplicitReturn } from "./native-implicit-return.js";
async function callback(provider: "discord" | "reddit" = "discord") {
  const { state } = await createNativeImplicitKey(provider, "n".repeat(43));
  const url = new URL("https://selfhost.example/auth/native-implicit.html");
  url.hash = new URLSearchParams({
    state,
    access_token: "observed-provider-access",
    token_type: "Bearer",
    expires_in: "3600",
    scope: "identify",
  }).toString();
  return url;
}
it("captures official fragment fields without putting bearer material into application URLs", async () => {
  const result = captureNativeImplicitReturn(await callback());
  expect(result.providerId).toBe("discord");
  expect(result.payload).toMatchObject({
    accessToken: "observed-provider-access",
    expiresIn: 3600,
    protocolValid: true,
  });
});
it("retains observed bearer on malformed expiry or token details for cleanup", async () => {
  const url = await callback();
  const fields = new URLSearchParams(url.hash.slice(1));
  fields.set("expires_in", "not-a-number");
  url.hash = fields.toString();
  expect(captureNativeImplicitReturn(url).payload).toMatchObject({
    accessToken: "observed-provider-access",
    expiresIn: null,
    protocolValid: false,
  });
});
it("rejects duplicate grant fields instead of selecting an ambiguous credential", async () => {
  const url = await callback();
  url.hash += "&access_token=other-access";
  expect(() => captureNativeImplicitReturn(url)).toThrow("Ambiguous");
});
it("captures encrypted denial independently of any bearer", async () => {
  const url = await callback("reddit");
  const fields = new URLSearchParams(url.hash.slice(1));
  fields.delete("access_token");
  fields.set("error", "access_denied");
  url.hash = fields.toString();
  expect(captureNativeImplicitReturn(url).payload).toEqual({ error: true });
});
