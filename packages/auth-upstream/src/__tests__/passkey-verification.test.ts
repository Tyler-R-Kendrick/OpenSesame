import { runInNewContext } from "node:vm";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, expect, it, vi } from "vitest";
import {
  type VerifyPasskeyAuthenticationInput,
  verifyPasskeyAuthentication,
} from "../passkey-verification.js";
import { simpleWebAuthnSeams } from "../simplewebauthn.js";

const original = simpleWebAuthnSeams.verifyAuthenticationResponse;
afterEach(() => {
  simpleWebAuthnSeams.verifyAuthenticationResponse = original;
});

function input(publicKey: Uint8Array): VerifyPasskeyAuthenticationInput {
  return {
    rp: { rpID: "example.test", origin: "https://example.test" },
    challenge: "challenge",
    response: overlapCast({}),
    credential: { credentialId: "credential", publicKey, counter: 0 },
  };
}

it("passes an owned snapshot of the exact enrolled key view", async () => {
  const backing = new Uint8Array([9, 1, 2, 9]);
  const publicKey = backing.subarray(1, 3);
  const verify = vi.fn(async (options: Parameters<typeof original>[0]) => {
    backing[1] = 8;
    await Promise.resolve();
    expect(options.credential.publicKey).toEqual(new Uint8Array([1, 2]));
    return { verified: true, authenticationInfo: { newCounter: 4 } };
  });
  simpleWebAuthnSeams.verifyAuthenticationResponse = overlapCast(verify);
  expect(await verifyPasskeyAuthentication(input(publicKey))).toBe(4);
  expect(verify).toHaveBeenCalledOnce();
});

it("rejects shared, spoofed and detached key views before invoking the verifier", async () => {
  const verify = vi.fn(async (_options: Parameters<typeof original>[0]) => ({
    verified: true,
    authenticationInfo: { newCounter: 4 },
  }));
  simpleWebAuthnSeams.verifyAuthenticationResponse = overlapCast(verify);
  const shared = new Uint8Array(new SharedArrayBuffer(2));
  Object.defineProperty(shared, "buffer", { value: new ArrayBuffer(2) });
  expect(await verifyPasskeyAuthentication(input(shared))).toBeNull();
  const detached = new Uint8Array([1, 2]);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  expect(await verifyPasskeyAuthentication(input(detached))).toBeNull();
  expect(verify).not.toHaveBeenCalled();
});

it("validates and snapshots the same enrolled key when its getter changes", async () => {
  const first = new Uint8Array([1, 2]);
  const second = new Uint8Array(new SharedArrayBuffer(2));
  second.set([9, 9]);
  const request = input(first);
  let reads = 0;
  Object.defineProperty(request.credential, "publicKey", {
    get() {
      reads += 1;
      return reads === 1 ? first : second;
    },
  });
  const verify = vi.fn(async (options: Parameters<typeof original>[0]) => {
    expect(options.credential.publicKey).toEqual(new Uint8Array([1, 2]));
    return { verified: true, authenticationInfo: { newCounter: 4 } };
  });
  simpleWebAuthnSeams.verifyAuthenticationResponse = overlapCast(verify);
  expect(await verifyPasskeyAuthentication(request)).toBe(4);
  expect(reads).toBe(1);
});

it("accepts a valid cross-realm key view", async () => {
  const verify = vi.fn(async (_options: Parameters<typeof original>[0]) => ({
    verified: true,
    authenticationInfo: { newCounter: 4 },
  }));
  simpleWebAuthnSeams.verifyAuthenticationResponse = overlapCast(verify);
  const foreign = runInNewContext(
    "new Uint8Array([9, 1, 2, 9]).subarray(1, 3)",
  );
  expect(await verifyPasskeyAuthentication(input(foreign))).toBe(4);
  const actual = verify.mock.calls[0]?.[0];
  expect(Array.from(actual?.credential.publicKey ?? [])).toEqual([1, 2]);
});
