import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: () => {
      throw new Error("injected fsync failure");
    },
  };
});

import { saveBoatProviderState } from "./boat-provider-state.js";

it("keeps the old state intact when a write fails before rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "boat-interrupted-state-"));
  const path = join(dir, ".boat-agent-state.json");
  try {
    writeFileSync(path, '{"claimToken":"old"}', { mode: 0o600 });
    expect(() => saveBoatProviderState(dir, { claimToken: "new" })).toThrow(
      "injected fsync failure",
    );
    expect(readFileSync(path, "utf8")).toBe('{"claimToken":"old"}');
    expect(readdirSync(dir)).toEqual([".boat-agent-state.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
