import {
  createItem,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { markDecoySession } from "../decoy-session.js";
import {
  PASSWORD,
  createRetiredCredentialFixture,
} from "../retired-credentials/test-support.js";
import { vfsSeams } from "../vfs.js";

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
let fileText: string;
let raw: Uint8Array;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
  const item = createItem("note", "Offered encrypted restore item");
  item.notes = "Restore plaintext must stay inside the original owner session.";
  await fixture.store.saveItem(item);
  await fixture.store.flushPendingWrites();
  fileText = fixture.store.exportSealed();
  const header = fixture.store.getSnapshot().header;
  if (!header) throw new Error("Expected a real wrapping header.");
  raw = await unwrapRawVaultKeyFromPassword(header, PASSWORD);
  await fixture.store.purgeItem(item.id);
  await fixture.store.flushPendingWrites();
  // Exercise the yield of a real cached dynamic import, with no module mocks.
  await import("./store-import.js");
});
afterEach(() => {
  raw.fill(0);
  vi.restoreAllMocks();
  fixture.restore();
});

it.each(["locked", "synthetic"])(
  "rejects a cached restore before reading, deriving, or writing in a %s successor",
  async (successor) => {
    const read = vi.spyOn(vfsSeams, "readRaw");
    const write = vi.spyOn(vfsSeams, "writeRaw");
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    const parse = vi.spyOn(JSON, "parse");
    const pending = fixture.store.importSealed(fileText, raw);
    if (successor === "locked") fixture.store.lock();
    else markDecoySession(true, "personal");
    // Synchronous admission may read the vault catalogue before the interruption.
    read.mockClear();
    write.mockClear();
    await expect(pending).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(derive).not.toHaveBeenCalled();
    expect(parse.mock.calls.some(([text]) => text === fileText)).toBe(false);
    expect(raw.every((byte) => byte === 0)).toBe(true);
  },
);

it("does not parse or merge a cached restore across lock and actual fresh real authentication", async () => {
  const parse = vi.spyOn(JSON, "parse");
  const pending = fixture.store.importSealed(fileText, raw).then(
    () => null,
    (error: Error) => error,
  );
  fixture.store.lock();
  await fixture.store.unlock(PASSWORD);
  expect(await pending).toBeInstanceOf(Error);
  expect(parse.mock.calls.some(([text]) => text === fileText)).toBe(false);
  expect(fixture.store.getSnapshot().status).toBe("unlocked");
  expect(fixture.store.getSnapshot().items).toEqual([]);
  expect(raw.every((byte) => byte === 0)).toBe(true);
});

it("imports the actual encrypted item with its password and preserves it after reopen", async () => {
  expect(await fixture.store.importSealed(fileText, PASSWORD)).toBe(1);
  fixture.store.lock();
  await fixture.store.unlock(PASSWORD);
  expect(fixture.store.getSnapshot().items).toContainEqual(
    expect.objectContaining({
      name: "Offered encrypted restore item",
      notes: "Restore plaintext must stay inside the original owner session.",
    }),
  );
});
