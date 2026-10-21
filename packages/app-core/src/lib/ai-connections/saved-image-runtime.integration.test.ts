import { afterEach, expect, it } from "vitest";
import { loadNativeConnectorRecord } from "../native-connector-store.js";
import { vaultStore } from "../vault/store.js";
import type { OwnedAiImage } from "./owned-image.js";
import {
  AI_CONNECTION_FAMILIES,
  aiConnectionDraft,
  isAiConnectionProvider,
} from "./presets.js";
import { testAiConnection } from "./runtime.js";
import { performSavedAiImageInference } from "./saved-image-runtime.js";
import {
  coldSavedImageVault,
  savedImageFixture,
} from "./saved-image.test-support.js";
import { STABILITY_SD3_BASE, STABILITY_SD3_MODEL } from "./stability-target.js";
import { STABILITY_PROMPT } from "./stability-tls.test-support.js";
import {
  aiConnectionRecord,
  commitAiConnection,
  readAiConnection,
} from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";

const closes: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function setup(provider: "stability" | "byo-ai" = "stability") {
  const f = await savedImageFixture(provider);
  closes.push(f.close);
  const saved = await f.save();
  const view = new AbortController();
  const action = new AbortController();
  closes.push(() => view.abort());
  const invoke = () =>
    performSavedAiImageInference(
      saved.connectionId,
      STABILITY_PROMPT,
      {
        signal: view.signal,
        assertCurrent: () => view.signal.throwIfAborted(),
      },
      {
        signal: action.signal,
        assertCurrent: () => action.signal.throwIfAborted(),
      },
    );
  return { ...f, saved, view, action, invoke };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function withdraw(f: Fixture, kind: string) {
  if (kind === "view") f.view.abort();
  else if (kind === "action") f.action.abort();
  else if (kind === "route") f.http.withdraw();
  else if (kind === "feature") f.withdrawFeature();
  else if (kind === "vault") vaultStore.lock();
  else if (kind === "credential") {
    const token = vaultStore
      .getSnapshot()
      .items.find((item) => item.kind === "credential");
    if (!token || token.kind !== "credential" || token.method.type !== "token")
      throw new Error("Saved token missing");
    await vaultStore.saveItem({
      ...token,
      method: { ...token.method, token: "changed-original-token" },
    });
  } else {
    const row = aiConnectionRecord(f.saved.connectionId);
    const draft = readAiConnection(f.saved.connectionId);
    if (!row || !draft) throw new Error("Saved row missing");
    await commitAiConnection(
      { ...draft, name: "Changed row" },
      vaultStore.getSnapshot().tomb,
      "",
      () => {},
      row,
    );
  }
}
it("exposes the official native model and the same BYO image protocol without changing text defaults", () => {
  expect(isAiConnectionProvider("stability")).toBe(true);
  expect(aiConnectionDraft("stability")).toMatchObject({
    family: "stability_sd3",
    baseUrl: STABILITY_SD3_BASE,
    model: STABILITY_SD3_MODEL,
    authentication: "api-key",
    apiKey: "",
  });
  expect(AI_CONNECTION_FAMILIES.at(-1)).toEqual({
    id: "stability_sd3",
    label: "Stability AI images",
  });
  expect(aiConnectionDraft("byo-ai")).toMatchObject({
    family: "openai_chat",
    model: "",
    baseUrl: "",
  });
});
it.each(["stability", "byo-ai"] as const)(
  "uses actual saved %s Test/Save and cold custody to return an image surviving normal action retirement",
  async (provider) => {
    const f = await setup(provider);
    await testAiConnection(f.draft, f.saved.connectionId, undefined, {
      imagePrompt: STABILITY_PROMPT,
    });
    const before = loadNativeConnectorRecord(f.saved.connectionId);
    await coldSavedImageVault();
    const image = await f.invoke();
    closes.push(() => image.release());
    f.action.abort();
    expect(image.metadata()).toMatchObject({
      mimeType: "image/png",
      width: 2,
      height: 3,
    });
    const copy = image.copyBytes();
    copy.fill(0);
    expect(image.copyBytes()[0]).toBe(137);
    expect(f.captures()).toBe(3);
    expect(loadNativeConnectorRecord(f.saved.connectionId)).toEqual(before);
    expect(f.http.records).toHaveLength(3);
    expect(
      f.http.records.every(
        (row) => new Map(row.fields).get("model") === f.draft.model,
      ),
    ).toBe(true);
    image.release();
    expect(() => image.copyBytes()).toThrow();
  },
);
it.each(["action", "view", "route", "feature", "vault", "credential", "row"])(
  "original %s withdrawal physically closes a held saved image response before2s",
  async (kind) => {
    const f = await setup();
    f.http.state.mode = "hold-body";
    const attempt = expect(f.invoke()).rejects.toThrow();
    await expect.poll(() => f.http.state.held).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(f.http.records.at(-1)?.closed).toBe(false);
    const start = performance.now();
    await withdraw(f, kind);
    await expect
      .poll(() => f.http.records.at(-1)?.closed, { timeout: 1500 })
      .toBe(true);
    expect(performance.now() - start).toBeLessThan(2000);
    await attempt;
    expect(f.captures()).toBe(2);
  },
);
it.each(["view", "route", "feature", "vault", "credential", "row"])(
  "completed pixels remain owned by original %s after the separate action has retired",
  async (kind) => {
    const f = await setup();
    const image = await f.invoke();
    closes.push(() => image.release());
    f.action.abort();
    expect(image.metadata().width).toBe(2);
    await withdraw(f, kind);
    await expect.poll(() => image.signal.aborted, { timeout: 1500 }).toBe(true);
    expect(() => image.copyBytes()).toThrow();
    expect(f.captures()).toBe(2);
  },
);
it.each(["http-401", "filtered", "bad-base64", "jpeg"] as const)(
  "does not publish an owned image for actual %s responses",
  async (mode) => {
    const f = await setup();
    f.http.state.mode = mode;
    let result: OwnedAiImage | undefined;
    await expect(
      f.invoke().then((image) => {
        result = image;
      }),
    ).rejects.toThrow();
    expect(result).toBeUndefined();
    expect(f.http.records).toHaveLength(2);
  },
);

it("captures A before the first custody await and cannot adopt a new B registration", async () => {
  const f = await setup();
  const attempt = expect(f.invoke()).rejects.toThrow();
  expect(f.captures()).toBe(2);
  let laterCaptures = 0;
  const unbind = bindAiConnectionTransport({
    ...f.http.port,
    capture() {
      laterCaptures++;
      return f.http.port;
    },
  });
  closes.push(unbind);
  await attempt;
  expect(f.http.records).toHaveLength(1);
  expect(f.captures()).toBe(2);
  expect(laterCaptures).toBe(0);
});
