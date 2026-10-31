import { expect, it, vi } from "vitest";
import { trustedUnlockSeams } from "../trusted-unlock.js";
import { readFile } from "../vfs.js";
import {
  MARKER,
  MARKER_PATH,
  deferred,
  installUnlockRacesFixture,
  pendingTotp,
  trustedContacts,
} from "./store-unlock-races.fixture.js";

installUnlockRacesFixture();

async function expectOrdinaryFilesLocked() {
  await expect(readFile("personal", MARKER_PATH)).rejects.toMatchObject({
    code: "locked",
  });
}

it("genuine contact proofs and counter writes work while ordinary files stay locked until quorum", async () => {
  const { store, code } = await pendingTotp();
  const people = await trustedContacts(store, code, 2);
  const [first, second] = people;
  if (!first || !second) throw new Error("Missing trusted fixture contacts");
  expect(store.isUnlocked()).toBe(false);
  await expectOrdinaryFilesLocked();
  await store.confirmTrustedContact(first);
  expect(store.isUnlocked()).toBe(false);
  await expectOrdinaryFilesLocked();
  await store.confirmTrustedContact(first);
  expect(store.isUnlocked()).toBe(false);
  await expectOrdinaryFilesLocked();
  await store.confirmTrustedContact(second);
  expect(store.isUnlocked()).toBe(true);
  expect(
    new TextDecoder().decode(await readFile("personal", MARKER_PATH)),
  ).toBe(MARKER);
});

it("cancel revokes an in-flight real contact proof before it can publish custody", async () => {
  const { store, code } = await pendingTotp();
  const [person] = await trustedContacts(store, code, 1);
  if (!person) throw new Error("Missing trusted fixture contact");
  const started = deferred();
  const gate = deferred();
  const authenticate = trustedUnlockSeams.authenticate;
  vi.spyOn(trustedUnlockSeams, "authenticate").mockImplementationOnce(
    async (...args) => {
      await authenticate(...args);
      started.release();
      await gate.promise;
    },
  );
  const refused = expect(store.confirmTrustedContact(person)).rejects.toThrow(
    /no longer pending/,
  );
  await started.promise;
  try {
    store.cancelTrustedUnlock();
    expect(store.isUnlocked()).toBe(false);
    await expectOrdinaryFilesLocked();
    gate.release();
    await refused;
    expect(store.isUnlocked()).toBe(false);
    await expectOrdinaryFilesLocked();
  } finally {
    gate.release();
    await refused;
  }
});
