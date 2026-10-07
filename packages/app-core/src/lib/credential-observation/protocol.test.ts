import { afterEach, describe, expect, it, vi } from "vitest";
import vectors from "./protocol-vectors.json";
import {
  metadataSchema,
  packageBody,
  packageSchema,
  parseObservationReceiverProvision,
} from "./protocol.js";
import {
  acknowledgeObservation,
  openObservation,
  sealObservation,
  verifyObservationAcknowledgement,
} from "./seal.js";
import { publicVectorProvision } from "./vector-test-support.js";
const provision = publicVectorProvision();
const metadata = metadataSchema.parse(vectors.metadata);
const packet = packageSchema.parse(vectors.packet);
afterEach(() => vi.useRealTimers());
describe("independently sealed credential observation protocol", () => {
  it("matches native AES-GCM/HMAC golden vector including exact property order", async () => {
    const now = Date.parse(vectors.packet.issuedAt);
    vi.useFakeTimers({ now });
    expect(packageBody(packet)).toBe(vectors.packageBody);
    expect(
      await openObservation(JSON.stringify(vectors.packet), provision, now),
    ).toEqual(metadata);
    const ack = await acknowledgeObservation(packet, provision, now + 1000);
    expect(ack).toEqual(vectors.ack);
    await verifyObservationAcknowledgement(
      JSON.stringify(ack),
      packet,
      provision,
    );
  });
  it("seals fresh nonces and contains no plaintext event or vault identity on wire", async () => {
    const now = Date.parse(metadata.at);
    vi.useFakeTimers({ now });
    const first = await sealObservation(metadata, provision, now);
    const second = await sealObservation(metadata, provision, now);
    expect(first.packageId).not.toBe(second.packageId);
    expect(first.nonceB64).not.toBe(second.nonceB64);
    expect(first.ciphertextB64).not.toBe(second.ciphertextB64);
    expect(JSON.stringify(first)).not.toContain(metadata.vaultIdentity);
    expect(JSON.stringify(first)).not.toContain("retired_credential_observed");
    expect(
      await openObservation(JSON.stringify(first), provision, now),
    ).toEqual(metadata);
  });
  it("rejects changed recipient, epoch, ciphertext, MAC, nonce and expired delivery", async () => {
    const now = Date.parse(metadata.at);
    for (const change of [
      { bindingId: "other" },
      { receiverId: "other" },
      { keyEpoch: 8 },
      { ciphertextB64: `A${vectors.packet.ciphertextB64.slice(1)}` },
      { macB64: `A${vectors.packet.macB64.slice(1)}` },
      { nonceB64: "AAAAAAAAAAAAAAAAAAAAAA==" },
    ])
      await expect(
        openObservation(
          JSON.stringify({ ...vectors.packet, ...change }),
          provision,
          now,
        ),
      ).rejects.toThrow();
    await expect(
      openObservation(
        JSON.stringify(vectors.packet),
        {
          ...provision,
          independentKeyMaterialB64: Buffer.alloc(64, 99).toString("base64"),
        },
        now,
      ),
    ).rejects.toThrow();
    await expect(
      openObservation(
        JSON.stringify(vectors.packet),
        provision,
        Date.parse(provision.expiresAt),
      ),
    ).rejects.toThrow();
  });
  it("accepts only paired fixed HTTPS or explicitly approved strict loopback origins", () => {
    for (const origin of [
      "https://receiver.example/path",
      "https://a:b@receiver.example",
      "http://receiver.example",
      "http://127.0.0.1.example",
      "https://receiver.example/",
    ])
      expect(() =>
        parseObservationReceiverProvision(
          JSON.stringify({ ...provision, origin, allowLoopback: true }),
        ),
      ).toThrow("Invalid observation receiver provision.");
    for (const origin of [
      "http://localhost:18791",
      "http://127.0.0.1:18791",
      "http://[::1]:18791",
    ])
      expect(
        parseObservationReceiverProvision(
          JSON.stringify({ ...provision, origin, allowLoopback: true }),
        ).origin,
      ).toBe(origin);
    const secret = "sensitive-provisioning-fragment";
    expect(() =>
      parseObservationReceiverProvision(`{"secret":"${secret}`),
    ).toThrow("Invalid observation receiver provision.");
    try {
      parseObservationReceiverProvision(`{"secret":"${secret}`);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(() =>
      metadataSchema.parse({ ...metadata, rawPassword: secret }),
    ).toThrow();
    expect(() =>
      metadataSchema.parse({
        ...metadata,
        event: { type: "receiver_test", url: "https://other.example" },
      }),
    ).toThrow();
  });
  it("requires exact authenticated ACK package binding and freshness", async () => {
    vi.useFakeTimers({ now: Date.parse(metadata.at) });
    for (const change of [
      { packageId: crypto.randomUUID() },
      { bindingId: "other" },
      { keyEpoch: 0 },
      { acceptedAt: "2026-10-08T00:00:00.000Z" },
      { macB64: Buffer.alloc(32).toString("base64") },
    ])
      await expect(
        verifyObservationAcknowledgement(
          JSON.stringify({ ...vectors.ack, ...change }),
          packet,
          provision,
        ),
      ).rejects.toThrow();
  });
});
