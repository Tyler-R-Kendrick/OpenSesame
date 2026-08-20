import { overlapCast } from "@opensesame/os-domain";
// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdkBrowserSeams } from "./sdk-browser.js";

(
  overlapCast(globalThis)
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("console entrypoint", () => {
  it("mounts the app into #root", async () => {
    vi.resetModules();
    const { sdkBrowserSeams: seams } = await import("./sdk-browser.js");
    seams.createOpenSesame = vi.fn(() => ({
      signIn: vi.fn(),
      continueAnonymously: vi.fn(),
      signOut: vi.fn(),
    }));
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
      await import("./main.js");
    });
    expect(document.getElementById("root")?.textContent).toContain(
      "OpenSesame",
    );
  });

  it("fails loudly when the page has no #root element", async () => {
    vi.resetModules();
    document.body.innerHTML = "";
    await expect(import("./main.js")).rejects.toThrow("missing #root");
  });
});
