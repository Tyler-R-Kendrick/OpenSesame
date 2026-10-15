import { describe, expect, it } from "vitest";
import { deviceWorkspaceRows } from "./device-workspace-rows.js";

describe("deviceWorkspaceRows", () => {
  it("always includes Terminal CLI beside local device records", () => {
    const rows = deviceWorkspaceRows([], { tailnet: false, approval: false });
    expect(rows.map((row) => row.label)).toEqual(["Terminal CLI"]);
  });

  it("adds tailnet and approval rows when those surfaces are drawn", () => {
    const rows = deviceWorkspaceRows([{ id: "dev_1", name: "Desk" }], {
      tailnet: true,
      approval: true,
    });
    expect(rows.map((row) => row.id)).toEqual([
      "dev_1",
      "tailnet-devices",
      "approve-device",
      "cli-terminal",
    ]);
  });
});
