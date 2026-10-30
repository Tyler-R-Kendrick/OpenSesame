import { describe, expect, it } from "vitest";
import {
  BOAT_AGENT_PINNED_COMMIT,
  defaultBoatAgentCommand,
  resolveBoatAgentCommand,
} from "./boat-agent.js";

describe("Boat bootstrap command", () => {
  it("fetches and verifies the pinned reviewed commit before installing", () => {
    const command = defaultBoatAgentCommand();
    expect(BOAT_AGENT_PINNED_COMMIT).toMatch(/^[0-9a-f]{40}$/u);
    expect(command).toContain(
      `git fetch --depth 1 origin '${BOAT_AGENT_PINNED_COMMIT}'`,
    );
    expect(command).toContain("git rev-parse HEAD");
    expect(command.indexOf("git rev-parse HEAD")).toBeLessThan(
      command.indexOf("pnpm install"),
    );
    expect(command).toContain("--frozen-lockfile");
    expect(command).toContain("./node_modules/.bin/tsx");
    expect(command).not.toContain("dlx");
    expect(command).toContain("src/boat-agent-main.ts");
  });

  it("refuses mutable or unsafe refs: only full commit SHAs run", () => {
    expect(() => defaultBoatAgentCommand("main")).toThrow("SHA");
    expect(() => defaultBoatAgentCommand("v1.2.3")).toThrow("SHA");
    expect(() => defaultBoatAgentCommand("main; rm -rf /")).toThrow("SHA");
    expect(() => defaultBoatAgentCommand("../escape")).toThrow("SHA");
    expect(() => defaultBoatAgentCommand("A".repeat(40))).toThrow("SHA");
    expect(() => defaultBoatAgentCommand("a".repeat(39))).toThrow("SHA");
  });

  it("resolves the default to the pinned commit and explicit commands win", () => {
    const resolved = resolveBoatAgentCommand({}, {});
    expect(resolved.bootstrapped).toBe(true);
    expect(resolved.command).toContain(BOAT_AGENT_PINNED_COMMIT);
    expect(resolveBoatAgentCommand({ agentCommand: "run-agent" }, {})).toEqual({
      command: "run-agent",
      bootstrapped: false,
    });
  });
});
