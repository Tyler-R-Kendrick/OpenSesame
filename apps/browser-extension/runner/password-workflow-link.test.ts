// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKFLOW_DESTINATIONS } from "./password-workflow-handoff";

function markup() {
  document.documentElement.innerHTML = readFileSync(
    join(__dirname, "../entrypoints/popup/index.html"),
    "utf8",
  );
}
function destination(button: HTMLButtonElement | null) {
  return Object.entries(WORKFLOW_DESTINATIONS).find(
    ([id]) => id === button?.dataset.workflow,
  )?.[1];
}
describe("password workflow handoff", () => {
  it("names the PWA workflow without sending vault values or granting origin access", () => {
    markup();
    const button = document.querySelector<HTMLButtonElement>(
      '.workflow-link[data-workflow="inventory"]',
    );
    expect(button).not.toBeNull();
    expect(button?.type).toBe("button");
    expect(button?.hasAttribute("href")).toBe(false);
    expect(button?.hasAttribute("target")).toBe(false);
    const url = destination(button);
    expect(url).toBe(
      "https://tyler-r-kendrick.github.io/OpenSesame/vault?workflow=password",
    );
    expect([...new URL(url ?? "").searchParams.keys()]).toEqual(["workflow"]);
    expect(document.querySelector("a[href]")).toBeNull();
    expect(document.getElementById("production-controls")?.hidden).toBe(true);
    expect(
      document.getElementById("security")?.closest("#production-controls"),
    ).toBeNull();
  });
  it("offers task-specific human handoffs without carrying credential or site data", () => {
    markup();
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".workflow-actions button",
      ),
    ];
    const urls = buttons.map((button) => destination(button));
    expect(
      urls.map((url) => new URL(url ?? "").searchParams.get("workflowAction")),
    ).toEqual(["create", "compare", "update", "read", "env-resolve"]);
    for (const [index, button] of buttons.entries()) {
      expect(button.type).toBe("button");
      expect(button.hasAttribute("href")).toBe(false);
      expect(button.hasAttribute("target")).toBe(false);
      expect([...new URL(urls[index] ?? "").searchParams.keys()]).toEqual([
        "workflow",
        "workflowAction",
      ]);
    }
    const requests = document.querySelector<HTMLButtonElement>(
      'button[data-workflow="requests"]',
    );
    expect(requests).not.toBeNull();
    expect(destination(requests)).toBe(
      "https://tyler-r-kendrick.github.io/OpenSesame/access/requests",
    );
  });
});
