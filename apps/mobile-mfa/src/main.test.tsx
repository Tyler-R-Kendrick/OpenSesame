import { type JsonObject, overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

(overlapCast(globalThis)).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("main entry", () => {
  it("mounts the App into #root", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const el = document.createElement("div");
    el.id = "root";
    document.body.appendChild(el);
    await import("./main.js");
    const { act } = await import("react");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(el.textContent).toContain("Mobile MFA");
    expect(el.textContent).toContain("OpenSesame");
  });

  it("throws when #root is missing", async () => {
    await expect(import("./main.js")).rejects.toThrow("Missing #root element");
  });
});
