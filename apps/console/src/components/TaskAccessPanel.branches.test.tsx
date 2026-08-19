import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  TaskAccessPanel,
  buildTaskAccessViewModel,
} from "./TaskAccessPanel.js";

describe("buildTaskAccessViewModel", () => {
  it("fills defaults for an empty body", () => {
    expect(buildTaskAccessViewModel({})).toEqual({
      taskRunId: "",
      stateVersion: 0,
      status: "unknown",
      ceiling: [],
      current: [],
    });
  });

  it("unwraps a { capabilities } envelope, including nested ones", () => {
    const model = buildTaskAccessViewModel({
      task_run_id: "task-1",
      state_version: 2,
      status: "active",
      capability_ceiling: {
        capabilities: {
          capabilities: [{ action: "read", resource: "repo:a" }],
        },
      },
      current_capabilities: { capabilities: [] },
    });
    expect(model.ceiling).toEqual([{ action: "read", resource: "repo:a" }]);
    expect(model.current).toEqual([]);
  });

  it("drops non-array capability lists and non-object entries", () => {
    const model = buildTaskAccessViewModel({
      capability_ceiling: "not-a-list",
      current_capabilities: [null, "read", 7, { action: "read" }],
    });
    expect(model.ceiling).toEqual([]);
    expect(model.current).toEqual([]);
  });

  it("reads resource selectors by value, then pattern", () => {
    const model = buildTaskAccessViewModel({
      capability_ceiling: [
        { action: "read", resource: { value: "repo:a" } },
        { action: "write", resource: { pattern: "repo:*" } },
      ],
    });
    expect(model.ceiling).toEqual([
      { action: "read", resource: "repo:a" },
      { action: "write", resource: "repo:*" },
    ]);
  });

  it("drops capabilities without both an action and a resource", () => {
    const model = buildTaskAccessViewModel({
      capability_ceiling: [
        { action: "", resource: "repo:a" },
        { action: "read", resource: {} },
        { action: "read", resource: "repo:a" },
      ],
    });
    expect(model.ceiling).toEqual([{ action: "read", resource: "repo:a" }]);
  });
});

describe("TaskAccessPanel branches", () => {
  it("renders an empty-state row and a dash for a missing task id", () => {
    const model = buildTaskAccessViewModel({});
    const html = renderToStaticMarkup(
      createElement(TaskAccessPanel, { model }),
    );
    expect(html).toContain("No capabilities recorded.");
    expect(html).toContain("—");
    expect(html).toContain("unknown");
  });

  it("marks capabilities missing from one column with a dash", () => {
    const model = buildTaskAccessViewModel({
      task_run_id: "task-2",
      state_version: 1,
      status: "active",
      capability_ceiling: [
        { action: "read", resource: "repo:a" },
        { action: "write", resource: "repo:a" },
      ],
      current_capabilities: [{ action: "write", resource: "repo:a" }],
    });
    const html = renderToStaticMarkup(
      createElement(TaskAccessPanel, { model }),
    );
    // read is ceiling-only, so its current cell falls back to the dash.
    expect(html).toContain("read → repo:a");
    expect(html).toContain("write → repo:a");
    expect(html).toContain("<td>—</td>");
  });
});
