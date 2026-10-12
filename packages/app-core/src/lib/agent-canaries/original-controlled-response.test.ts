/** Actual native stream cancel algorithms and retained native reader; no authentication/owner/authority doubles. */
import { expect, it } from "vitest";
import {
  type NativeResponseFault,
  withNativeResponseControl,
} from "./original-controlled-response.test-support.js";
const alias = Promise.resolve("ordinary rejected-value identity");
const paired: readonly NativeResponseFault[] = [
  {
    name: "negative work and positive cancel zero",
    work: { cause: -0 },
    cancel: { cause: +0 },
  },
  {
    name: "positive work and negative cancel zero",
    work: { cause: +0 },
    cancel: { cause: -0 },
  },
  {
    name: "undefined work and Promise cancel identity",
    work: { cause: undefined },
    cancel: { cause: alias },
  },
  {
    name: "Promise work and undefined cancel presence",
    work: { cause: alias },
    cancel: { cause: undefined },
  },
];
it.each(paired)(
  "retains $name after original read and native cancellation while ignoring poisoned dispatch",
  async (input) => {
    await withNativeResponseControl(input, async (control) => {
      const outcome = await control.run();
      if (outcome.ok) throw new Error("Native paired refusal missing.");
      const cause = outcome.failure.cause;
      if (!(cause instanceof AggregateError))
        throw new Error("Native paired aggregate missing.");
      expect(cause.errors).toHaveLength(2);
      expect(cause.errors[0]).toBe(input.work?.cause);
      expect(cause.errors[1]).toBe(input.cancel?.cause);
      expect(control.reads).toBe(1);
      expect(control.cancellations).toBe(1);
      expect(control.aborts).toBe(1);
      expect(control.stream.locked).toBe(false);
      expect(control.bytes.every((byte) => byte === 0)).toBe(true);
      expect(control.maliciousCalls).toBe(0);
    });
  },
);
it("retains an undefined first release delivery refusal and independently releases the real reader on retry", async () => {
  await withNativeResponseControl(
    {
      name: "release delivery",
      slot: {
        name: "releaseLock",
        failure: { cause: undefined },
        recovers: true,
      },
    },
    async (control) => {
      const outcome = await control.run();
      if (outcome.ok)
        throw new Error("Native release capture refusal missing.");
      expect(outcome.failure.cause).toBeUndefined();
      expect(control.getters).toBe(2);
      expect(control.reads).toBe(0);
      expect(control.cancellations).toBe(1);
      expect(control.stream.locked).toBe(false);
      expect(control.maliciousCalls).toBe(0);
    },
  );
});
it("retains both the original and repeated missing cancel delivery without skipping native release", async () => {
  const refusal = new Error("Original cancel slot delivery refused.");
  await withNativeResponseControl(
    {
      name: "cancel delivery",
      slot: { name: "cancel", failure: { cause: refusal }, recovers: false },
    },
    async (control) => {
      const outcome = await control.run();
      if (outcome.ok) throw new Error("Native cancel capture refusal missing.");
      const cause = outcome.failure.cause;
      if (!(cause instanceof AggregateError))
        throw new Error("Native repeated delivery aggregate missing.");
      expect(cause.errors).toHaveLength(2);
      expect(cause.errors[0]).toBe(refusal);
      expect(cause.errors[1]).toBe(refusal);
      expect(control.getters).toBe(2);
      expect(control.reads).toBe(0);
      expect(control.cancellations).toBe(0);
      expect(control.stream.locked).toBe(false);
      expect(control.maliciousCalls).toBe(0);
    },
  );
});

it("copies the exact native response chunk without invoking its constructor, species or iterator", async () => {
  await withNativeResponseControl(
    { name: "native chunk constructor", closeAfterChunk: true },
    async (control) => {
      let speciesCalls = 0;
      let iteratorCalls = 0;
      class LongerChunk extends Uint8Array {
        constructor(length: number) {
          super(length + 1);
          speciesCalls++;
        }
      }
      Object.defineProperty(control.bytes, "constructor", {
        value: { [Symbol.species]: LongerChunk },
      });
      Object.defineProperty(control.bytes, Symbol.iterator, {
        value: () => {
          iteratorCalls++;
          throw new Error("Delivered native chunk iterator must not run.");
        },
      });
      const outcome = await control.run();
      if (!outcome.ok) throw outcome.failure.cause;
      expect(outcome.value).toEqual({ native: "delivered" });
      expect(speciesCalls).toBe(0);
      expect(iteratorCalls).toBe(0);
      expect(control.reads).toBe(1);
      expect(control.cancellations).toBe(0);
      expect(control.aborts).toBe(0);
      expect(control.stream.locked).toBe(false);
      expect(control.bytes.every((byte) => byte === 0)).toBe(true);
      expect(control.maliciousCalls).toBe(0);
    },
  );
});

it.each(["ordinary", "shared"])(
  "refuses a native %s chunk over the byte bound despite a shadowed size before reading again",
  async (kind) => {
    const size = (256 << 10) + 1;
    const buffer =
      kind === "shared" ? new SharedArrayBuffer(size) : new ArrayBuffer(size);
    const bytes = new Uint8Array(buffer);
    bytes.fill(120);
    Object.defineProperty(bytes, "byteLength", { value: 0 });
    let speciesCalls = 0;
    class CopyWasReached extends Uint8Array {
      constructor(length: number) {
        super(length);
        speciesCalls++;
      }
    }
    Object.defineProperty(bytes, "constructor", {
      value: { [Symbol.species]: CopyWasReached },
    });
    await withNativeResponseControl(
      { name: "actual native byte bound", bytes, closeAfterChunk: true },
      async (control) => {
        const outcome = await control.run();
        if (outcome.ok) throw new Error("Actual byte bound refusal missing.");
        expect(outcome.failure.cause).toBeInstanceOf(Error);
        expect(outcome.failure.cause).toHaveProperty(
          "message",
          "Controlled canary receiver unavailable.",
        );
        expect(control.readCalls).toBe(1);
        expect(control.cancelCalls).toBe(1);
        expect(control.aborts).toBe(1);
        expect(control.stream.locked).toBe(false);
        expect(control.bytes.every((byte) => byte === 0)).toBe(true);
        expect(speciesCalls).toBe(0);
        expect(control.maliciousCalls).toBe(0);
      },
    );
  },
);
