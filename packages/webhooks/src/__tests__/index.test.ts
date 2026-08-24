import { describe, expect, it } from "vitest";
import {
  TIMESTAMP_TOLERANCE_SECONDS,
  generateWebhookSecret,
  maskWebhookSecret,
  signWebhook,
  verifyWebhook,
} from "../index.js";

const NOW = 1_700_000_000;

describe("standard webhooks signing", () => {
  it("contract: a signed delivery verifies with the same secret", () => {
    const secret = generateWebhookSecret();
    const headers = signWebhook(secret, "msg_1", NOW, '{"a":1}');
    expect(headers["webhook-signature"].startsWith("v1,")).toBe(true);
    expect(verifyWebhook(secret, headers, '{"a":1}', NOW)).toBe(true);
  });

  it("adversarial: a changed payload does not verify", () => {
    // The signature binds bytes; a body edited in transit is a different
    // delivery, whatever its headers say.
    const secret = generateWebhookSecret();
    const headers = signWebhook(secret, "msg_1", NOW, '{"a":1}');
    expect(verifyWebhook(secret, headers, '{"a":2}', NOW)).toBe(false);
  });

  it("adversarial: another secret's signature does not verify", () => {
    const headers = signWebhook(generateWebhookSecret(), "msg_1", NOW, "{}");
    expect(verifyWebhook(generateWebhookSecret(), headers, "{}", NOW)).toBe(
      false,
    );
  });

  it("adversarial: a replay outside the tolerance window is refused", () => {
    // A valid signature is not enough: a delivery captured and replayed
    // later must age out, or "verified" means nothing about freshness.
    const secret = generateWebhookSecret();
    const headers = signWebhook(secret, "msg_1", NOW, "{}");
    const late = NOW + TIMESTAMP_TOLERANCE_SECONDS + 1;
    expect(verifyWebhook(secret, headers, "{}", late)).toBe(false);
    expect(
      verifyWebhook(secret, headers, "{}", NOW + TIMESTAMP_TOLERANCE_SECONDS),
    ).toBe(true);
  });

  it("adversarial: a garbage timestamp is refused, not thrown on", () => {
    const secret = generateWebhookSecret();
    const headers = signWebhook(secret, "msg_1", NOW, "{}");
    headers["webhook-timestamp"] = "not-a-number";
    expect(verifyWebhook(secret, headers, "{}", NOW)).toBe(false);
  });

  it("contract: rotation-style multi-signature headers verify on any match", () => {
    const secret = generateWebhookSecret();
    const headers = signWebhook(secret, "msg_1", NOW, "{}");
    headers["webhook-signature"] =
      `v1,AAAA ${headers["webhook-signature"]} v2,BBBB`;
    expect(verifyWebhook(secret, headers, "{}", NOW)).toBe(true);
  });

  it("contract: masking keeps the prefix and tail only", () => {
    const secret = generateWebhookSecret();
    const masked = maskWebhookSecret(secret);
    expect(masked.startsWith("whsec_")).toBe(true);
    expect(masked).not.toBe(secret);
    expect(masked.length).toBeLessThan(secret.length);
  });
});
