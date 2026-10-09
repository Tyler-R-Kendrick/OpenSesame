import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { EventSealError, createEventSealer } from "../src/event-seal.js";

const secret = "event tag compatibility fixture deployment secret";
const scope = "customer-a";
const purpose = "audit_events.metadata:record";
const value = { note: "previous envelope".repeat(8) };
const sealer = createEventSealer(secret);
const key = Buffer.from(
  hkdfSync("sha256", secret, "", "opensesame:event-seal:v1", 32),
);

/** Write the original format, whose cipher relied on Node's default full tag. */
function encrypt(secret: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(aad);
  return Buffer.concat([
    iv,
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

function legacyEnvelope(): Buffer {
  return encrypt(
    key,
    Buffer.from(JSON.stringify(value)),
    Buffer.from("audit_events.metadata"),
  );
}

function currentEnvelope(): Buffer {
  const kek = Buffer.from(
    hkdfSync("sha256", key, scope, "opensesame:event-envelope:v2", 32),
  );
  const dataKey = randomBytes(32);
  const aad = Buffer.from(JSON.stringify([scope, purpose]));
  return Buffer.concat([
    encrypt(kek, dataKey, aad),
    encrypt(dataKey, Buffer.from(JSON.stringify(value)), aad),
  ]);
}

it("retains compatibility with default-tag osev1 migration and osev2 envelopes", () => {
  expect(
    sealer.openLegacyForMigration(
      purpose,
      { $sealed: `osev1.${legacyEnvelope().toString("base64url")}` },
      scope,
    ),
  ).toEqual(value);
  expect(
    sealer.openCurrent(
      purpose,
      { $sealed: `osev2.${currentEnvelope().toString("base64url")}` },
      scope,
    ),
  ).toEqual(value);
});

it.each([1, 4, 8, 12])(
  "rejects a legacy authentication tag shortened by %i bytes",
  (removed) => {
    const body = legacyEnvelope().subarray(0, -removed);
    expect(() =>
      sealer.openLegacyForMigration(
        purpose,
        { $sealed: `osev1.${body.toString("base64url")}` },
        scope,
      ),
    ).toThrow(EventSealError);
  },
);

it.each([1, 4, 8, 12])(
  "rejects tags shortened by %i bytes in either current envelope layer",
  (removed) => {
    const body = currentEnvelope();
    const shortenedPayload = body.subarray(0, -removed);
    const shortenedWrap = Buffer.concat([
      body.subarray(0, 60 - removed),
      body.subarray(60),
    ]);
    for (const packed of [shortenedPayload, shortenedWrap]) {
      expect(() =>
        sealer.openCurrent(
          purpose,
          { $sealed: `osev2.${packed.toString("base64url")}` },
          scope,
        ),
      ).toThrow(EventSealError);
    }
  },
);
