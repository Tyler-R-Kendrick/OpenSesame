import { generateKeyPair } from "jose";
import { afterEach, expect, it } from "vitest";
import { readNativeConnector } from "./native-connector-store.js";
import { originFixture } from "./native-origin.test-support.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
it("rejects a bad Ed25519 signature even when the receipt kid exists in JWKS", async () => {
  const fixture = await originFixture();
  closes.push(fixture.close);
  const other = await generateKeyPair("Ed25519");
  fixture.state.receiptSigningKey = other.privateKey;
  const saved = await fixture.driver.configure(fixture.input);
  await expect(
    fixture.driver.authorize?.(saved.connectionId),
  ).rejects.toThrow();
  expect(fixture.state.appJwts).toEqual([]);
  expect(readNativeConnector(saved.connectionId)?.status).toBe("configuration");
});
