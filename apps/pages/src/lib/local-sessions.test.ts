import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";
import { readLocalPasskeys, revokeLocalPasskey } from "./local-credentials.js";
import { changeLocalDirectory, readLocalDirectory } from "./local-directory.js";
import {
  authenticateLocalPasskey,
  consumeLocalAuthentication,
  enrollLocalPasskey,
} from "./local-passkeys.js";
import {
  currentLocalIdentitySession,
  listLocalIdentitySessions,
  revokeLocalIdentitySession,
  signInLocalIdentity,
  withLocalIdentitySession,
} from "./local-sessions.js";
import { mintVaultKey } from "./vault/crypto.js";
import { vaultStore } from "./vault/store.js";
import {
  lockAllTombs,
  readFile,
  unlockTomb,
  vfsSeams,
  writeFile,
} from "./vfs.js";

let tomb: string;
let principalId: string;
let device: Awaited<ReturnType<typeof authenticator>>;
beforeEach(async () => {
  // Keep successful session flows independent of VM wall-clock corrections.
  // Expiry and rollback cases below set their own explicit boundary times.
  vi.spyOn(Date, "now").mockReturnValue(1788998400000);
  tomb = `sessions-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
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
  if (!person) throw new Error("Missing person");
  principalId = person.id;
  await enrollLocalPasskey(tomb, principalId);
});
afterEach(() => {
  vaultStore.lock();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser-local identity sessions", () => {
  it("preserves legacy passkey sessions while upgrading subsequent writes", async () => {
    const session = await signInLocalIdentity(tomb, principalId);
    const value: BoundaryValue = JSON.parse(
      new TextDecoder().decode(
        await readFile(tomb, "config/identity-sessions"),
      ),
    );
    if (!isJsonObject(value) || !Array.isArray(value.sessions))
      throw new Error("Missing session fixture");
    const sessions = value.sessions.map((row) => {
      if (!isJsonObject(row)) throw new Error("Invalid session fixture");
      const { authentication, ...legacy } = row;
      expect(authentication).toBe("passkey");
      return legacy;
    });
    await writeFile(
      tomb,
      "config/identity-sessions",
      new TextEncoder().encode(JSON.stringify({ version: 1, sessions })),
    );
    expect(await currentLocalIdentitySession(tomb, principalId)).toBe(session);
    await signInLocalIdentity(tomb, principalId);
    expect(
      await withLocalIdentitySession(
        tomb,
        session,
        async (row) => row.authentication,
      ),
    ).toBe("passkey");
    expect(
      new TextDecoder().decode(
        await readFile(tomb, "config/identity-sessions"),
      ),
    ).toContain('"version":2');
  });

  it("rejects a new-format session with missing authentication evidence type", async () => {
    const session = await signInLocalIdentity(tomb, principalId);
    const bytes = new TextDecoder().decode(
      await readFile(tomb, "config/identity-sessions"),
    );
    await writeFile(
      tomb,
      "config/identity-sessions",
      new TextEncoder().encode(
        bytes.replace('"authentication":"passkey",', ""),
      ),
    );
    await expect(
      withLocalIdentitySession(tomb, session, async () => true),
    ).rejects.toThrow("unavailable");
  });
  it("signs in with real cryptography and keeps presentation secrets out of every public view", async () => {
    expect(await currentLocalIdentitySession(tomb, principalId)).toBeNull();
    const session = await signInLocalIdentity(tomb, principalId);
    expect(await currentLocalIdentitySession(tomb, principalId)).toBe(session);
    expect(
      await currentLocalIdentitySession("another-tomb", principalId),
    ).toBeNull();
    expect(
      await withLocalIdentitySession(
        tomb,
        session,
        async (identity) => identity.principalId,
      ),
    ).toBe(principalId);
    expect(Object.keys(session).sort()).toEqual([
      "authTime",
      "authentication",
      "expiresAt",
      "id",
      "principalId",
    ]);
    expect(await listLocalIdentitySessions(tomb)).toEqual([session]);
    const stored = new TextDecoder().decode(
      await readFile(tomb, "config/identity-sessions"),
    );
    expect(stored).toContain('"digest":');
    expect(stored).not.toMatch(/"(?:token|access_token)":/);
  });

  it("rejects copied and forged session handles without running the protected action", async () => {
    const session = await signInLocalIdentity(tomb, principalId);
    const action = vi.fn(async () => "forbidden");
    await expect(
      withLocalIdentitySession(tomb, { ...session }, action),
    ).rejects.toThrow("unavailable");
    await expect(
      withLocalIdentitySession("another-tomb", session, action),
    ).rejects.toThrow("unavailable");
    expect(action).not.toHaveBeenCalled();
  });

  it("refuses forged and replayed authentication evidence", async () => {
    const evidence = await authenticateLocalPasskey(tomb, principalId);
    expect(() => consumeLocalAuthentication({ ...evidence })).toThrow(
      "no longer valid",
    );
    expect(consumeLocalAuthentication(evidence)).toBe(evidence);
    expect(() => consumeLocalAuthentication(evidence)).toThrow(
      "no longer valid",
    );
  });

  it.each(["expired", "backwards-clock", "origin", "lock"])(
    "rejects %s before a protected action",
    async (fault) => {
      const session = await signInLocalIdentity(tomb, principalId);
      if (fault === "expired")
        vi.spyOn(Date, "now").mockReturnValue(session.expiresAt);
      if (fault === "backwards-clock")
        vi.spyOn(Date, "now").mockReturnValue(session.authTime - 1);
      if (fault === "origin")
        vi.stubGlobal("location", {
          origin: "https://other.example.test",
          hostname: "other.example.test",
        });
      if (fault === "lock") vaultStore.lock();
      const action = vi.fn(async () => true);
      await expect(
        withLocalIdentitySession(tomb, session, action),
      ).rejects.toThrow();
      expect(action).not.toHaveBeenCalled();
      expect(await currentLocalIdentitySession(tomb, principalId)).toBeNull();
    },
  );

  it("revokes sessions durably without trusting the tab's cached handle", async () => {
    const session = await signInLocalIdentity(tomb, principalId);
    await revokeLocalIdentitySession(tomb, session.id);
    expect(await currentLocalIdentitySession(tomb, principalId)).toBeNull();
    expect(await listLocalIdentitySessions(tomb)).toEqual([]);
    await expect(
      withLocalIdentitySession(tomb, session, async () => true),
    ).rejects.toThrow("unavailable");
  });

  it("refuses an in-flight use if the vault locks during encrypted reads", async () => {
    const session = await signInLocalIdentity(tomb, principalId);
    const open = vfsSeams.open;
    vi.spyOn(vfsSeams, "open").mockImplementationOnce(async (key, blob) => {
      const value = await open(key, blob);
      vaultStore.lock();
      return value;
    });
    const action = vi.fn(async () => true);
    await expect(
      withLocalIdentitySession(tomb, session, action),
    ).rejects.toThrow("unavailable");
    expect(action).not.toHaveBeenCalled();
  });

  it("serializes revocation before a queued authorization", async () => {
    const session = await signInLocalIdentity(tomb, principalId);
    const action = vi.fn(async () => true);
    const results = await Promise.allSettled([
      revokeLocalIdentitySession(tomb, session.id),
      withLocalIdentitySession(tomb, session, action),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(action).not.toHaveBeenCalled();
  });

  it("invalidates sessions when their passkey is revoked", async () => {
    const session = await signInLocalIdentity(tomb, principalId);
    const key = (await readLocalPasskeys(tomb))[0];
    if (!key) throw new Error("Missing passkey");
    await revokeLocalPasskey(tomb, principalId, key.credentialId);
    expect(await currentLocalIdentitySession(tomb, principalId)).toBeNull();
    await expect(
      withLocalIdentitySession(tomb, session, async () => true),
    ).rejects.toThrow("unavailable");
  });

  it("does not resurrect a session when a disabled identity is re-enabled", async () => {
    const session = await signInLocalIdentity(tomb, principalId);
    const directory = await readLocalDirectory(tomb);
    const disabled = await changeLocalDirectory(tomb, directory.revision, {
      action: "update",
      id: principalId,
      name: "Local person",
      enabled: false,
    });
    await changeLocalDirectory(tomb, disabled.revision, {
      action: "update",
      id: principalId,
      name: "Local person",
      enabled: true,
    });
    await expect(
      withLocalIdentitySession(tomb, session, async () => true),
    ).rejects.toThrow("unavailable");
  });

  it("never issues a handle when the session record cannot be persisted", async () => {
    const write = vfsSeams.writeRaw;
    vi.spyOn(vfsSeams, "writeRaw").mockImplementation((key, value) => {
      if (key.endsWith("config/identity-sessions"))
        return Promise.reject(new Error("Storage unavailable"));
      return write(key, value);
    });
    await expect(signInLocalIdentity(tomb, principalId)).rejects.toThrow(
      "Storage unavailable",
    );
    expect(await listLocalIdentitySessions(tomb)).toEqual([]);
  });

  it("refuses sign-in when the vault locks during the native ceremony", async () => {
    const get = device.get.bind(device);
    vi.spyOn(device, "get").mockImplementation(async (options) => {
      const response = await get(options);
      vaultStore.lock();
      return response;
    });
    await expect(signInLocalIdentity(tomb, principalId)).rejects.toThrow();
    expect(await listLocalIdentitySessions(tomb)).toEqual([]);
  });
});
