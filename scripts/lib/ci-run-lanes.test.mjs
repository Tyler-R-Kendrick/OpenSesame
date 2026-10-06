import { describe, expect, it } from "vitest";
import { runLanes } from "./ci-run-lanes.mjs";

const node = (code) => ({ command: process.execPath, args: ["-e", code] });

describe("ci run lanes", () => {
  it("passes when every lane passes", async () => {
    expect(await runLanes([[node("")], [node(""), node("")]])).toBe(0);
  });

  it("fails with the failing status, and runs the other lane to its end", async () => {
    const marker = `${process.pid}-${Date.now()}`;
    const status = await runLanes([
      [node("process.exit(3)")],
      [
        node("setTimeout(() => process.exit(0), 50)"),
        node(`console.error("${marker}")`),
      ],
    ]);
    expect(status).toBe(3);
  });

  it("stops a lane at its first failure", async () => {
    const status = await runLanes([
      [node("process.exit(2)"), node("process.exit(9)")],
    ]);
    expect(status).toBe(2);
  });

  it("fails a command that cannot start", async () => {
    expect(
      await runLanes([[{ command: "definitely-not-a-command-xyz", args: [] }]]),
    ).toBe(1);
  });

  it("passes with no lanes", async () => {
    expect(await runLanes([])).toBe(0);
  });
});
