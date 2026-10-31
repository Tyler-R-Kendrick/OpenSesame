/** @vitest-environment jsdom */
import { takePendingImport } from "@opensesame/app-core/lib/vault/pending-import.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureShareTarget } from "./share-target-intake.js";
import {
  type ShareTargetMeta,
  newShareTargetKey,
  sealShareTarget,
  shareTargetEntryUrl,
} from "./share-target.js";
import { asBufferSource } from "@opensesame/os-domain";

const TOKEN = "123e4567-e89b-42d3-a456-426614174000";
const CREATED = 1_700_000_000_000;

afterEach(() => {
  takePendingImport();
  vi.unstubAllGlobals();
});

async function cacheWith(meta: ShareTargetMeta, file?: Uint8Array) {
  const key = newShareTargetKey();
  const entries = new Map<string, Response>();
  const root = `${window.location.origin}/`;
  entries.set(
    shareTargetEntryUrl(root, TOKEN, CREATED, "meta"),
    new Response(
      asBufferSource(await sealShareTarget(
        key,
        new TextEncoder().encode(JSON.stringify(meta)),
      )),
    ),
  );
  if (file) {
    entries.set(
      shareTargetEntryUrl(root, TOKEN, CREATED, "file"),
      new Response(asBufferSource(await sealShareTarget(key, file))),
    );
  }
  const cache = {
    match: async (url: string) => entries.get(url)?.clone(),
    delete: async (url: string) => entries.delete(url),
  };
  return { cache, entries, key };
}

function meta(overrides: Partial<ShareTargetMeta> = {}): ShareTargetMeta {
  return {
    token: TOKEN,
    createdAt: CREATED,
    title: "Deploy",
    text: "",
    url: "",
    file: null,
    ...overrides,
  };
}

function location(key: string, createdAt = CREATED) {
  const hash = `#${new URLSearchParams({
    "share-target": `${TOKEN}.${key}.${createdAt}`,
  }).toString()}`;
  return { href: `${window.location.origin}/${hash}`, hash };
}

describe("share target intake", () => {
  it("decrypts a staged file and removes the fragment", async () => {
    const { cache, entries, key } = await cacheWith(
      meta({ file: { name: "app.env", type: "text/plain", size: 10 } }),
      new TextEncoder().encode("API_KEY=x\n"),
    );
    vi.stubGlobal("caches", { open: async () => cache });
    const replaceState = vi.fn();
    const file = await captureShareTarget(location(key), {
      state: null,
      replaceState,
    });
    expect(file?.name).toBe("app.env");
    expect(file?.size).toBe(10);
    expect(takePendingImport()).toBe(file);
    expect(replaceState).toHaveBeenCalledOnce();
    expect(entries.size).toBe(0);
  });

  it("turns decrypted shared text into the note Import adapter file", async () => {
    const { cache, key } = await cacheWith(
      meta({ text: "hello", url: "https://x.test" }),
    );
    vi.stubGlobal("caches", { open: async () => cache });
    const file = await captureShareTarget(location(key), {
      state: null,
      replaceState: vi.fn(),
    });
    expect(file?.name).toBe(".opensesame-share.txt");
    expect(file?.size).toBe("Deploy\n\nhello\n\nhttps://x.test".length);
  });

  it("cannot decrypt a tampered cache entry", async () => {
    const { cache, key } = await cacheWith(meta({ text: "hello" }));
    vi.stubGlobal("caches", { open: async () => cache });
    const tampered = key.endsWith("A")
      ? `${key.slice(0, -1)}B`
      : `${key.slice(0, -1)}A`;
    await expect(
      captureShareTarget(location(tampered), {
        state: null,
        replaceState: vi.fn(),
      }),
    ).resolves.toBeNull();
  });

  it("removes a malformed token without touching the cache", async () => {
    const open = vi.fn();
    vi.stubGlobal("caches", { open });
    const file = await captureShareTarget(location("not-a-token"), {
      state: null,
      replaceState: vi.fn(),
    });
    expect(file).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
