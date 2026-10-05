import { describe, expect, it } from "vitest";
import { setupRoute } from "./use-setup-route.js";

describe("setup's route", () => {
  it("is the choice of a configuration before the ceremony", () => {
    expect(setupRoute("choose", undefined)).toBe("/setup/choose");
    expect(setupRoute("choose", "identity")).toBe("/setup/choose");
  });

  it("is the tab on screen, for the tabs that have a tutorial", () => {
    expect(setupRoute("ceremony", "capabilities")).toBe("/setup/capabilities");
    expect(setupRoute("ceremony", "identity")).toBe("/setup/identity");
    expect(setupRoute("ceremony", "connectors")).toBe("/setup/connectors");
  });

  it("is setup itself for a tab with none, so no other tab's tour is offered on it", () => {
    expect(setupRoute("ceremony", "mfa")).toBe("/setup");
    expect(setupRoute("ceremony", "local-ai")).toBe("/setup");
    expect(setupRoute("ceremony", undefined)).toBe("/setup");
  });
});
