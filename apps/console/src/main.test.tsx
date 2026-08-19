// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@opensesame/sdk-browser", () => ({
  createOpenSesame: vi.fn(() => ({
    signIn: vi.fn(),
    continueAnonymously: vi.fn(),
    signOut: vi.fn(),
  })),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("console entrypoint", () => {
  it("mounts the app into #root", async () => {
    vi.resetModules();
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
