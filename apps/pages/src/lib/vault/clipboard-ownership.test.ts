import { deferred } from "@opensesame/app-core/browser/security/management.fixture.js";
import { expect, it } from "vitest";
import {
  acceptClipboardCopy,
  beginClipboardCopy,
  clearClipboardCopy,
} from "./clipboard-ownership.js";

it("refuses an older completion and protects a newer same-valued copy", async () => {
  const older = beginClipboardCopy("controlled-shared-value");
  const newer = beginClipboardCopy("controlled-shared-value");
  expect(acceptClipboardCopy(newer)).toBe(true);
  expect(acceptClipboardCopy(older)).toBe(false);
  const writes: string[] = [];
  await clearClipboardCopy(older, {
    readText: async () => newer.value,
    writeText: async (value) => {
      writes.push(value);
    },
  });
  expect(writes).toEqual([]);
});

it("does not erase newer or foreign values after a held ownership read", async () => {
  const older = beginClipboardCopy("controlled-old-value");
  expect(acceptClipboardCopy(older)).toBe(true);
  const held = deferred<string>();
  const writes: string[] = [];
  const clear = clearClipboardCopy(older, {
    readText: () => held.promise,
    writeText: async (value) => {
      writes.push(value);
    },
  });
  const newer = beginClipboardCopy(older.value);
  expect(acceptClipboardCopy(newer)).toBe(true);
  held.finish(older.value);
  await clear;
  expect(writes).toEqual([]);
  await clearClipboardCopy(newer, {
    readText: async () => "controlled-foreign-value",
    writeText: async (value) => {
      writes.push(value);
    },
  });
  expect(writes).toEqual([]);
});

it("never clears when the ownership read is denied", async () => {
  const copy = beginClipboardCopy("controlled-value");
  expect(acceptClipboardCopy(copy)).toBe(true);
  const writes: string[] = [];
  await clearClipboardCopy(copy, {
    readText: async () => {
      throw new Error("denied");
    },
    writeText: async (value) => {
      writes.push(value);
    },
  });
  expect(writes).toEqual([]);
});

it("does not revive an older completion after a newer owned value was cleared", async () => {
  const older = beginClipboardCopy("controlled-old-value");
  const newer = beginClipboardCopy("controlled-new-value");
  expect(acceptClipboardCopy(newer)).toBe(true);
  await clearClipboardCopy(newer, {
    readText: async () => newer.value,
    writeText: async () => {},
  });
  expect(acceptClipboardCopy(older)).toBe(false);
});

it("documents the platform's non-atomic read/write limitation without claiming prevention", async () => {
  const copy = beginClipboardCopy("controlled-value");
  expect(acceptClipboardCopy(copy)).toBe(true);
  let clipboard = copy.value;
  await clearClipboardCopy(copy, {
    readText: async () => clipboard,
    writeText: async (value) => {
      // A different app can change the clipboard after our read, before write.
      clipboard = "controlled-foreign-between-platform-calls";
      clipboard = value;
    },
  });
  expect(clipboard).toBe("");
});
