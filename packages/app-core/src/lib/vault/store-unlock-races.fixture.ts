import { bytesToB64url } from "@opensesame/sdk-browser";
/** Genuine sealed stores and controlled completion boundaries for unlock lifetime tests. */
import {
  createItem,
  parseTotp,
  totpCode,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, vi } from "vitest";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { kvForgetAll, kvGet, kvSet } from "../kv.js";
import { authenticator, origin } from "../local-authenticator.fixture.js";
import { changeLocalDirectory } from "../local-directory-admin.js";
import { enrollLocalPasskey } from "../local-passkeys.js";
import { writeTrustedUnlock } from "../trusted-unlock.js";
import {
  HEADER_PATH,
  lockAllTombs,
  tombFileKey,
  vfsFlush,
  writeFile,
} from "../vfs.js";
import { sealAuthenticatedManifest } from "./protection/manifest-auth.js";
import { remoteCodeSeams } from "./remote-code.js";
import {
  PASSWORD,
  installStoreOperationsFixture,
  newStore,
} from "./store-ops.fixture.js";
import { enrollTotp } from "./store-totp.fixture.js";
import type { VaultStore } from "./store.js";
import * as sharedLocks from "./vault-shared-locks.js";

export const MARKER_PATH = "settings/unlock-lifetime";
export const MARKER = "Sealed unlock lifetime fixture";

export function installUnlockRacesFixture(): void {
  installStoreOperationsFixture();
  beforeEach(async () => {
    await vfsFlush();
    lockAllTombs();
    kvForgetAll();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
}

export function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function populatedStore() {
  const store = newStore();
  await store.create(PASSWORD);
  await store.saveItem(createItem("note", "Protected fixture item"));
  await writeFile("personal", MARKER_PATH, new TextEncoder().encode(MARKER));
  return store;
}

export async function pendingTotp(recovery = false) {
  const source = await populatedStore();
  const uri = await enrollTotp(source);
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("Missing authenticator fixture seed");
  const codes = recovery ? await source.generateRecoveryCodes() : [];
  await source.trashItem(
    source.getSnapshot().header?.unlocks?.totp?.selfItemId ?? "",
  );
  source.lock();
  const store = newStore();
  await store.unlock(PASSWORD);
  return { store, code: () => totpCode(parseTotp(secret)), codes };
}

/** Supported legacy factor binding, with no self-registration until this verification. */
export async function pendingLegacyTotp() {
  const { store: old, code } = await pendingTotp();
  old.cancelTotpChallenge();
  const key = tombFileKey("personal", HEADER_PATH);
  const header = JSON.parse(kvGet(key) ?? "null");
  header.unlocks.totp.selfItemId = undefined;
  const root = await unwrapRawVaultKeyFromPassword(header, PASSWORD);
  try {
    const { factorConfiguration: _binding, ...legacy } = header.protection;
    header.protection = await sealAuthenticatedManifest(root, legacy);
  } finally {
    root.fill(0);
  }
  kvSet(key, JSON.stringify(header));
  const store = newStore();
  await store.unlock(PASSWORD);
  return { store, code };
}

export function holdProjection(store: VaultStore) {
  const started = deferred();
  const gate = deferred();
  const actual = store.protection.ensureProtectionProjected.bind(
    store.protection,
  );
  vi.spyOn(
    store.protection,
    "ensureProtectionProjected",
  ).mockImplementationOnce(async () => {
    await actual();
    started.release();
    await gate.promise;
  });
  return { started: started.promise, release: gate.release };
}

export function holdLease() {
  const started = deferred();
  const gate = deferred();
  const released = deferred();
  const acquire = sharedLocks.acquireOpenLease;
  vi.spyOn(sharedLocks, "acquireOpenLease").mockImplementationOnce(
    async (tomb) => {
      const release = await acquire(tomb);
      started.release();
      await gate.promise;
      return async () => {
        await release();
        released.release();
      };
    },
  );
  return {
    started: started.promise,
    release: gate.release,
    released: released.promise,
  };
}

export async function trustedContact(
  store: VaultStore,
  code: () => Promise<string>,
) {
  const [person] = await trustedContacts(store, code, 1);
  if (!person) throw new Error("Missing trusted fixture contact");
  return person;
}

export async function trustedContacts(
  store: VaultStore,
  code: () => Promise<string>,
  threshold: number,
) {
  await store.confirmTotp(await code());
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", new URL(origin));
  let current = await authenticator();
  const devices = new Map<string, typeof current>();
  vi.stubGlobal("navigator", {
    credentials: {
      create: (options: CredentialCreationOptions) => current.create(options),
      get: (options: CredentialRequestOptions) => {
        const id = options.publicKey?.allowCredentials?.[0]?.id;
        if (!id) throw new Error("Missing requested fixture credential");
        const bytes =
          id instanceof ArrayBuffer
            ? new Uint8Array(id)
            : new Uint8Array(id.buffer, id.byteOffset, id.byteLength);
        const device = devices.get(bytesToB64url(bytes));
        if (!device) throw new Error("Unknown fixture credential");
        return device.get(options);
      },
    },
    locks: webLocksDouble(),
  });
  const people: string[] = [];
  for (let index = 0; index < threshold; index++) {
    const directory = await changeLocalDirectory("personal", index, {
      action: "create",
      kind: "person",
      name: `Trusted fixture contact ${index}`,
    });
    const person = directory.entries.find(
      (row) => row.kind === "person" && !people.includes(row.id),
    );
    if (!person) throw new Error("Missing trusted fixture contact");
    current = await authenticator();
    const enrolled = await enrollLocalPasskey("personal", person.id);
    devices.set(enrolled.credentialId, current);
    people.push(person.id);
  }
  await writeTrustedUnlock("personal", {
    name: "Family",
    threshold,
    memberIds: people,
  });
  store.lock();
  await store.unlock(PASSWORD);
  await store.confirmTotp(await code());
  return people;
}

export async function pendingRemote() {
  const codes = new Map<string, string>();
  let serial = 0;
  vi.spyOn(remoteCodeSeams, "sendCode").mockImplementation(async (channel) => {
    const challengeId = `challenge-${++serial}`;
    codes.set(challengeId, "812457");
    return { challengeId, channel, to: "t•••@example.test", expiresAt: "" };
  });
  const verify = async (id: string, code: string) => {
    if (codes.get(id) !== code) throw new Error("That code did not match.");
    codes.delete(id);
  };
  const verification = vi
    .spyOn(remoteCodeSeams, "verifyCode")
    .mockImplementation(verify);
  const source = await populatedStore();
  await source.beginCodeEnrollment("email", "test@example.test");
  await source.confirmCodeEnrollment("812457");
  source.lock();
  const store = newStore();
  await store.unlock(PASSWORD);
  await store.requestSecondStepCode("email");
  return { store, verification, verify, code: "812457" };
}
