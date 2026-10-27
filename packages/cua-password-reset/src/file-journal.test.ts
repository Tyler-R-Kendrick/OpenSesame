import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCheckpointJournal } from "./file-journal.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cua-file-journal-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("sealed atomic file journal", () => {
  it("persists sealed events across readers without plaintext", async () => {
    const journal = await FileCheckpointJournal.open(directory);
    await journal.append("run-1", { type: "run.status", status: "succeeded" });
    await journal.append("run-1", { type: "run.status", status: "failed" });
    const reopened = await FileCheckpointJournal.open(directory);
    expect(await reopened.load("run-1")).toEqual([
      { type: "run.status", status: "succeeded" },
      { type: "run.status", status: "failed" },
    ]);
    for (const file of (await readdir(directory)).filter((name) =>
      name.endsWith(".journal"),
    )) {
      const contents = await readFile(join(directory, file), "utf8");
      expect(contents).not.toContain("run-1");
      expect(contents).not.toContain("succeeded");
    }
  });

  it("fails closed on a modified ciphertext record", async () => {
    const journal = await FileCheckpointJournal.open(directory);
    await journal.append("run-1", { type: "checkpoint" });
    const file = (await readdir(directory)).find((name) =>
      name.endsWith(".journal"),
    );
    if (!file) throw new Error("Missing journal fixture");
    const filename = join(directory, file);
    const record = JSON.parse(await readFile(filename, "utf8"));
    record.data = `${record.data.slice(0, -2)}AA`;
    await writeFile(filename, JSON.stringify(record));
    await expect(journal.load("run-1")).rejects.toThrow();
  });

  it("fences a stale writer instead of losing another writer's append", async () => {
    const first = await FileCheckpointJournal.open(directory);
    const second = await FileCheckpointJournal.open(directory);
    await first.append("run-1", { sequence: 1 });
    await second.append("run-1", { sequence: 2 });
    await expect(first.append("run-1", { sequence: 3 })).rejects.toThrow(
      "stale",
    );
    expect(await second.load("run-1")).toEqual([
      { sequence: 1 },
      { sequence: 2 },
    ]);
  });
});
