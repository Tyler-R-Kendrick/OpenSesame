import { describe, expect, it } from "vitest";
import { describeSecretFiles } from "./files.conformance.js";
import { makeMemorySecretFiles } from "./memory.js";

describeSecretFiles("the emulated store", async () => ({
  files: makeMemorySecretFiles(),
}));

describe("the emulated store", () => {
  it("starts from what it is given and shows what it holds", () => {
    const files = makeMemorySecretFiles([["a/b.json", new Uint8Array([1])]]);
    expect([...files.snapshot().keys()]).toEqual(["a/b.json"]);
  });
});
