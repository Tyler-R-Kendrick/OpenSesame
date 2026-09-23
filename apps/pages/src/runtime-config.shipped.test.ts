import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("shipped os-runtime-config.json", () => {
  it("is an empty object so the boot fetch is a 200", () => {
    const shipped = join(
      dirname(fileURLToPath(import.meta.url)),
      "../public/os-runtime-config.json",
    );
    expect(JSON.parse(readFileSync(shipped, "utf8"))).toEqual({});
  });
});
