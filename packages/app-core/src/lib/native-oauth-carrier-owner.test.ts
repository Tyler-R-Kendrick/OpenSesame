import { afterEach, expect, it } from "vitest";
import { nativeBrowserOAuthPolicy } from "./native-browser-policy.js";
import { nativeOAuthCarrierFixture } from "./native-oauth-carrier.test-support.js";
import {
  assertNativeOAuthClientPolicy,
  beginNativeOAuthClient,
  configureNativeOAuthClient,
} from "./native-oauth-client-config.js";
import { nativeOAuthClientFixture } from "./native-oauth-client.test-support.js";
const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});
it("configures and begins a browser-refused provider only through the one captured carrier covering both exact targets", async () => {
  const f = await nativeOAuthCarrierFixture();
  closing.push(f.close);
  expect(nativeBrowserOAuthPolicy("resend").available).toBe(false);
  const saved = await configureNativeOAuthClient(f.input, f.owner);
  expect(
    assertNativeOAuthClientPolicy(saved.configuration, f.owner).resource,
  ).toBe(f.state.resource);
  expect(
    new URL(await beginNativeOAuthClient(saved.connectionId, f.owner)).origin,
  ).toBe(new URL(f.state.resource).origin);
  expect(f.owner.transport.signal).toBe(f.sourceSignal);
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.owner.transport.supportsNativeOrigin).toBeTypeOf("function");
  expect(f.requests).toEqual([]);
});
it("keeps ordinary direct transport and incomplete configured native target coverage refused before custody or network", async () => {
  const direct = await nativeOAuthClientFixture();
  closing.push(direct.close);
  await expect(
    configureNativeOAuthClient(
      { ...direct.input, providerId: "resend" },
      direct.owner,
    ),
  ).rejects.toThrow();
  expect(direct.requests).toEqual([]);
  const f = await nativeOAuthCarrierFixture();
  closing.push(f.close);
  for (const resource of [undefined, "https://unapproved.example/resource"]) {
    const withoutResource = Object.fromEntries(
      Object.entries(f.input.parameters).filter(([key]) => key !== "resource"),
    );
    const parameters =
      resource === undefined
        ? withoutResource
        : { ...withoutResource, resource };
    await expect(
      configureNativeOAuthClient({ ...f.input, parameters }, f.owner),
    ).rejects.toThrow();
  }
  expect(f.requests).toEqual([]);
  expect(f.capture).toHaveBeenCalledTimes(1);
});
it.each(["authorization", "route", "owner"] as const)(
  "an original %s withdrawal cannot be revived by a later policy projection",
  async (cause) => {
    const f = await nativeOAuthCarrierFixture();
    closing.push(f.close);
    const saved = await configureNativeOAuthClient(f.input, f.owner);
    if (cause === "authorization") f.authorization.abort();
    else if (cause === "route") f.withdrawRoute();
    else f.controller.abort();
    await expect(
      beginNativeOAuthClient(saved.connectionId, f.owner),
    ).rejects.toThrow();
    expect(() =>
      assertNativeOAuthClientPolicy(saved.configuration, f.owner),
    ).toThrow();
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(f.requests).toEqual([]);
  },
);
