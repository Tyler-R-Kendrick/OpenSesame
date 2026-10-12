import { expect, it } from "vitest";
import { readNativeGoogleRequest } from "./native-google-request.js";
import { createNativeImplicitKey } from "./native-implicit-crypto.js";
it("binds bounded Google page parameters to its encrypted receiver provider and deadline", async () => {
  const { state } = await createNativeImplicitKey("google", "n".repeat(32));
  const fragment = new URLSearchParams({
    clientId: "public-client",
    scopes: '["openid"]',
    state,
    expiresAt: "61000",
  }).toString();
  expect(readNativeGoogleRequest(fragment, 1000)).toMatchObject({
    clientId: "public-client",
    scopes: ["openid"],
    state,
    expiresAt: 61000,
  });
  expect(() => readNativeGoogleRequest(fragment, 61000)).toThrow("expired");
  expect(() =>
    readNativeGoogleRequest(`${fragment}&state=another`, 1000),
  ).toThrow("Invalid");
  expect(() => readNativeGoogleRequest(fragment, Number.NaN)).toThrow(
    "expired",
  );
});
it("rejects wrong-provider receiver and excessive authorization lifetime", async () => {
  const { state } = await createNativeImplicitKey("discord", "n".repeat(32));
  const params = new URLSearchParams({
    clientId: "public-client",
    scopes: '["openid"]',
    state,
    expiresAt: "61000",
  });
  expect(() => readNativeGoogleRequest(params.toString(), 1000)).toThrow(
    "mismatched",
  );
  const google = await createNativeImplicitKey("google", "n".repeat(32));
  params.set("state", google.state);
  params.set("expiresAt", "601002");
  expect(() => readNativeGoogleRequest(params.toString(), 1000)).toThrow(
    "expired",
  );
});
