/** Native byte-boundary controls; no authentication or Root verdict. */
import { expect, it } from "vitest";
import { readOriginalControlledResponseData } from "./original-controlled-response-data.js";

const LIMIT = 256 << 10;
type Counts = { pulls: number; cancellations: number; aborts: number };

async function withChunks(
  chunks: readonly Uint8Array[],
  close: boolean,
  work: (
    response: Response,
    stream: ReadableStream<Uint8Array>,
    counts: Counts,
    abort: () => void,
  ) => Promise<void>,
) {
  const counts = { pulls: 0, cancellations: 0, aborts: 0 };
  let at = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        counts.pulls++;
        const chunk = chunks[at++];
        if (!chunk) throw new Error("Unexpected additional native pull.");
        controller.enqueue(chunk);
        if (close && at === chunks.length) controller.close();
      },
      cancel() {
        counts.cancellations++;
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(stream, {
    headers: { "Content-Type": "application/json" },
  });
  const abort = () => {
    counts.aborts++;
  };
  const failures: unknown[] = [];
  try {
    await work(response, stream, counts, abort);
  } catch (cause) {
    failures.push(cause);
  }
  try {
    await stream.cancel();
  } catch (cause) {
    failures.push(cause);
  }
  for (const chunk of chunks) {
    try {
      chunk.fill(0);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Native boundary control and teardown failed.",
    );
}

it("accepts exactly 256 KiB of native JSON and releases without aborting", async () => {
  const padding = "x".repeat(LIMIT - JSON.stringify({ native: "" }).length);
  const bytes = new TextEncoder().encode(JSON.stringify({ native: padding }));
  expect(bytes.byteLength).toBe(LIMIT);
  await withChunks([bytes], true, async (response, stream, counts, abort) => {
    const result = await readOriginalControlledResponseData({
      response,
      original: () => {},
      abort,
    });
    expect(result).toEqual({ native: padding });
    expect(counts).toEqual({ pulls: 1, cancellations: 0, aborts: 0 });
    expect(stream.locked).toBe(false);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });
});

it("refuses cumulative native overflow before parsing or consuming another chunk", async () => {
  const first = new Uint8Array(LIMIT / 2).fill(120);
  const second = new Uint8Array(LIMIT / 2 + 1).fill(120);
  const unread = new Uint8Array([123]);
  expect(first.byteLength).toBeLessThan(LIMIT);
  expect(second.byteLength).toBeLessThan(LIMIT);
  expect(first.byteLength + second.byteLength).toBe(LIMIT + 1);
  await withChunks(
    [first, second, unread],
    false,
    async (response, stream, counts, abort) => {
      await expect(
        readOriginalControlledResponseData({
          response,
          original: () => {},
          abort,
        }),
      ).rejects.toThrow("Controlled canary receiver unavailable.");
      expect(counts).toEqual({ pulls: 2, cancellations: 1, aborts: 1 });
      expect(stream.locked).toBe(false);
      expect(first.every((byte) => byte === 0)).toBe(true);
      expect(second.every((byte) => byte === 0)).toBe(true);
      expect(unread).toEqual(new Uint8Array([123]));
    },
  );
});

it("accepts native Unicode JSON split inside a four-byte UTF-8 scalar", async () => {
  const value = { native: "before 🧭 after é" };
  const wire = new TextEncoder().encode(JSON.stringify(value));
  const scalarAt = wire.indexOf(0xf0);
  expect(scalarAt).toBeGreaterThan(0);
  expect(Array.from(wire.subarray(scalarAt, scalarAt + 4))).toEqual([
    0xf0, 0x9f, 0xa7, 0xad,
  ]);
  const first = wire.slice(0, scalarAt + 2);
  const second = wire.slice(scalarAt + 2);
  wire.fill(0);
  await withChunks(
    [first, second],
    true,
    async (response, stream, counts, abort) => {
      const result = await readOriginalControlledResponseData({
        response,
        original: () => {},
        abort,
      });
      expect(result).toEqual(value);
      expect(counts).toEqual({ pulls: 2, cancellations: 0, aborts: 0 });
      expect(stream.locked).toBe(false);
      expect(first.every((byte) => byte === 0)).toBe(true);
      expect(second.every((byte) => byte === 0)).toBe(true);
    },
  );
});
