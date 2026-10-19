import { expect, it, vi } from "vitest";
async function within<T>(phase: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Owned TLS stalled at ${phase}.`)),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
import { fixture, ownedTLS } from "./controller-native-stream.test-support.js";
it.each(["caller", "capture-owner", "controller-close"])(
  "physically drains persistent owned TLS within two seconds on %s withdrawal",
  async (reason) => {
    const f = fixture();
    const wire = await ownedTLS(f);
    try {
      const caller = new AbortController();
      const owner = new AbortController();
      const port = f.requests.capture(owner.signal);
      const response = await within(
        "headers",
        port.fetch(`${wire.base}/held`, {
          headers: { accept: "text/event-stream" },
          signal: caller.signal,
        }),
      );
      await wire.entered.promise;
      expect(response.status).toBe(200);
      expect(f.sent.filter((m) => m.kind === "pullHTTP")).toHaveLength(0);
      let closed = false;
      void wire.closed.promise.then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(closed).toBe(false);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected real response stream.");
      const first = await within("first frame", reader.read());
      expect(new TextDecoder().decode(first?.value)).toBe("data: ");
      const held = reader.read();
      await vi.waitFor(() =>
        expect(f.sent).toContainEqual({ kind: "pullHTTP", id: 1, sequence: 2 }),
      );
      const rejected = expect(held).rejects.toThrow();
      const start = performance.now();
      if (reason === "caller") caller.abort();
      if (reason === "capture-owner") owner.abort();
      if (reason === "controller-close") f.close();
      await within("read rejection", rejected);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          wire.closed.promise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error("Original TLS socket did not drain within 2s."),
                ),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      expect(performance.now() - start).toBeLessThan(2000);
      if (reason !== "caller") expect(() => port.assertCurrent()).toThrow();
      else port.assertCurrent();
      if (reason !== "controller-close") {
        const independent = f.requests.capture(new AbortController().signal);
        const second = await within(
          "independent headers",
          independent.fetch(`${wire.base}/finite`, {
            headers: { accept: "text/event-stream" },
          }),
        );
        expect(await within("independent body", second.text())).toBe(
          "same peer still usable",
        );
      }
      expect(f.stop).not.toHaveBeenCalled();
      expect(wire.errors).toEqual([]);
    } finally {
      await within("cleanup", wire.close());
    }
  },
);
