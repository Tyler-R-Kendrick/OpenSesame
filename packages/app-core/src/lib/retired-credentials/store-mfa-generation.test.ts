import { createItem, parseTotp, totpCode } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { remoteCodeSeams } from "../vault/remote-code.js";
import * as methods from "../vault/unlock-methods.js";
import { PASSWORD, createRetiredCredentialFixture } from "./test-support.js";
import { unlockWithRetiredCredentialGate } from "./unlock.js";

function deferred() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: () => finish() };
}

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
const remote = { ...remoteCodeSeams };
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(remoteCodeSeams, remote);
  fixture.restore();
});

it.each(["lock", "synthetic_admission"])(
  "withholds actual successful TOTP verification after %s",
  async (interruption) => {
    await fixture.enroll("selected retired password", "synthetic_decoy");
    const uri = await fixture.store.beginTotpEnrollment();
    const secret = new URL(uri).searchParams.get("secret") ?? "";
    await fixture.store.confirmTotpEnrollment(
      await totpCode(parseTotp(secret)),
    );
    fixture.store.lock();
    const reached = deferred();
    const blocked = deferred();
    const matches = methods.totpCodeMatches;
    vi.spyOn(methods, "totpCodeMatches").mockImplementationOnce(
      async (...args) => {
        const accepted = await matches(...args);
        expect(accepted).toBe(true);
        reached.finish();
        await blocked.promise;
        return accepted;
      },
    );
    // The sealed self-authenticator supplies the actual enrolled seed and code.
    const pending = fixture.store.unlock(PASSWORD).then(
      () => null,
      (error: Error) => error,
    );
    await reached.promise;
    fixture.store.lock();
    if (interruption === "synthetic_admission")
      await unlockWithRetiredCredentialGate(
        fixture.store,
        "selected retired password",
      );
    const current = fixture.store.getSnapshot();
    blocked.finish();
    expect(await pending).toBeInstanceOf(Error);
    expect(fixture.store.getSnapshot()).toEqual(current);
    if (interruption === "lock") expect(current.status).toBe("locked");
    else expect(current).toMatchObject({ decoy: true, guest: true });
  },
);

it("does not admit a pending real root when a remote code reply arrives after retired synthetic admission", async () => {
  await fixture.enroll("selected retired password", "synthetic_decoy");
  remoteCodeSeams.sendCode = async (channel) => ({
    channel,
    challengeId: "controlled-challenge",
    to: "owner@example.invalid",
    expiresAt: "",
  });
  remoteCodeSeams.verifyCode = async () => {};
  await fixture.store.beginCodeEnrollment("email", "owner@example.invalid");
  await fixture.store.confirmCodeEnrollment("controlled-code");
  await fixture.store.saveItem(createItem("note", "Real owner item"));
  fixture.store.lock();
  await fixture.store.unlock(PASSWORD);
  await fixture.store.requestSecondStepCode("email");
  const reached = deferred();
  const blocked = deferred();
  remoteCodeSeams.verifyCode = async () => {
    reached.finish();
    await blocked.promise;
  };
  const pending = fixture.store.confirmRemoteCode("controlled-code").then(
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
  expect(current.items.some((item) => item.name === "Real owner item")).toBe(
    false,
  );
});
