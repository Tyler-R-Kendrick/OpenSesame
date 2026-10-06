import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  listAdditionalIdpRegistrations,
  registerIdp,
} from "../idp-registry.js";
import { activeOrgProfileId, setActiveOrgProfileId } from "../orgs.js";
import { readFile, vfsFlush, writeFile } from "../vfs.js";
import { PASSWORD, createRetiredCredentialFixture } from "./test-support.js";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => {
  fixture.restore();
  vi.restoreAllMocks();
});
it("preserves real items and independent sealed files across compromised-root rotation and fresh reopen", async () => {
  const item = createItem("note", "Owner retained after rotation");
  item.notes = "private real information";
  await fixture.store.saveItem(item);
  const saved = fixture.store.getSnapshot().items;
  fixture.store.setPrefs({ theme: "dark", lockOnHide: true });
  const provider = {
    id: "rotation-provider",
    issuer: "https://identity.example.invalid",
    label: "Owner private provider",
    kind: "byo" as const,
    registeredAt: new Date().toISOString(),
  };
  registerIdp(provider);
  setActiveOrgProfileId("owner-private-org");
  await vfsFlush();
  await writeFile(
    "personal",
    "proof/rotation.txt",
    new TextEncoder().encode("independent owner file"),
  );
  await fixture.store.protection.rotateCompromisedRoot({ password: PASSWORD });
  expect(
    new TextDecoder().decode(await readFile("personal", "proof/rotation.txt")),
  ).toBe("independent owner file");
  fixture.store.lock();
  await fixture.store.unlock(PASSWORD);
  expect(fixture.store.getSnapshot().items).toEqual(saved);
  expect(fixture.store.getSnapshot().prefs).toMatchObject({
    theme: "dark",
    lockOnHide: true,
  });
  expect(listAdditionalIdpRegistrations()).toContainEqual(provider);
  expect(activeOrgProfileId()).toBe("owner-private-org");
  expect(
    new TextDecoder().decode(await readFile("personal", "proof/rotation.txt")),
  ).toBe("independent owner file");
});

it("withholds retained owner writes and queued preferences after a peer rotates the actual root", async () => {
  const { VaultStore } = await import("../vault/store.js");
  const { readPlaintextFile, readSealedFile, HEADER_PATH, BODY_PATH } =
    await import("../vfs.js");
  const peer = new VaultStore();
  await peer.unlock(PASSWORD);
  try {
    await peer.protection.rotateCompromisedRoot({ password: PASSWORD });
    const header = readPlaintextFile("personal", HEADER_PATH);
    const body = readSealedFile("personal", BODY_PATH);
    const prefs = readSealedFile("personal", "config/prefs");
    fixture.store.setPrefs({ theme: "dark" });
    await fixture.store.flushPendingWrites();
    await vfsFlush();
    await expect(
      fixture.store.saveItem(createItem("note", "retired root write")),
    ).rejects.toThrow();
    expect(readPlaintextFile("personal", HEADER_PATH)).toBe(header);
    expect(readSealedFile("personal", BODY_PATH)).toEqual(body);
    expect(readSealedFile("personal", "config/prefs")).toEqual(prefs);
  } finally {
    peer.lock();
  }
});
