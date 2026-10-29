import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeBoatStateAtomically } from "./boat-state-write.js";

it("keeps the old state intact when a write fails before rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "boat-interrupted-state-"));
  const path = join(dir, ".boat-agent-state.json");
  try {
    writeFileSync(path, '{"claimToken":"old"}', { mode: 0o600 });
    expect(() =>
      writeBoatStateAtomically(dir, path, '{"claimToken":"new"}', () => {
        throw new Error("injected fsync failure");
      }),
    ).toThrow("injected fsync failure");
    expect(readFileSync(path, "utf8")).toBe('{"claimToken":"old"}');
    expect(readdirSync(dir)).toEqual([".boat-agent-state.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
