import { afterEach, describe, expect, it } from "vitest";
import {
  isWebMcpToolExposed,
  noteWebMcpFailure,
  noteWebMcpRegistered,
  noteWebMcpUnregistered,
  resetWebMcpRegistrationForTests,
  subscribeWebMcpRegistration,
  webmcpRegistrationSnapshot,
} from "./registration.js";

const BOOT = [
  { name: "opensesame_status", description: "status", scope: "boot" as const },
  { name: "opensesame_health", description: "health", scope: "boot" as const },
];
const SESSION = [
  {
    name: "opensesame_vault_search",
    description: "search",
    scope: "session" as const,
  },
];

afterEach(resetWebMcpRegistrationForTests);

describe("the WebMCP registration store", () => {
  it("starts with nothing registered and no source", () => {
    expect(webmcpRegistrationSnapshot()).toEqual({
      source: null,
      implemented: [],
      failures: [],
    });
    expect(isWebMcpToolExposed("opensesame_status")).toBe(false);
  });

  it("replaces a scope wholesale and keeps the other", () => {
    noteWebMcpRegistered("document", "boot", BOOT);
    noteWebMcpRegistered("document", "session", SESSION);
    expect(webmcpRegistrationSnapshot().implemented.map((t) => t.name)).toEqual(
      ["opensesame_status", "opensesame_health", "opensesame_vault_search"],
    );
    noteWebMcpRegistered("document", "boot", BOOT.slice(0, 1));
    expect(webmcpRegistrationSnapshot().implemented.map((t) => t.name)).toEqual(
      ["opensesame_vault_search", "opensesame_status"],
    );
    noteWebMcpUnregistered("session");
    expect(webmcpRegistrationSnapshot().implemented.map((t) => t.name)).toEqual(
      ["opensesame_status"],
    );
  });

  it("exposes a tool only when a browser holds it and did not refuse it", () => {
    noteWebMcpRegistered(null, "boot", BOOT);
    expect(isWebMcpToolExposed("opensesame_status")).toBe(false);

    noteWebMcpRegistered("navigator", "boot", BOOT);
    expect(isWebMcpToolExposed("opensesame_status")).toBe(true);

    noteWebMcpFailure({ name: "opensesame_status", reason: "duplicate" });
    expect(isWebMcpToolExposed("opensesame_status")).toBe(false);
    expect(isWebMcpToolExposed("opensesame_health")).toBe(true);
    expect(webmcpRegistrationSnapshot().failures).toEqual([
      { name: "opensesame_status", reason: "duplicate" },
    ]);

    // A later successful registration of the same scope clears the failure.
    noteWebMcpRegistered("navigator", "boot", BOOT);
    expect(webmcpRegistrationSnapshot().failures).toEqual([]);
    expect(isWebMcpToolExposed("opensesame_status")).toBe(true);
  });

  it("notifies subscribers on every change and lets them go", () => {
    let seen = 0;
    const stop = subscribeWebMcpRegistration(() => {
      seen += 1;
    });
    noteWebMcpRegistered("document", "boot", BOOT);
    noteWebMcpUnregistered("boot");
    expect(seen).toBe(2);
    stop();
    noteWebMcpRegistered("document", "boot", BOOT);
    expect(seen).toBe(2);
  });
});
