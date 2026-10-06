import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as authentication from "../vault/protection/manifest-auth.js";
import * as files from "../vfs.js";
import { retiredCredentialStatus } from "./index.js";
import { openRetiredCredentialDecoy } from "./session.js";
import { createRetiredCredentialFixture } from "./test-support.js";
import { unlockWithRetiredCredentialGate } from "./unlock.js";

function deferred() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: () => finish() };
}
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
  await fixture.enroll("selected retired password", "synthetic_decoy");
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.restore();
});

it.each(["projection", "commit"] as const)(
  "withholds a real authenticated manifest after a blocked %s seal and synthetic admission",
  async (phase) => {
    let operationId = "";
    if (phase === "projection") await fixture.store.enrollPin("93746281");
    else
      operationId = (
        await fixture.store.protection.enrollCandidate("recovery-key")
      ).operationId;
    const reached = deferred();
    const blocked = deferred();
    const seal = authentication.sealAuthenticatedManifest;
    vi.spyOn(
      authentication,
      "sealAuthenticatedManifest",
    ).mockImplementationOnce(async (...args) => {
      const sealed = await seal(...args);
      reached.finish();
      await blocked.promise;
      return sealed;
    });
    const pending = (
      phase === "projection"
        ? fixture.store.protection.ensureProtectionProjected()
        : fixture.store.protection.commitEnrollment(operationId)
    ).then(
      () => null,
      (error: Error) => error,
    );
    await reached.promise;
    fixture.store.lock();
    await unlockWithRetiredCredentialGate(
      fixture.store,
      "selected retired password",
    );
    const current = fixture.store.getSnapshot();
    blocked.finish();
    expect(await pending).toBeInstanceOf(Error);
    expect(fixture.store.getSnapshot()).toEqual(current);
    expect(current).toMatchObject({ decoy: true, guest: true });
  },
);

it("wipes a replacement real root whose actual import completes in a successor synthetic realm", async () => {
  const trap = retiredCredentialStatus("personal").traps[0];
  if (!trap) throw new Error("Expected the selected enrolled trap");
  const reached = deferred();
  const blocked = deferred();
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  let imports = 0;
  let raw: Uint8Array | null = null;
  vi.spyOn(crypto.subtle, "importKey").mockImplementation(async (...args) => {
    const key = await original(...args);
    const data = args[1];
    const usages = args[4];
    if (usages.includes("encrypt") && usages.includes("decrypt")) {
      imports += 1;
      // Mint imports first; the second import is the store's replacement admission.
      if (imports === 2) {
        if (data instanceof ArrayBuffer) raw = new Uint8Array(data);
        else if (ArrayBuffer.isView(data))
          raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        reached.finish();
        await blocked.promise;
      }
    }
    return key;
  });
  const pending = fixture.store.protection
    .rotateCompromisedRoot({ password: "correct horse battery staple" })
    .then(
      () => null,
      (error: Error) => error,
    );
  await reached.promise;
  fixture.store.lock();
  await expect(
    unlockWithRetiredCredentialGate(fixture.store, "selected retired password"),
  ).rejects.toThrow(/already running/);
  await openRetiredCredentialDecoy(fixture.store, trap, "personal");
  const current = fixture.store.getSnapshot();
  blocked.finish();
  expect(await pending).toBeInstanceOf(Error);
  expect(fixture.store.getSnapshot()).toEqual(current);
  if (!raw) throw new Error("Expected an actual replacement raw root");
  expect(Array.from(raw)).toEqual(Array.from({ length: 32 }, () => 0));
});

it.each(["success", "failure"])(
  "withholds header %s bookkeeping after an actual owner write and synthetic admission",
  async (completion) => {
    const reached = deferred();
    const blocked = deferred();
    const write = files.writePlaintextFile;
    vi.spyOn(files, "writePlaintextFile").mockImplementationOnce(
      async (...args) => {
        await write(...args);
        reached.finish();
        await blocked.promise;
        if (completion === "failure")
          throw new Error("Controlled storage failure");
      },
    );
    const pending = fixture.store.enrollPin("93746281").then(
      () => null,
      (error: Error) => error,
    );
    await reached.promise;
    fixture.store.lock();
    await unlockWithRetiredCredentialGate(
      fixture.store,
      "selected retired password",
    );
    const current = fixture.store.getSnapshot();
    blocked.finish();
    expect(await pending).toBeInstanceOf(Error);
    expect(fixture.store.getSnapshot()).toEqual(current);
    expect(current).toMatchObject({ decoy: true, guest: true });
  },
);
