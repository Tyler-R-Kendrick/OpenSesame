import { afterEach, describe, expect, it, vi } from "vitest";
import { aiStreamBody } from "./stream-body.js";
import { readAiTextStream } from "./stream.js";

const text = (value: string) => new TextEncoder().encode(value);
const delta = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
const done = "data: [DONE]\n\n";
afterEach(() => vi.restoreAllMocks());

function heldSource(cancel = vi.fn()) {
  let control: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        control = controller;
      },
      cancel,
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const mirror = response.clone();
  const drain = vi.spyOn(mirror, "arrayBuffer");
  vi.spyOn(response, "clone").mockReturnValue(mirror);
  return {
    response,
    mirror,
    drain,
    cancel,
    send(value: string) {
      if (!control) throw new Error("Source not started");
      control.enqueue(text(value));
    },
    end() {
      if (!control) throw new Error("Source not started");
      control.close();
    },
  };
}

const invalid = () => new Error("Invalid stream body custody");

describe("bounded streaming owns native completion and both response branches", () => {
  it("delivers partial output while DONE remains held, then drains only after true EOF", async () => {
    const source = heldSource();
    const owner = new AbortController();
    const remove = vi.spyOn(owner.signal, "removeEventListener");
    const partial = vi.fn();
    let settled = false;
    const pending = readAiTextStream(
      source.response,
      "openai_chat",
      partial,
      vi.fn(),
      owner.signal,
    ).finally(() => {
      settled = true;
    });
    source.send(delta);
    await vi.waitFor(() => expect(partial).toHaveBeenCalledWith("partial"));
    source.send(done);
    expect(settled).toBe(false);
    expect(source.drain).not.toHaveBeenCalled();
    source.end();
    await expect(pending).resolves.toBe("partial");
    expect(source.drain).toHaveBeenCalledOnce();
    expect(source.cancel).not.toHaveBeenCalled();
    expect(source.response.body?.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    owner.abort();
    expect(source.cancel).not.toHaveBeenCalled();
  });

  it("cancels both native tee branches while a read is pending, without a sequential-cancel deadlock", async () => {
    const source = heldSource();
    const owner = new AbortController();
    const pending = readAiTextStream(
      source.response,
      "openai_chat",
      vi.fn(),
      vi.fn(),
      owner.signal,
    );
    owner.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.drain).not.toHaveBeenCalled();
    expect(source.response.body?.locked).toBe(false);
  });

  it("preserves the initiating consumer error even when upstream cancellation rejects", async () => {
    const initiating = new Error("Original consumer withdrew");
    const source = heldSource(
      vi.fn(() => Promise.reject(new Error("Native cancellation failed"))),
    );
    const pending = readAiTextStream(
      source.response,
      "openai_chat",
      () => {
        throw initiating;
      },
      vi.fn(),
      new AbortController().signal,
    );
    source.send(delta);
    await expect(pending).rejects.toBe(initiating);
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.drain).not.toHaveBeenCalled();
    expect(source.response.body?.locked).toBe(false);
  });

  it.each([
    ["data after DONE", delta + done + delta],
    ["oversized frame", `:${" ".repeat(256 * 1024 + 1)}`],
    [
      "oversized answer",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(32769) } }] })}\n\n`,
    ],
    ["malformed JSON", "data: {invalid}\n\n"],
  ])(
    "closes both still-open branches on %s without draining unvalidated bytes",
    async (_name, frame) => {
      const source = heldSource();
      const pending = readAiTextStream(
        source.response,
        "openai_chat",
        vi.fn(),
        vi.fn(),
        new AbortController().signal,
      );
      source.send(frame);
      await expect(pending).rejects.toMatchObject({ code: "response" });
      expect(source.cancel).toHaveBeenCalledOnce();
      expect(source.drain).not.toHaveBeenCalled();
      expect(source.response.body?.locked).toBe(false);
    },
  );

  it("rejects cumulative bytes above4MiB before exhausting a demand-driven oversized producer", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const comment = `:${" ".repeat(64 * 1024 - 3)}\n\n`;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (pulls === 128) {
            controller.error(new Error("The oversized producer was exhausted"));
            return;
          }
          controller.enqueue(text(comment));
        },
        cancel,
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const mirror = response.clone();
    const drain = vi.spyOn(mirror, "arrayBuffer");
    vi.spyOn(response, "clone").mockReturnValue(mirror);
    await expect(
      readAiTextStream(
        response,
        "openai_chat",
        vi.fn(),
        vi.fn(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "response" });
    expect(pulls).toBeGreaterThan(64);
    expect(pulls).toBeLessThan(128);
    expect(cancel).toHaveBeenCalledOnce();
    expect(drain).not.toHaveBeenCalled();
    expect(response.body?.locked).toBe(false);
  });

  it("retires both parked branches when the original owner check withdraws between chunks", async () => {
    const source = heldSource();
    const initiating = new Error("Original owner no longer current");
    let current = true;
    const check = () => {
      if (!current) throw initiating;
    };
    const pending = readAiTextStream(
      source.response,
      "openai_chat",
      () => {
        current = false;
      },
      check,
      new AbortController().signal,
    );
    source.send(delta);
    await expect(pending).rejects.toBe(initiating);
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.drain).not.toHaveBeenCalled();
    expect(source.response.body?.locked).toBe(false);
  });

  it("refuses incomplete protocol at actual EOF without starting the mirror drain", async () => {
    const source = heldSource();
    const pending = readAiTextStream(
      source.response,
      "openai_chat",
      vi.fn(),
      vi.fn(),
      new AbortController().signal,
    );
    source.send(delta);
    source.end();
    await expect(pending).rejects.toMatchObject({ code: "response" });
    expect(source.drain).not.toHaveBeenCalled();
    expect(source.response.body?.locked).toBe(false);
  });

  it("rejects a completion body whose length disagrees with bounded streamed bytes", async () => {
    const source = heldSource();
    source.drain.mockResolvedValueOnce(new ArrayBuffer(1));
    const pending = readAiTextStream(
      source.response,
      "openai_chat",
      vi.fn(),
      vi.fn(),
      new AbortController().signal,
    );
    source.send(delta + done);
    source.end();
    await expect(pending).rejects.toMatchObject({ code: "response" });
    expect(source.response.body?.locked).toBe(false);
  });

  it("keeps original ownership through native drain reentry instead of publishing a stale answer", async () => {
    const source = heldSource();
    const owner = new AbortController();
    const nativeDrain = source.mirror.arrayBuffer.bind(source.mirror);
    source.drain.mockImplementationOnce(() => {
      owner.abort();
      return nativeDrain();
    });
    const pending = readAiTextStream(
      source.response,
      "openai_chat",
      vi.fn(),
      vi.fn(),
      owner.signal,
    );
    source.send(delta + done);
    source.end();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(source.response.body?.locked).toBe(false);
  });

  it("cannot start native completion before the original reader's actual EOF", async () => {
    const source = heldSource();
    const body = aiStreamBody(
      source.response,
      vi.fn(),
      new AbortController().signal,
      invalid,
    );
    await expect(body.finish(1)).rejects.toThrow("Invalid stream body custody");
    await body.close();
    expect(source.drain).not.toHaveBeenCalled();
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.response.body?.locked).toBe(false);
  });
});
