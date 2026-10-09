import { describe, expect, it, vi } from "vitest";
import { pullSyncPages, readSyncPage } from "./sync-pages.js";

const blob = (id: string, epoch = 7) => ({
  id,
  epoch,
  ciphertext_epoch: 1,
  ciphertext_b64: "AQID",
});
const page = (ids: string[], more: boolean) => ({
  format: "opensesame-sync-page",
  version: 2,
  blobs: ids.map((id) => blob(id)),
  next_after: ids.length ? { epoch: 7, id: ids.at(-1) } : null,
  has_more: more,
});

describe("bounded sync client", () => {
  it.each([false, true])(
    "bounds stalled headers and body with one deadline: body=%s",
    async (body) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const request = async (
        _path: string,
        init: RequestInit,
      ): Promise<Response> => {
        if (body) return new Response(new ReadableStream({ cancel }));
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      };
      try {
        const pending = expect(
          readSyncPage(request, { epoch: 0, id: "" }),
        ).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(10000);
        await pending;
        if (body) expect(cancel).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("consumes equal-epoch continuations without skipping or duplicating", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json(page(["a", "b"], true)))
      .mockResolvedValueOnce(Response.json(page(["c"], false)));
    const ids: string[] = [];
    for await (const result of pullSyncPages(request, 0, "device-a"))
      ids.push(...result.blobs.map((item) => item.id));
    expect(ids).toEqual(["a", "b", "c"]);
    expect(request.mock.calls[1]?.[1].body).toContain(
      '"after":{"epoch":7,"id":"b"}',
    );
    expect(request.mock.calls[0]?.[0]).toBe("/api/v1/sync/pull-page");
  });
  it("rejects a replayed or backward cursor before yielding a page", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(page(["a"], true)));
    await expect(readSyncPage(request, { epoch: 7, id: "a" })).rejects.toThrow(
      "sync_cursor_did_not_advance",
    );
  });
  it("rejects mismatched continuation and out-of-order ciphertext", async () => {
    const bad = {
      ...page(["a", "b"], true),
      next_after: { epoch: 7, id: "c" },
    };
    await expect(
      readSyncPage(vi.fn().mockResolvedValue(Response.json(bad)), {
        epoch: 0,
        id: "",
      }),
    ).rejects.toThrow("invalid_sync_cursor");
    await expect(
      readSyncPage(
        vi.fn().mockResolvedValue(Response.json(page(["b", "a"], false))),
        { epoch: 0, id: "" },
      ),
    ).rejects.toThrow("invalid_sync_order");
  });
  it("does not expose malformed response bodies through errors", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response("SECRET-SENTINEL-not-json"));
    await expect(readSyncPage(request, { epoch: 0, id: "" })).rejects.toThrow(
      /^invalid_sync_page$/,
    );
  });
  it("refuses oversized responses before JSON parsing", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response("x".repeat(8 * 1024 * 1024 + 1)));
    await expect(readSyncPage(request, { epoch: 0, id: "" })).rejects.toThrow(
      /^invalid_sync_page$/,
    );
  });
  it("compares opaque unicode ids in SQLite UTF-8 order", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(Response.json(page(["\u{10000}"], false)));
    const result = await readSyncPage(request, { epoch: 7, id: "\ue000" });
    expect(result.blobs[0]?.id).toBe("\u{10000}");
  });
});
