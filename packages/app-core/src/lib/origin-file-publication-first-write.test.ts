/** First publication may recognize only its own still-empty native predecessor. */
import { afterEach, expect, it } from "vitest";
import { atRestReady } from "./at-rest/key.js";
import { openOriginFile } from "./at-rest/origin-files.js";
import {
  fixture,
  name,
  restoreOriginPublicationFixture,
} from "./origin-file-publication-custody.test-support.js";
import { captureOriginalOriginFileData } from "./origin-file-publication-fixed-receiver-data.js";
import { readOriginRecord } from "./origin-file-publication-read.js";
import { comparePublishOriginFile } from "./origin-file-publication.js";

afterEach(restoreOriginPublicationFixture);

it("publishes an absent record and opens the committed device seal", async () => {
  const f = fixture();
  const check = await comparePublishOriginFile(
    name,
    null,
    "first",
    4096,
    () => {},
    f.directory,
  );
  check();
  expect(f.state.closed).toBe(1);
  expect(f.state.aborted).toBe(0);
  expect(await openOriginFile(name, f.files.get(name) ?? "")).toBe("first");
});

it("refuses a preexisting empty record without opening a writer", async () => {
  const f = fixture();
  f.files.set(name, "");
  await expect(
    comparePublishOriginFile(name, null, "first", 4096, () => {}, f.directory),
  ).rejects.toThrow("Storage record does not open.");
  expect(f.state.stream).toBeUndefined();
  expect(f.files.get(name)).toBe("");
});

it("refuses a replaced empty predecessor rather than trusting its bytes", async () => {
  const f = fixture();
  await atRestReady();
  const owned = await f.directory.getFileHandle(`${name}.other`, {
    create: true,
  });
  await f.directory.getFileHandle(name, { create: true });
  await expect(
    readOriginRecord(
      f.directory,
      name,
      4096,
      () => {},
      false,
      captureOriginalOriginFileData(owned),
    ),
  ).rejects.toThrow("Storage entry changed.");
});

it("strict device reads refuse even the explicitly owned empty placeholder", async () => {
  const f = fixture();
  await atRestReady();
  const owned = await f.directory.getFileHandle(name, { create: true });
  await expect(
    readOriginRecord(
      f.directory,
      name,
      4096,
      () => {},
      true,
      captureOriginalOriginFileData(owned),
    ),
  ).rejects.toThrow("Original device record is not sealed.");
});

it("owned empty reads retain guarded publication limit validation", async () => {
  const f = fixture();
  await atRestReady();
  const owned = await f.directory.getFileHandle(name, { create: true });
  await expect(
    readOriginRecord(
      f.directory,
      name,
      0,
      () => {},
      false,
      captureOriginalOriginFileData(owned),
    ),
  ).rejects.toThrow("Invalid guarded storage publication limit.");
});
