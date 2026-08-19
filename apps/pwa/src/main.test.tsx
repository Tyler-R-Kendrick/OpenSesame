// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opensesame/sdk-browser", () => ({
  createOpenSesame: () => ({
    getSession: vi.fn().mockResolvedValue(null),
    continueAnonymously: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock("@opensesame/api-client", () => ({
  createApiClient: () => ({
    health: vi.fn().mockResolvedValue({ ok: true, body: "ok" }),
    probeDaemon: vi.fn().mockResolvedValue({ available: true }),
  }),
}));

describe("main entry", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = "";
  });

  it("throws when the #root element is missing", async () => {
    await expect(import("./main")).rejects.toThrow("Missing #root element");
  });

  it("mounts the App into the #root element", async () => {
    const el = document.createElement("div");
    el.id = "root";
    document.body.appendChild(el);
    await import("./main");
    await vi.waitFor(() => {
      expect(el.textContent).toContain("Client PWA");
    });
    await vi.waitFor(() => {
      expect(el.textContent).toContain("Sealed local store ready");
    });
  });
});
