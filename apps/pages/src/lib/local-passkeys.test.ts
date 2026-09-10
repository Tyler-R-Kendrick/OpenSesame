import {
  b64urlToBytes,
  bytesToB64url,
  sha256Base64Url,
} from "@opensesame/sdk-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readLocalPasskeys,
  revokeLocalPasskey,
  writeLocalPasskeys,
} from "./local-credentials.js";
import { changeLocalDirectory } from "./local-directory.js";
import {
  authenticateLocalPasskey,
  consumeLocalAuthentication,
  enrollLocalPasskey,
} from "./local-passkeys.js";
import { mintVaultKey } from "./vault/crypto.js";
import { vaultStore } from "./vault/store.js";
import { lockAllTombs, unlockTomb, vfsSeams } from "./vfs.js";

import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";

let tomb: string;
let principalId: string;
let vaultKey: CryptoKey;
let device: Awaited<ReturnType<typeof authenticator>>;
beforeEach(async () => {
  tomb = `iam-${crypto.randomUUID()}`;
  vaultKey = (await mintVaultKey()).vaultKey;
  unlockTomb(tomb, vaultKey);
  device = await authenticator();
  let queue = Promise.resolve();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin, hostname: rpID });
  vi.stubGlobal("navigator", {
    credentials: device,
    locks: {
      request: <T>(_name: string, run: () => Promise<T>) => {
        const next = queue.then(run);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  const directory = await changeLocalDirectory(tomb, 0, {
    action: "create",
    kind: "person",
    name: "Local person",
  });
  const person = directory.entries[0];
  if (!person) throw new Error("No person");
  principalId = person.id;
});
afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser local identity passkeys using real cryptographic verification", () => {
  it("the authenticator signs a domain-separated commitment to the request and fresh nonce", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const random = vi.spyOn(crypto, "getRandomValues");
    const get = vi.spyOn(device, "get");
    const digest = "A".repeat(43);
    await authenticateLocalPasskey(tomb, principalId, digest);
    const nonce = random.mock.calls[0]?.[0];
    if (!nonce) throw new Error("Missing ceremony nonce");
    const expected = await sha256Base64Url(
      JSON.stringify([
        "opensesame:local-approval:v1",
        bytesToB64url(
          new Uint8Array(nonce.buffer, nonce.byteOffset, nonce.byteLength),
        ),
        digest,
      ]),
    );
    expect(get.mock.calls[0]?.[0].publicKey?.challenge).toEqual(
      b64urlToBytes(expected),
    );
  });

  it("consumes request-bound evidence only once for the exact decision digest", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const digest = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
    const evidence = await authenticateLocalPasskey(tomb, principalId, digest);
    expect(evidence.requestDigest).toBe(digest);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(() => consumeLocalAuthentication({ ...evidence }, digest)).toThrow(
      "no longer valid",
    );
    expect(consumeLocalAuthentication(evidence, digest)).toBe(evidence);
    expect(() => consumeLocalAuthentication(evidence, digest)).toThrow(
      "no longer valid",
    );
  });

  it("burns a proof presented for another request and cannot reuse it for sign-in", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const evidence = await authenticateLocalPasskey(
      tomb,
      principalId,
      "A".repeat(43),
    );
    expect(() =>
      consumeLocalAuthentication(evidence, "B".repeat(43)),
    ).toThrow();
    expect(() =>
      consumeLocalAuthentication(evidence, "A".repeat(43)),
    ).toThrow();
    const next = await authenticateLocalPasskey(
      tomb,
      principalId,
      "A".repeat(43),
    );
    expect(() => consumeLocalAuthentication(next)).toThrow();
    const signIn = await authenticateLocalPasskey(tomb, principalId);
    expect(() => consumeLocalAuthentication(signIn, "A".repeat(43))).toThrow();
  });

  it("refuses malformed request digests before opening the authenticator", async () => {
    const get = vi.spyOn(device, "get");
    for (const digest of ["", "short", "A".repeat(44), "/".repeat(43)])
      await expect(
        authenticateLocalPasskey(tomb, principalId, digest),
      ).rejects.toThrow("digest is invalid");
    expect(get).not.toHaveBeenCalled();
  });

  it("invalidates request approval across vault lock and reopening", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const digest = "A".repeat(43);
    const evidence = await authenticateLocalPasskey(tomb, principalId, digest);
    vaultStore.lock();
    unlockTomb(tomb, vaultKey);
    expect(() => consumeLocalAuthentication(evidence, digest)).toThrow(
      "no longer valid",
    );
  });

  it("expires evidence on the monotonic clock even when wall time stands still", async () => {
    await enrollLocalPasskey(tomb, principalId);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const evidence = await authenticateLocalPasskey(
      tomb,
      principalId,
      "A".repeat(43),
    );
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 120_001);
    expect(() => consumeLocalAuthentication(evidence, "A".repeat(43))).toThrow(
      "no longer valid",
    );
  });

  it("refuses a request proof whose ceremony crosses a lock and reopening", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const get = device.get.bind(device);
    vi.spyOn(device, "get").mockImplementation(async (options) => {
      const response = await get(options);
      vaultStore.lock();
      unlockTomb(tomb, vaultKey);
      return response;
    });
    await expect(
      authenticateLocalPasskey(tomb, principalId, "A".repeat(43)),
    ).rejects.toThrow("no longer valid");
  });

  it("cannot replay a signed request assertion for another decision", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const get = device.get.bind(device);
    let response: Awaited<ReturnType<typeof device.get>> | undefined;
    vi.spyOn(device, "get").mockImplementation(async (options) => {
      response ??= await get(options);
      return response;
    });
    await authenticateLocalPasskey(tomb, principalId, "A".repeat(43));
    await expect(
      authenticateLocalPasskey(tomb, principalId, "B".repeat(43)),
    ).rejects.toThrow("proof was refused");
    expect((await readLocalPasskeys(tomb))[0]?.counter).toBe(1);
  });

  it("refuses an oversized credential update without replacing valid records", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const original = await readLocalPasskeys(tomb);
    const oversized = Array.from({ length: 500 }, () => ({
      principalId,
      credentialId: bytesToB64url(crypto.getRandomValues(new Uint8Array(32))),
      publicKeyB64: "A".repeat(8192),
      counter: 0,
      createdAt: Date.now(),
    }));
    const write = vi.spyOn(vfsSeams, "writeRaw");
    await expect(writeLocalPasskeys(tomb, oversized)).rejects.toThrow(
      "exceeds its limit",
    );
    expect(write).not.toHaveBeenCalled();
    expect(await readLocalPasskeys(tomb)).toEqual(original);
  });

  it("enrolls, authenticates, advances the counter, and revokes without a backend", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const result = await authenticateLocalPasskey(tomb, principalId);
    expect(result.principalId).toBe(principalId);
    expect(result.amr).toEqual(["webauthn", "user_verification"]);
    expect((await readLocalPasskeys(tomb))[0]?.counter).toBe(1);
    await revokeLocalPasskey(tomb, principalId, result.credentialId);
    await expect(authenticateLocalPasskey(tomb, principalId)).rejects.toThrow(
      "Enroll a passkey",
    );
  });

  it.each(["wrongOrigin", "wrongChallenge", "badSignature"] as const)(
    "rejects %s",
    async (fault) => {
      await enrollLocalPasskey(tomb, principalId);
      device.control[fault] = true;
      await expect(authenticateLocalPasskey(tomb, principalId)).rejects.toThrow(
        "proof was refused",
      );
      expect((await readLocalPasskeys(tomb))[0]?.counter).toBe(0);
    },
  );

  it("requires user verification at enrollment and authentication", async () => {
    device.control.userVerified = false;
    await expect(enrollLocalPasskey(tomb, principalId)).rejects.toThrow(
      "could not be verified",
    );
    device.control.userVerified = true;
    await enrollLocalPasskey(tomb, principalId);
    device.control.userVerified = false;
    await expect(authenticateLocalPasskey(tomb, principalId)).rejects.toThrow(
      "proof was refused",
    );
  });

  it("rechecks disablement after the authenticator ceremony", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const get = device.get.bind(device);
    vi.spyOn(device, "get").mockImplementation(async (options) => {
      const response = await get(options);
      await changeLocalDirectory(tomb, 1, {
        action: "update",
        id: principalId,
        name: "Local person",
        enabled: false,
      });
      return response;
    });
    await expect(authenticateLocalPasskey(tomb, principalId)).rejects.toThrow(
      "disabled",
    );
    expect((await readLocalPasskeys(tomb))[0]?.counter).toBe(0);
  });

  it("rechecks revocation after the authenticator ceremony", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const get = device.get.bind(device);
    vi.spyOn(device, "get").mockImplementation(async (options) => {
      const response = await get(options);
      await revokeLocalPasskey(tomb, principalId, response.id);
      return response;
    });
    await expect(authenticateLocalPasskey(tomb, principalId)).rejects.toThrow(
      "revoked",
    );
  });

  it("rejects an old signed response in a new ceremony", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const get = device.get.bind(device);
    let response: Awaited<ReturnType<typeof device.get>> | undefined;
    vi.spyOn(device, "get").mockImplementation(async (options) => {
      response ??= await get(options);
      return response;
    });
    await authenticateLocalPasskey(tomb, principalId);
    await expect(authenticateLocalPasskey(tomb, principalId)).rejects.toThrow(
      "proof was refused",
    );
    expect((await readLocalPasskeys(tomb))[0]?.counter).toBe(1);
  });

  it("expires a ceremony while the authenticator is open", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const get = device.get.bind(device);
    vi.spyOn(device, "get").mockImplementation(async (options) => {
      const response = await get(options);
      const late = Date.now() + 120_001;
      vi.spyOn(Date, "now").mockReturnValue(late);
      return response;
    });
    await expect(authenticateLocalPasskey(tomb, principalId)).rejects.toThrow(
      "expired",
    );
  });

  it("returns no authentication success when the counter write fails", async () => {
    await enrollLocalPasskey(tomb, principalId);
    vi.spyOn(vfsSeams, "writeRaw").mockRejectedValueOnce(
      new Error("disk unavailable"),
    );
    await expect(authenticateLocalPasskey(tomb, principalId)).rejects.toThrow(
      "disk unavailable",
    );
    expect((await readLocalPasskeys(tomb))[0]?.counter).toBe(0);
  });

  it("refuses a locked vault and a non-person record", async () => {
    const directory = await changeLocalDirectory(tomb, 1, {
      action: "create",
      kind: "agent",
      name: "Agent",
    });
    const agent = directory.entries.find((entry) => entry.kind === "agent");
    if (!agent) throw new Error("No agent");
    await expect(enrollLocalPasskey(tomb, agent.id)).rejects.toThrow(
      "unavailable",
    );
    lockAllTombs();
    await expect(enrollLocalPasskey(tomb, principalId)).rejects.toMatchObject({
      code: "locked",
    });
  });
});
