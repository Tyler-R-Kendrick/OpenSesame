import { describe, expect, it } from "vitest";
import { buildTaskAccessViewModel, TaskAccessPanel } from "./TaskAccessPanel.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

describe("TaskAccessPanel", () => {
  it("renders ceiling vs current columns and ratchet message", () => {
    const model = buildTaskAccessViewModel({
      task_run_id: "task-abc",
      state_version: 3,
      status: "active",
      capability_ceiling: [
        { action: "read", resource: "repo:a" },
        { action: "write", resource: "repo:a" },
      ],
      current_capabilities: [{ action: "read", resource: "repo:a" }],
    });
    const html = renderToStaticMarkup(createElement(TaskAccessPanel, { model }));
    expect(html).toContain("task-abc");
    expect(html).toContain("Ceiling");
    expect(html).toContain("Current");
    expect(html).toContain("cannot be widened");
    expect(html).toContain("read → repo:a");
  });
});
