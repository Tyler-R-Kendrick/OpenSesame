import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureSiopKey,
  getActivePublicIdentity,
  importSiopSigningKey,
  revokeSiopKey,
  rotateSiopKey,
} from "./siop-keys.js";
import { readFile, unlockTomb, writeFile } from "./vfs.js";

const subjectId = "local_11111111-1111-4111-8111-111111111111";
const applicationId = "local_22222222-2222-4222-8222-222222222222";
const otherApp = "local_33333333-3333-4333-8333-333333333333";

async function openTomb() {
  const tomb = `siop-keys-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  return tomb;
}

function stubLocks() {
  const tails = new Map<string, Promise<void>>();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", {
    locks: {
      request: async <T>(name: string, action: () => Promise<T>) => {
        const previous = tails.get(name) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        tails.set(
          name,
          previous
            .then(() => gate)
            .then(
              () => undefined,
              () => undefined,
            ),
        );
        await previous;
        try {
          return await action();
        } finally {
          release();
        }
      },
    },
  });
}

describe("siop-keys", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a pairwise public identity without exposing private JWK", async () => {
    stubLocks();
    const tomb = await openTomb();
    const identity = await ensureSiopKey(tomb, subjectId, applicationId);
    expect(identity.subjectId).toBe(subjectId);
    expect(identity.applicationId).toBe(applicationId);
    expect(identity.publicJwk.kty).toBe("EC");
    expect(identity.publicJwk).not.toHaveProperty("d");
    expect(JSON.stringify(identity)).not.toMatch(/"d"/);
    const again = await ensureSiopKey(tomb, subjectId, applicationId);
    expect(again.keyId).toBe(identity.keyId);
    const active = await getActivePublicIdentity(
      tomb,
      subjectId,
      applicationId,
    );
    expect(active?.keyId).toBe(identity.keyId);
  });

  it("never exposes private JWK material through public identity helpers", async () => {
    stubLocks();
    const tomb = await openTomb();
    const identity = await ensureSiopKey(tomb, subjectId, applicationId);
    const active = await getActivePublicIdentity(
      tomb,
      subjectId,
      applicationId,
    );
    for (const view of [identity, active]) {
      expect(view).not.toBeNull();
      if (!view) continue;
      const serialized = JSON.stringify(view);
      expect(serialized).not.toMatch(/"d"/);
      expect(serialized).not.toContain("privateJwkJson");
    }
    const vfsRaw = new TextDecoder().decode(
      await readFile(tomb, "config/siop-keys"),
    );
    expect(vfsRaw).toMatch(/privateJwkJson|encryptedPrivateJwk/);
    const stored = JSON.parse(vfsRaw);
    expect(stored).toEqual(
      expect.objectContaining({
        keys: expect.arrayContaining([
          expect.objectContaining({
            privateJwkJson: expect.stringMatching(/"d":/),
          }),
        ]),
      }),
    );
  });

  it("keeps distinct keys per application binding", async () => {
    stubLocks();
    const tomb = await openTomb();
    const a = await ensureSiopKey(tomb, subjectId, applicationId);
    const b = await ensureSiopKey(tomb, subjectId, otherApp);
    expect(a.keyId).not.toBe(b.keyId);
  });

  it("reads legacy encryptedPrivateJwk storage field", async () => {
    stubLocks();
    const tomb = await openTomb();
    await ensureSiopKey(tomb, subjectId, applicationId);
    const stored = JSON.parse(
      new TextDecoder().decode(await readFile(tomb, "config/siop-keys")),
    );
    const row = stored.keys[0];
    row.encryptedPrivateJwk = row.privateJwkJson;
    row.privateJwkJson = undefined;
    await writeFile(
      tomb,
      "config/siop-keys",
      new TextEncoder().encode(JSON.stringify(stored)),
    );
    const key = await importSiopSigningKey(tomb, subjectId, applicationId);
    expect(key.type).toBe("private");
  });

  it("imports a non-extractable signing key", async () => {
    stubLocks();
    const tomb = await openTomb();
    await ensureSiopKey(tomb, subjectId, applicationId);
    const key = await importSiopSigningKey(tomb, subjectId, applicationId);
    expect(key.type).toBe("private");
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("jwk", key)).rejects.toThrow();
  });

  it("rotates to a new active key and revokes the prior one", async () => {
    stubLocks();
    const tomb = await openTomb();
    const first = await ensureSiopKey(tomb, subjectId, applicationId);
    const rotated = await rotateSiopKey(tomb, subjectId, applicationId);
    expect(rotated.keyId).not.toBe(first.keyId);
    expect(
      (await getActivePublicIdentity(tomb, subjectId, applicationId))?.keyId,
    ).toBe(rotated.keyId);
    await revokeSiopKey(tomb, subjectId, applicationId);
    expect(
      await getActivePublicIdentity(tomb, subjectId, applicationId),
    ).toBeNull();
    await expect(
      importSiopSigningKey(tomb, subjectId, applicationId),
    ).rejects.toThrow(/unavailable/i);
  });
});
