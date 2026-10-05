import { expect, it } from "vitest";
import { openLocalEnvelope, sealLocalEnvelope } from "./local-envelope.js";

it("isolates local customer envelopes and rejects wrap/payload tampering", () => {
  const root = new Uint8Array(32).fill(7);
  const sealed = sealLocalEnvelope(root, "customer-a/session", "secret");
  expect(openLocalEnvelope(root, "customer-a/session", sealed)).toBe("secret");
  expect(sealLocalEnvelope(root, "customer-a/session", "secret")).not.toBe(
    sealed,
  );
  expect(openLocalEnvelope(root, "customer-b/session", sealed)).toBeNull();
  expect(
    openLocalEnvelope(new Uint8Array(32), "customer-a/session", sealed),
  ).toBeNull();
  const packed = Buffer.from(sealed.slice(6), "base64url");
  for (let index = 0; index < packed.length; index += 1) {
    const changed = Buffer.from(packed);
    changed[index] = (changed[index] ?? 0) ^ 1;
    expect(
      openLocalEnvelope(
        root,
        "customer-a/session",
        `osle1.${changed.toString("base64url")}`,
      ),
    ).toBeNull();
  }
  expect(
    openLocalEnvelope(root, "customer-a/session", "osle2.future"),
  ).toBeNull();
  expect(openLocalEnvelope(root, "customer-a/session", "osle1.AA")).toBeNull();
  expect(() =>
    sealLocalEnvelope(new Uint8Array(1), "customer", "secret"),
  ).toThrow();
});
