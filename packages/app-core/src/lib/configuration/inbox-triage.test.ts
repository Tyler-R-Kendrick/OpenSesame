import { describe, expect, it } from "vitest";
import { filterInboxRows } from "./inbox-triage.js";

describe("inbox triage", () => {
  const now = Date.parse("2026-09-17T12:00:00Z");
  const rows = [
    {
      id: "p",
      status: "pending",
      expiresAt: "2026-09-18T00:00:00Z",
      plane: "hosted" as const,
    },
    {
      id: "e",
      status: "pending",
      expiresAt: "2026-09-16T00:00:00Z",
      plane: "local" as const,
    },
    {
      id: "d",
      status: "denied",
      plane: "hosted" as const,
    },
  ];

  it("filters pending, expired, and decided without mixing planes", () => {
    expect(filterInboxRows(rows, "pending", now).map((row) => row.id)).toEqual([
      "p",
    ]);
    expect(filterInboxRows(rows, "expired", now).map((row) => row.id)).toEqual([
      "e",
    ]);
    expect(filterInboxRows(rows, "decided", now).map((row) => row.id)).toEqual([
      "d",
    ]);
    expect(filterInboxRows(rows, "expired", now)[0]?.plane).toBe("local");
  });
});
