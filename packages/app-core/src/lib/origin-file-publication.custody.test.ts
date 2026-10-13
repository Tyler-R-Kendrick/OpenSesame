/** Real device-key seals and native File snapshots; OPFS/stream delivery is doubled. */
import { afterEach, expect, it } from "vitest";
import { host } from "../host.js";
import { atRestReady } from "./at-rest/key.js";
import { openOriginFile, sealOriginFile } from "./at-rest/origin-files.js";
import {
  fixture,
  name,
  restoreOriginPublicationFixture,
} from "./origin-file-publication-custody.test-support.js";
import { comparePublishOriginFile } from "./origin-file-publication.js";

afterEach(restoreOriginPublicationFixture);
const attacks = [
  ["root", "getFileHandle"],
  ["root", "isSameEntry"],
  ["root", "removeEntry"],
  ["handle", "getFile"],
  ["handle", "createWritable"],
  ["handle", "isSameEntry"],
  ["file", "text"],
  ["stream", "write"],
  ["stream", "close"],
  ["stream", "abort"],
];
it.each(attacks)(
  "original callback cannot substitute captured %s.%s",
  async (phase, method) => {
    const f = fixture();
    const key = await atRestReady();
    expect(key.durable).toBe(true);
    const before = sealOriginFile(key, name, "old");
    f.files.set(name, before);
    let replaced = false;
    let maliciousCalls = 0;
    const original = () => {
      if (host() !== f.installed) throw new Error("Actual Host changed.");
      if (replaced || f.state.phase !== phase) return;
      const target =
        phase === "root"
          ? f.root
          : phase === "handle"
            ? f.state.handle
            : phase === "file"
              ? f.state.file
              : f.state.stream;
      if (!target) throw new Error("Actual delivered resource missing.");
      replaced = true;
      Object.defineProperty(target, method, {
        configurable: true,
        value: async () => {
          maliciousCalls += 1;
          return "forged readback";
        },
      });
    };
    await expect(
      comparePublishOriginFile(
        name,
        "old",
        "next",
        4096,
        original,
        f.directory,
      ),
    ).rejects.toThrow();
    expect(replaced).toBe(true);
    expect(maliciousCalls).toBe(0);
    expect(f.files.get(name)).toBe(before);
    expect(f.state.closed).toBe(0);
    expect(f.state.aborted).toBe(phase === "stream" ? 1 : 0);
  },
);
it("fixed original publication keeps actual device seal, readback and predecessor identity", async () => {
  const f = fixture();
  const key = await atRestReady();
  f.files.set(name, sealOriginFile(key, name, "old"));
  const current = await comparePublishOriginFile(
    name,
    "old",
    "next",
    4096,
    () => {
      if (host() !== f.installed) throw new Error("Actual Host changed.");
    },
    f.directory,
  );
  current();
  const wire = f.files.get(name);
  if (!wire) throw new Error("Actual published device seal missing.");
  expect(wire).not.toContain("next");
  expect(await openOriginFile(name, wire)).toBe("next");
  expect(f.state.closed).toBe(1);
  expect(f.state.aborted).toBe(0);
});
it("failed own write drains captured abort and removes only its empty placeholder", async () => {
  const f = fixture();
  f.state.failWrite = true;
  await expect(
    comparePublishOriginFile(name, null, "next", 4096, () => {}, f.directory),
  ).rejects.toThrow("Actual own write refused.");
  expect(f.state.aborted).toBe(1);
  expect(f.state.closed).toBe(0);
  expect(f.files.has(name)).toBe(false);
});
it("post-close callback refusal preserves the actual committed seal and never aborts it", async () => {
  const f = fixture();
  const key = await atRestReady();
  f.files.set(name, sealOriginFile(key, name, "old"));
  const original = () => {
    if (f.state.phase === "closed")
      throw new Error("Actual refusal after close.");
  };
  await expect(
    comparePublishOriginFile(name, "old", "next", 4096, original, f.directory),
  ).rejects.toThrow("Actual refusal after close.");
  const wire = f.files.get(name);
  if (!wire) throw new Error("Actual committed seal missing.");
  expect(await openOriginFile(name, wire)).toBe("next");
  expect(f.state.closed).toBe(1);
  expect(f.state.aborted).toBe(0);
});
it("callback-substituted cleanup cannot invoke a replacement remover or publish its empty entry", async () => {
  const f = fixture();
  let maliciousCalls = 0;
  let replaced = false;
  const original = () => {
    if (replaced || f.state.phase !== "write") return;
    replaced = true;
    Object.defineProperty(f.root, "removeEntry", {
      configurable: true,
      value: async () => {
        maliciousCalls += 1;
      },
    });
  };
  await expect(
    comparePublishOriginFile(name, null, "next", 4096, original, f.directory),
  ).rejects.toThrow();
  expect(replaced).toBe(true);
  expect(maliciousCalls).toBe(0);
  expect(f.state.aborted).toBe(1);
  expect(f.state.closed).toBe(0);
  expect(f.files.get(name)).toBe("");
});
