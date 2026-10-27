import type { WebStorage } from "@opensesame/app-core/ports.js";
import type { JournalEvent } from "@opensesame/cua-password-reset";
import { describe, expect, it } from "vitest";
import { SealedCheckpointJournal } from "./password-reset-journal.js";

function storage() {
  const values = new Map<string, string>();
  const port: WebStorage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  return { port, values };
}

const event: JournalEvent = {
  type: "run.status",
  status: "running",
  at: "2026-10-27T00:00:00.000Z",
};

describe("sealed password reset journal keys", () => {
  it("reopens the same run and keeps different runs in distinct unnamed entries", async () => {
    const { port, values } = storage();
    const journal = new SealedCheckpointJournal(port);
    await journal.append("run-1", event);
    await journal.append("run-2", event);

    const reopened = new SealedCheckpointJournal(port);
    await expect(reopened.load("run-1")).resolves.toEqual([event]);
    await expect(reopened.load("run-2")).resolves.toEqual([event]);
    const keys = [...values.keys()];
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) {
      expect(key).toMatch(/^opensesame\.password-reset\.[A-Za-z0-9_-]{43}$/u);
      expect(key).not.toContain("run-1");
      expect(key).not.toContain("run-2");
    }
  });
});
