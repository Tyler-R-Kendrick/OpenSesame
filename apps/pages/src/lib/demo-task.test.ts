import { describe, expect, it } from "vitest";
import { createDemoTask } from "./demo-task.js";

describe("createDemoTask", () => {
  it("labels synthetic offline demo and ratchets send_external away", () => {
    const demo = createDemoTask();
    expect(demo.synthetic).toBe(true);
    expect(demo.capability_ceiling.some((c) => c.action === "send_external")).toBe(
      true,
    );
    expect(
      demo.current_capabilities.some((c) => c.action === "send_external"),
    ).toBe(false);
  });
});
