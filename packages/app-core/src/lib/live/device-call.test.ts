/**
 * What a device is handed of a call's result (ADR 0195): rebuilt field by
 * field, cleaned for a terminal, cut to a frame — and a failure that says
 * nothing of what the provider said.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConnectionPort, InvalidCall } from "./connection-port.js";
import {
  CALL_TIMEOUT_MS,
  RESULT_BYTES,
  reportOf,
  runCall,
} from "./device-call.js";
import { ITEMS_MAX } from "./device-messages.js";
import { FAKE_CLOCK } from "./live-clock.fixture.js";

afterEach(() => vi.useRealTimers());

describe("rebuilding a result", () => {
  it("keeps the fields it knows and nothing a driver kept for itself", () => {
    // What a driver holds at run time can be more than its type says.
    const driverLine = {
      id: "k1",
      label: "kv/app",
      url: "https://v.test/kv/app",
      secretValue: "hunter2",
      inputSchema: "{}",
    };
    const report = reportOf({ label: "Vault", items: [driverLine] });
    expect(report).toEqual({
      label: "Vault",
      items: [{ id: "k1", label: "kv/app", url: "https://v.test/kv/app" }],
      truncated: false,
    });
    expect(JSON.stringify(report)).not.toContain("hunter2");
  });

  it("cleans what a terminal would draw wrong", () => {
    const report = reportOf({
      label: "Re‮pos\u0007",
      items: [{ id: "a\nb", label: "x​y\ud800z" }],
    });
    expect(report.label).toBe("Re pos");
    expect(report.items).toEqual([{ id: "a b", label: "x y z" }]);
  });

  it("falls back to the id for an empty label and drops a line with no id", () => {
    expect(
      reportOf({
        label: "L",
        items: [
          { id: "only", label: "" },
          { id: "\u0000", label: "x" },
        ],
      }),
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
    const report = reportOf({
      label: "L",
      items: urls.map((url, i) => ({ id: `i${i}`, label: "l", url })),
    });
    expect(report.items.map((item) => item.url)).toEqual([
      "https://ok.test/a",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("names an unlabelled result", () => {
    expect(reportOf({ label: "  ", items: [] }).label).toBe("Result");
  });

  it("cuts a long list and says so", () => {
    const items = Array.from({ length: ITEMS_MAX + 20 }, (_, i) => ({
      id: `i${i}`,
      label: "l",
    }));
    const report = reportOf({ label: "L", items });
    expect(report.items).toHaveLength(ITEMS_MAX);
    expect(report.truncated).toBe(true);
  });

  it("halves a list that would not fit a frame", () => {
    // Four bytes to a character: a hundred of these weigh more than a frame.
    const items = Array.from({ length: ITEMS_MAX }, (_, i) => ({
      id: `${"😀".repeat(190)}${i}`,
      label: "😀".repeat(200),
      url: `https://x.test/${"z".repeat(400)}${i}`,
    }));
    const report = reportOf({ label: "L", items });
    expect(report.truncated).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(report)).length,
    ).toBeLessThanOrEqual(RESULT_BYTES);
  });
});

const portOf = (invoke: ConnectionPort["invoke"]): ConnectionPort => ({
  list: () => [],
  invoke,
});
const CALL = { connection: "c", operation: "provider.read", input: {} };

describe("running a call", () => {
  it("returns the rebuilt answer", async () => {
    const called = await runCall(
      portOf(async () => ({ label: "L", items: [{ id: "a", label: "b" }] })),
      CALL,
      new AbortController().signal,
    );
    expect(called).toEqual({
      ok: true,
      report: {
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

  it("says invalid_request when the port says the ask itself was wrong", async () => {
    const called = await runCall(
      portOf(async () => {
        throw new InvalidCall();
      }),
      CALL,
      new AbortController().signal,
    );
    expect(called).toEqual({ ok: false, error: "invalid_request" });
  });

  it("says upstream_error to an answer that cannot be rebuilt", async () => {
    const broken = {
      label: "x",
      get items(): never {
        throw new Error("not a list");
      },
    };
    const called = await runCall(
      portOf(async () => broken),
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
