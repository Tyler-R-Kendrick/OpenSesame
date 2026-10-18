import { afterEach, describe, expect, it } from "vitest";
import {
  anyDirtyEdit,
  hasDraftSaver,
  holdDirtyEdit,
  registerDraftSaver,
  resetDirtyEdits,
  saveDirtyDrafts,
  subscribeDirtyEdit,
} from "./dirty-edit.js";

afterEach(resetDirtyEdits);

describe("dirty edits", () => {
  it("is clean until an editor holds, and clean again when that hold ends", () => {
    expect(anyDirtyEdit()).toBe(false);
    const release = holdDirtyEdit("item");
    expect(anyDirtyEdit()).toBe(true);
    release();
    expect(anyDirtyEdit()).toBe(false);
    release();
    expect(anyDirtyEdit()).toBe(false);
  });

  it("stays dirty while any one hold remains", () => {
    const first = holdDirtyEdit("a");
    const second = holdDirtyEdit("b");
    first();
    expect(anyDirtyEdit()).toBe(true);
    second();
    expect(anyDirtyEdit()).toBe(false);
  });

  it("tells subscribers when the page becomes clean", () => {
    const seen: boolean[] = [];
    const stop = subscribeDirtyEdit(() => {
      seen.push(anyDirtyEdit());
    });
    const release = holdDirtyEdit("item");
    release();
    stop();
    expect(seen).toEqual([true, false]);
  });

  it("runs every saver and keeps going when one fails", async () => {
    const order: string[] = [];
    registerDraftSaver("ok", async () => {
      order.push("ok");
      return true;
    });
    registerDraftSaver("no", () => {
      order.push("no");
      throw new Error("cannot");
    });
    expect(hasDraftSaver()).toBe(true);
    await saveDirtyDrafts();
    expect(order.sort()).toEqual(["no", "ok"]);
  });

  it("drops a saver when its editor unmounts", async () => {
    const release = registerDraftSaver("item", () => {
      throw new Error("should have been dropped");
    });
    release();
    await saveDirtyDrafts();
    expect(hasDraftSaver()).toBe(false);
  });
});
