/**
 * What a device is handed of a call's result (ADR 0195): rebuilt field by
 * field, cleaned for a terminal, cut to a frame — and a failure that says
 * nothing of what the provider said.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionPort } from "./connection-port.js";
import {
  CALL_TIMEOUT_MS,
  RESULT_BYTES,
  runCall,
  shape,
} from "./device-call.js";
import { ITEMS_MAX } from "./device-messages.js";
import { FAKE_CLOCK } from "./live-clock.fixture.js";

afterEach(() => vi.useRealTimers());

describe("shaping a result", () => {
  it("keeps the fields it knows and nothing a driver kept for itself", () => {
    const shaped = shape({
      label: "Vault",
      items: [
        {
          id: "k1",
          label: "kv/app",
          url: "https://v.test/kv/app",
          secretValue: "hunter2",
          inputSchema: "{}",
        },
      ],
      extra: "no",
    });
    expect(shaped).toEqual({
      label: "Vault",
      items: [{ id: "k1", label: "kv/app", url: "https://v.test/kv/app" }],
      truncated: false,
    });
    expect(JSON.stringify(shaped)).not.toContain("hunter2");
  });

  it("cleans what a terminal would draw wrong", () => {
    const shaped = shape({
      label: "Re‮pos\u0007",
      items: [{ id: "a\nb", label: "x​y\ud800z" }],
    });
    expect(shaped?.label).toBe("Re pos");
    expect(shaped?.items).toEqual([{ id: "a b", label: "x y z" }]);
  });

  it("falls back to the id for a missing label and drops a line with no id", () => {
    expect(
      shape({ label: "L", items: [{ id: "only" }, { label: "x" }, 7, null] }),
    ).toEqual({
      label: "L",
      items: [{ id: "only", label: "only" }],
      truncated: true,
    });
  });

  it("offers a link only if it is an https address a person could open", () => {
    const urls = [
      "https://ok.test/a",
      "http://nope.test",
      "https://has space.test",
      "javascript:alert(1)",
      "https://x.test/‮",
    ];
    const shaped = shape({
      label: "L",
      items: urls.map((url, i) => ({ id: `i${i}`, label: "l", url })),
    });
    expect(shaped?.items.map((item) => item.url)).toEqual([
      "https://ok.test/a",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("cuts a long list and says so", () => {
    const items = Array.from({ length: ITEMS_MAX + 20 }, (_, i) => ({
      id: `i${i}`,
      label: "l",
    }));
    const shaped = shape({ label: "L", items });
    expect(shaped?.items).toHaveLength(ITEMS_MAX);
    expect(shaped?.truncated).toBe(true);
  });

  it("halves a list that would not fit a frame", () => {
    // Four bytes to a character: a hundred of these weigh more than a frame.
    const items = Array.from({ length: ITEMS_MAX }, (_, i) => ({
      id: `${"😀".repeat(190)}${i}`,
      label: "😀".repeat(200),
      url: `https://x.test/${"z".repeat(400)}${i}`,
    }));
    const shaped = shape({ label: "L", items });
    expect(shaped?.truncated).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(shaped)).length,
    ).toBeLessThanOrEqual(RESULT_BYTES);
  });

  it("is not an answer if it is not the shape of one", () => {
    expect(shape(null)).toBeNull();
    expect(shape("text")).toBeNull();
    expect(shape({ label: "L" })).toBeNull();
    expect(shape({ label: "L", items: "no" })).toBeNull();
    expect(shape({ items: [] })).toMatchObject({ label: "Result" });
  });
});

const portOf = (invoke: ConnectionPort["invoke"]): ConnectionPort => ({
  list: () => [],
  invoke,
});
const CALL = { connection: "c", operation: "provider.read", input: {} };

describe("running a call", () => {
  it("returns the shaped answer", async () => {
    const called = await runCall(
      portOf(async () => ({ label: "L", items: [{ id: "a", label: "b" }] })),
      CALL,
      new AbortController().signal,
    );
    expect(called).toEqual({
      ok: true,
      shaped: {
        label: "L",
        items: [{ id: "a", label: "b" }],
        truncated: false,
      },
    });
  });

  it("says upstream_error for any failure, and nothing of its message", async () => {
    const called = await runCall(
      portOf(async () => {
        throw new Error("Bearer sk-live-123");
      }),
      CALL,
      new AbortController().signal,
    );
    expect(called).toEqual({ ok: false, error: "upstream_error" });
  });

  it("says upstream_error to an answer that is not one", async () => {
    const called = await runCall(
      portOf(async () => "not an object" as never),
      CALL,
      new AbortController().signal,
    );
    expect(called).toEqual({ ok: false, error: "upstream_error" });
  });

  it("says temporarily_unavailable when the grant ends under it", async () => {
    const ended = new AbortController();
    const running = runCall(
      portOf(
        (made) =>
          new Promise((_, reject) =>
            made.signal.addEventListener("abort", () => reject(new Error("x"))),
          ),
      ),
      CALL,
      ended.signal,
    );
    ended.abort();
    expect(await running).toEqual({
      ok: false,
      error: "temporarily_unavailable",
    });
  });

  it("stops waiting after the limit, and lets the port know", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    let aborted = false;
    const running = runCall(
      portOf(
        (made) =>
          new Promise((_, reject) =>
            made.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("x"));
            }),
          ),
      ),
      CALL,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS);
    expect(await running).toEqual({
      ok: false,
      error: "temporarily_unavailable",
    });
    expect(aborted).toBe(true);
  });

  it("does not hold a timer after a call that finished", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    await runCall(
      portOf(async () => ({ label: "L", items: [] })),
      CALL,
      new AbortController().signal,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
