import { afterEach, describe, expect, it } from "vitest";
import {
  discardDoorPendingImport,
  holdPendingImport,
  peekPendingImport,
  pendingImportSource,
  takePendingImport,
} from "./pending-import.js";

afterEach(() => {
  takePendingImport();
});

function file(name: string): File {
  return new File(["x"], name, { type: "text/plain" });
}

describe("pending import", () => {
  it("drops the door's file when an existing vault is locked", () => {
    holdPendingImport(file("door.env"));
    discardDoorPendingImport();
    expect(peekPendingImport()).toBeNull();
  });

  it("keeps a launch or share file until the vault opens", () => {
    for (const source of ["launch", "share"] as const) {
      const held = file(`${source}.env`);
      holdPendingImport(held, source);
      discardDoorPendingImport();
      expect(peekPendingImport()).toBe(held);
      expect(pendingImportSource()).toBe(source);
      expect(takePendingImport()).toBe(held);
    }
  });
});
