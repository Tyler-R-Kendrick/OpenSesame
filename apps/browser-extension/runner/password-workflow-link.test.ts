// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("password workflow handoff", () => {
  it("opens the PWA workflow without sending vault values or granting origin access", () => {
    document.documentElement.innerHTML = readFileSync(
      join(__dirname, "../entrypoints/popup/index.html"),
      "utf8",
    );
    const link = document.querySelector<HTMLAnchorElement>(".workflow-link");
    expect(link).not.toBeNull();
    const opened: string[] = [];
    link?.addEventListener("click", (event) => {
      event.preventDefault();
      opened.push(link.href);
    });
    link?.click();
    expect(opened).toEqual([
      "https://tyler-r-kendrick.github.io/OpenSesame/vault?workflow=password",
    ]);
    expect(link?.target).toBe("_blank");
    expect(link?.rel.split(" ")).toEqual(["noopener", "noreferrer"]);
    expect([...new URL(opened[0] ?? "").searchParams.keys()]).toEqual([
      "workflow",
    ]);
  });
  it("offers task-specific human handoffs without carrying credential or site data", () => {
    document.documentElement.innerHTML = readFileSync(
      join(__dirname, "../entrypoints/popup/index.html"),
      "utf8",
    );
    const links = [
      ...document.querySelectorAll<HTMLAnchorElement>(".workflow-actions a"),
    ];
    const opened: string[] = [];
    for (const link of links) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        opened.push(link.href);
      });
      link.click();
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
    }
    expect(
      opened.map((href) => new URL(href).searchParams.get("workflowAction")),
    ).toEqual(["create", "compare", "update", "read", "env-resolve"]);
    for (const href of opened)
      expect([...new URL(href).searchParams.keys()]).toEqual([
        "workflow",
        "workflowAction",
      ]);
    expect(
      document.querySelector('a[href$="/access/requests"]'),
    ).not.toBeNull();
  });
});
