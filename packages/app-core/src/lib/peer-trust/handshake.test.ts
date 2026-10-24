import { describe, expect, it } from "vitest";
import { exportSpkiB64, fingerprintOfSpki } from "./fingerprint.js";
import {
  ABSENT_DTLS,
  type SessionBinding,
  dtlsFingerprintFromSdp,
  randomNonce,
  sasFromBinding,
  signBinding,
  verifyBinding,
} from "./handshake.js";

interface TestKey {
  readonly privateKey: CryptoKey;
  readonly spkiB64: string;
  readonly fingerprint: string;
}

async function keypair(): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const spkiB64 = await exportSpkiB64(pair.publicKey);
  const der = Uint8Array.from(atob(spkiB64), (char) => char.charCodeAt(0));
  return {
    privateKey: pair.privateKey,
    spkiB64,
    fingerprint: await fingerprintOfSpki(der),
  };
}

function binding(
  ownerKey: string,
  joinerKey: string,
  ownerNonce: string,
  joinerNonce: string,
): SessionBinding {
  return {
    ownerKey,
    joinerKey,
    ownerDtls: ABSENT_DTLS,
    joinerDtls: ABSENT_DTLS,
    ownerNonce,
    joinerNonce,
  };
}

describe("session SAS", () => {
  it("differs for every session nonce", async () => {
    const owner = await keypair();
    const joiner = await keypair();
    const ownerNonce = randomNonce();
    const first = binding(
      owner.fingerprint,
      joiner.fingerprint,
      ownerNonce,
      randomNonce(),
    );
    const second = binding(
      owner.fingerprint,
      joiner.fingerprint,
      ownerNonce,
      randomNonce(),
    );
    const sasA = await sasFromBinding(first);
    const sasB = await sasFromBinding(second);
    expect(sasA).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(sasB).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(sasA).not.toBe(sasB);
    expect(await sasFromBinding(first)).toBe(sasA);
  });

  it("rejects a MITM key swap and changes the SAS", async () => {
    const owner = await keypair();
    const joiner = await keypair();
    const attacker = await keypair();
    const honest = binding(
      owner.fingerprint,
      joiner.fingerprint,
      randomNonce(),
      randomNonce(),
    );
    const signature = await signBinding(joiner.privateKey, honest);
    expect(signature).not.toBeNull();
    if (!signature) return;
    expect(await verifyBinding(joiner.spkiB64, signature, honest)).toBe(true);
    const swapped = { ...honest, joinerKey: attacker.fingerprint };
    expect(await verifyBinding(joiner.spkiB64, signature, swapped)).toBe(false);
    expect(await sasFromBinding(swapped)).not.toBe(
      await sasFromBinding(honest),
    );
    const resigned = await signBinding(attacker.privateKey, swapped);
    expect(resigned).not.toBeNull();
    if (!resigned) return;
    expect(await verifyBinding(attacker.spkiB64, resigned, swapped)).toBe(true);
    expect(await sasFromBinding(swapped)).not.toBe(
      await sasFromBinding(honest),
    );
  });

  it("reads a sha-256 DTLS fingerprint from SDP", () => {
    const hex = "ab".repeat(32);
    const grouped = hex.match(/.{2}/g)?.join(":") ?? "";
    const sdp = `v=0\r\na=fingerprint:SHA-256 ${grouped}\r\n`;
    expect(dtlsFingerprintFromSdp(sdp)).toBe(`sha-256 ${grouped}`);
    expect(dtlsFingerprintFromSdp("v=0\r\n")).toBe(ABSENT_DTLS);
  });
});
