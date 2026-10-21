import { afterEach, expect, it, vi } from "vitest";
import { vaultStore } from "../vault/store.js";
import { decodeAiImage } from "./image-output.js";
import { imageOwnerFixture } from "./image-owner.test-support.js";
import { OwnedAiImage } from "./owned-image.js";
import { deleteAiConnection, performSavedAiInference } from "./runtime.js";
import { inferSpeechAi } from "./speech-inference.js";
import { validateAiSpeechConnection } from "./speech-target.js";
import { ownedSpeechAudio } from "./speech-tls.test-support.js";
import { RASTER_FIXTURES } from "./stability-tls.test-support.js";
import { aiConnectionRecord, commitAiConnection } from "./store.js";
import { readAiConnection } from "./store.js";
import { aiVaultSeams } from "./vault-guard.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const f = await imageOwnerFixture();
  cleanup.push(f.close);
  return f;
}
it("retains a copied local image after a normal saved operation closes, without another route capture", async () => {
  const f = await setup();
  const owner = f.prepared.owner.complete(f.image);
  const input = { model: "scribe_v2", messages: [], media: ownedSpeechAudio() };
  await expect(
    performSavedAiInference(f.saved.connectionId, input),
  ).resolves.toHaveProperty("answer");
  const captures = f.captures();
  expect(owner.metadata()).toMatchObject({
    mimeType: "image/png",
    width: 2,
    height: 3,
  });
  const bytes = owner.copyBytes();
  bytes.fill(0);
  expect(owner.copyBytes()[0]).toBe(137);
  expect(f.captures()).toBe(captures);
  owner.release();
  expect(() => owner.copyBytes()).toThrow();
  expect(() => f.image.copyBytes()).toThrow();
});
it.each([
  "caller",
  "route-signal",
  "feature",
  "route-check",
  "lock",
  "credential",
  "forget",
  "row",
])(
  "releases completed local bytes automatically on original %s withdrawal",
  async (change) => {
    const f = await setup();
    const owner = f.prepared.owner.complete(f.image);
    if (change === "caller") f.caller.abort();
    else if (change === "route-signal") f.abortRoute();
    else if (change === "feature") f.withdrawFeature();
    else if (change === "route-check") f.withdrawRoute();
    else if (change === "lock") vaultStore.lock();
    else if (change === "credential") {
      if (f.token.method.type !== "token") throw new Error("Token missing");
      await vaultStore.saveItem({
        ...f.token,
        method: { ...f.token.method, token: "changed-unverified" },
      });
    } else if (change === "forget")
      await deleteAiConnection(f.saved.connectionId);
    else {
      const draft = readAiConnection(f.saved.connectionId);
      if (!draft) throw new Error("Saved draft missing");
      await commitAiConnection(
        { ...draft, name: "Replaced row" },
        vaultStore.getSnapshot().tomb,
        "",
        () => {},
        aiConnectionRecord(f.saved.connectionId) ?? undefined,
      );
    }
    await expect.poll(() => owner.signal.aborted, { timeout: 1000 }).toBe(true);
    expect(() => owner.copyBytes()).toThrow();
    expect(() => f.image.copyBytes()).toThrow();
  },
);
it("rejects a late result and wipes the rejected raster", async () => {
  const f = await setup();
  f.caller.abort();
  expect(() => f.prepared.owner.complete(f.image)).toThrow();
  expect(() => f.image.copyBytes()).toThrow();
});

it("rejects duplicate completion and releases both retained and rejected local bytes", async () => {
  const f = await setup();
  const owner = f.prepared.owner.complete(f.image);
  const second = decodeAiImage(RASTER_FIXTURES.png, "image/png", "");
  expect(() => owner.complete(second)).toThrow();
  expect(() => f.image.copyBytes()).toThrow();
  expect(() => second.copyBytes()).toThrow();
});

it.each(["caller", "credential", "row"])(
  "original %s withdrawal physically drains the retained operation before its HTTP deadline",
  async (change) => {
    const f = await setup();
    f.http.state.mode = "held";
    const attempt = expect(
      inferSpeechAi(
        validateAiSpeechConnection(f.prepared.draft),
        ownedSpeechAudio(),
        f.prepared.transport,
        () => f.prepared.owner.check(),
      ),
    ).rejects.toThrow();
    await f.http.held;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(f.http.records.at(-1)?.closed).toBe(false);
    const started = performance.now();
    if (change === "caller") f.caller.abort();
    else if (change === "row") await deleteAiConnection(f.saved.connectionId);
    else {
      if (f.token.method.type !== "token") throw new Error("Expected token");
      await vaultStore.saveItem({
        ...f.token,
        method: { ...f.token.method, token: "withdrawn-key" },
      });
    }
    await attempt;
    await expect
      .poll(() => f.http.records.at(-1)?.closed, { timeout: 1500 })
      .toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  },
);

it("captures one original route before custody await and rejects its replacement before publishing a handle", async () => {
  const f = await setup();
  const original = aiVaultSeams.capture;
  let resume = () => {};
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const capture = vi
    .spyOn(aiVaultSeams, "capture")
    .mockImplementationOnce(async () => {
      const actual = await original();
      await held;
      return actual;
    });
  const count = f.captures();
  const preparing = OwnedAiImage.prepare(f.saved.connectionId, {
    signal: f.caller.signal,
    assertCurrent() {},
  });
  const rejected = expect(preparing).rejects.toThrow();
  expect(f.captures()).toBe(count + 1);
  expect(capture).toHaveBeenCalledOnce();
  f.withdrawRoute();
  resume();
  await rejected;
  expect(f.captures()).toBe(count + 1);
});
