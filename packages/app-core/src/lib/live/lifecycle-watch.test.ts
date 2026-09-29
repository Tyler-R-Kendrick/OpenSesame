/**
 * Handler evidence for the pageshow flag. A constructed event is not the
 * bfcache gate; that gate is a real history navigation of the shipped build.
 */
import { describe, expect, it } from "vitest";
import { readPageShowPersisted } from "./lifecycle-watch.js";

function pageShow(persisted: boolean): Event {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

describe("readPageShowPersisted", () => {
  it("reads a persisted flag and ignores a show that was not restored", () => {
    expect(readPageShowPersisted(pageShow(true))).toBe(true);
    expect(readPageShowPersisted(pageShow(false))).toBe(false);
    expect(readPageShowPersisted(new Event("pageshow"))).toBe(false);
  });
});
