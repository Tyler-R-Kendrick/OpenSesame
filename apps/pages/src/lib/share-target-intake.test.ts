import { takePendingImport } from "@opensesame/app-core/lib/vault/pending-import.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureShareTarget } from "./share-target-intake.js";
import { type ShareTargetMeta, shareTargetEntryUrl } from "./share-target.js";

const TOKEN = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  takePendingImport();
  vi.unstubAllGlobals();
});

function cacheWith(meta: ShareTargetMeta, file?: Uint8Array) {
  const entries = new Map<string, Response>();
  const root = `${window.location.origin}/`;
  entries.set(
    shareTargetEntryUrl(root, TOKEN, "meta"),
    new Response(JSON.stringify(meta), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  if (file) {
    entries.set(
      shareTargetEntryUrl(root, TOKEN, "file"),
      new Response(file, { headers: { "Content-Type": "text/plain" } }),
    );
  }
  const cache = {
    match: async (url: string) => entries.get(url)?.clone(),
    delete: async (url: string) => entries.delete(url),
  };
  return { cache, entries };
}

function meta(overrides: Partial<ShareTargetMeta> = {}): ShareTargetMeta {
  return {
    token: TOKEN,
    createdAt: 1,
    title: "Deploy",
    text: "",
    url: "",
    file: null,
    ...overrides,
  };
}

function location(search: string) {
  return {
    href: `${window.location.origin}/${search}`,
    search,
    pathname: "/",
    hash: "",
  } as Location;
}

describe("share target intake", () => {
  it("hands a staged file to the pending import and removes the token", async () => {
    const { cache, entries } = cacheWith(
      meta({
        file: { name: "app.env", type: "text/plain", size: 10 },
      }),
      new TextEncoder().encode("API_KEY=x\n"),
    );
    vi.stubGlobal("caches", { open: async () => cache });
    const replaceState = vi.fn();
    const file = await captureShareTarget(location(`?share-target=${TOKEN}`), {
      state: null,
      replaceState,
    } as unknown as History);
    expect(file?.name).toBe("app.env");
    expect(file?.size).toBe(10);
    expect(takePendingImport()).toBe(file);
    expect(replaceState).toHaveBeenCalledOnce();
    expect(entries.size).toBe(0);
  });

  it("turns shared text into the note Import adapter's file", async () => {
    const { cache } = cacheWith(meta({ text: "hello", url: "https://x.test" }));
    vi.stubGlobal("caches", { open: async () => cache });
    const file = await captureShareTarget(location(`?share-target=${TOKEN}`), {
      state: null,
      replaceState: vi.fn(),
    } as unknown as History);
    expect(file?.name).toBe(".opensesame-share.txt");
    expect(file?.size).toBe("Deploy\n\nhello\n\nhttps://x.test".length);
  });

  it("removes a malformed token without touching the cache", async () => {
    const open = vi.fn();
    vi.stubGlobal("caches", { open });
    const file = await captureShareTarget(
      location("?share-target=not-a-token"),
      { state: null, replaceState: vi.fn() } as unknown as History,
    );
    expect(file).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
