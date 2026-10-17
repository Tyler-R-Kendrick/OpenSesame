import { describe, expect, it } from "vitest";
import {
  deviceWorkspaceListRows,
  deviceWorkspaceRows,
} from "./device-workspace-rows.js";

describe("deviceWorkspaceRows", () => {
  it("counts only vault devices, not Pair CLI", () => {
    const rows = deviceWorkspaceRows([], { tailnet: false, approval: false });
    expect(rows).toEqual([]);
    expect(rows.map((row) => row.label)).not.toContain("Terminal CLI");
    expect(rows.map((row) => row.label)).not.toContain("Pair CLI");
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
    ]);
  });

  it("lists Pair CLI on the workspace as an uncounted add-on", () => {
    const rows = deviceWorkspaceListRows([{ id: "dev_1", name: "Desk" }], {
      tailnet: false,
      approval: false,
    });
    expect(rows.map((row) => row.label)).toEqual(["Desk", "Pair CLI"]);
    expect(rows.find((row) => row.id === "pair-cli")).toMatchObject({
      href: "/identity/authorize?cli=1",
      counted: false,
    });
    expect(
      rows.filter((row) => row.counted !== false).map((row) => row.id),
    ).toEqual(["dev_1"]);
  });
});
