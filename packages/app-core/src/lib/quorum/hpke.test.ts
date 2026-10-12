/**
 * RFC 9180 base mode: every intermediate value of Appendix A.1 and A.2, then
 * the properties a share release depends on (only the named recipient opens
 * it, and a changed AAD or `info` does not authenticate).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type HpkeAead,
  HpkeError,
  deriveKeyPair,
  exportSecret,
  generateKeyPair,
  keySchedule,
  nonceAt,
  openBase,
  sealBase,
  setupBaseRecipient,
  setupBaseSender,
} from "./hpke.js";

type Vector = Readonly<{
  name: string;
  aead_id: string;
  info: string;
  ikmE: string;
  pkEm: string;
  skEm: string;
  ikmR: string;
  pkRm: string;
  skRm: string;
  enc: string;
  shared_secret: string;
  key: string;
  base_nonce: string;
  exporter_secret: string;
  encryptions: readonly Readonly<{
    seq: number;
    pt: string;
    aad: string;
    nonce: string;
    ct: string;
  }>[];
  exports: readonly Readonly<{
    exporter_context: string;
    L: string;
    exported_value: string;
  }>[];
}>;

const file = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../spec/conformance/hpke-rfc9180-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const vectors: readonly Vector[] = file.vectors;

const bytes = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
const hex = (value: Uint8Array) =>
  [...value].map((b) => b.toString(16).padStart(2, "0")).join("");
const aeadOf = (id: string): HpkeAead =>
  id === "1" ? "aes-128-gcm" : "chacha20-poly1305";

describe("RFC 9180 Appendix A (base mode)", () => {
  it("carries both X25519 suites the module implements", () => {
    expect(vectors.map((v) => v.aead_id)).toEqual(["1", "3"]);
  });

  for (const v of vectors) {
    describe(v.name, () => {
      const aead = aeadOf(v.aead_id);

      it("derives the ephemeral and recipient key pairs from their ikm", () => {
        const e = deriveKeyPair(bytes(v.ikmE));
        expect(hex(e.secretKey)).toBe(v.skEm);
        expect(hex(e.publicKey)).toBe(v.pkEm);
        const r = deriveKeyPair(bytes(v.ikmR));
        expect(hex(r.secretKey)).toBe(v.skRm);
        expect(hex(r.publicKey)).toBe(v.pkRm);
      });

      it("reproduces enc, the shared secret and the key schedule on both sides", () => {
        const { enc, sender } = setupBaseSender({
          recipientPublicKey: bytes(v.pkRm),
          info: bytes(v.info),
          aead,
          ephemeral: deriveKeyPair(bytes(v.ikmE)),
        });
        expect(hex(enc)).toBe(v.enc);
        expect(hex(sender.sharedSecret)).toBe(v.shared_secret);
        expect(hex(sender.schedule.key)).toBe(v.key);
        expect(hex(sender.schedule.baseNonce)).toBe(v.base_nonce);
        expect(hex(sender.schedule.exporterSecret)).toBe(v.exporter_secret);

        const recipient = setupBaseRecipient({
          enc: bytes(v.enc),
          recipientSecretKey: bytes(v.skRm),
          info: bytes(v.info),
          aead,
        });
        expect(hex(recipient.sharedSecret)).toBe(v.shared_secret);
        expect(hex(recipient.schedule.key)).toBe(v.key);
      });

      it("derives the published nonce for every sequence number", () => {
        const schedule = keySchedule(
          aead,
          bytes(v.shared_secret),
          bytes(v.info),
        );
        for (const e of v.encryptions) {
          expect(hex(nonceAt(schedule, e.seq))).toBe(e.nonce);
        }
      });

      it("seals the published ciphertexts in order and opens them", () => {
        const { sender } = setupBaseSender({
          recipientPublicKey: bytes(v.pkRm),
          info: bytes(v.info),
          aead,
          ephemeral: deriveKeyPair(bytes(v.ikmE)),
        });
        const recipient = setupBaseRecipient({
          enc: bytes(v.enc),
          recipientSecretKey: bytes(v.skRm),
          info: bytes(v.info),
          aead,
        });
        // The RFC prints sequence numbers 0, 1, 2, 4, 255 and 256. A context
        // has one counter, so seal and open every message up to 256 in order
        // and compare the ciphertext wherever the RFC prints one.
        const printed = new Map(v.encryptions.map((e) => [e.seq, e]));
        const fallbackPt = bytes(v.encryptions[0]?.pt ?? "");
        for (let seq = 0; seq <= 256; seq += 1) {
          const expected = printed.get(seq);
          const pt = expected ? bytes(expected.pt) : fallbackPt;
          const aad = bytes(expected?.aad ?? "00");
          const ct = sender.seal(aad, pt);
          if (expected) expect(hex(ct)).toBe(expected.ct);
          expect(hex(recipient.open(aad, ct))).toBe(hex(pt));
        }
      });

      it("exports the published secrets", () => {
        const schedule = keySchedule(
          aead,
          bytes(v.shared_secret),
          bytes(v.info),
        );
        for (const e of v.exports) {
          expect(
            hex(
              exportSecret(
                aead,
                schedule,
                bytes(e.exporter_context),
                Number(e.L),
              ),
            ),
          ).toBe(e.exported_value);
        }
      });
    });
  }
});

describe("single-shot seal and open", () => {
  const recipient = generateKeyPair();
  const info = new TextEncoder().encode("opensesame/test");
  const aad = new TextEncoder().encode("request-digest");
  const plaintext = new TextEncoder().encode("a share, as 33 words");

  for (const aead of ["aes-128-gcm", "chacha20-poly1305"] as const) {
    it(`round-trips with ${aead}`, () => {
      const sealed = sealBase({
        recipientPublicKey: recipient.publicKey,
        info,
        aad,
        plaintext,
        aead,
      });
      const opened = openBase({
        recipientSecretKey: recipient.secretKey,
        ...sealed,
        info,
        aad,
        aead,
      });
      expect(hex(opened)).toBe(hex(plaintext));
    });
  }

  it("does not open for anyone but the named recipient", () => {
    const sealed = sealBase({
      recipientPublicKey: recipient.publicKey,
      info,
      aad,
      plaintext,
    });
    const other = generateKeyPair();
    expect(() =>
      openBase({
        recipientSecretKey: other.secretKey,
        ...sealed,
        info,
        aad,
      }),
    ).toThrow(HpkeError);
  });

  it("does not open under a different AAD, info, or AEAD", () => {
    const sealed = sealBase({
      recipientPublicKey: recipient.publicKey,
      info,
      aad,
      plaintext,
    });
    const base = { recipientSecretKey: recipient.secretKey, ...sealed };
    expect(() =>
      openBase({ ...base, info, aad: new TextEncoder().encode("another") }),
    ).toThrow(HpkeError);
    expect(() =>
      openBase({ ...base, info: new TextEncoder().encode("other"), aad }),
    ).toThrow(HpkeError);
    expect(() =>
      openBase({ ...base, info, aad, aead: "chacha20-poly1305" }),
    ).toThrow(HpkeError);
  });

  it("does not open a flipped bit", () => {
    const sealed = sealBase({
      recipientPublicKey: recipient.publicKey,
      info,
      aad,
      plaintext,
    });
    const flipped = sealed.ciphertext.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() =>
      openBase({
        recipientSecretKey: recipient.secretKey,
        enc: sealed.enc,
        ciphertext: flipped,
        info,
        aad,
      }),
    ).toThrow(HpkeError);
  });

  it("refuses a low-order public key (all-zero Diffie-Hellman output)", () => {
    expect(() =>
      sealBase({
        recipientPublicKey: new Uint8Array(32),
        info,
        aad,
        plaintext,
      }),
    ).toThrow();
  });

  it("uses a fresh ephemeral key for every seal", () => {
    const a = sealBase({
      recipientPublicKey: recipient.publicKey,
      info,
      aad,
      plaintext,
    });
    const b = sealBase({
      recipientPublicKey: recipient.publicKey,
      info,
      aad,
      plaintext,
    });
    expect(hex(a.enc)).not.toBe(hex(b.enc));
  });
});
