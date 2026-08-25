// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

async function stubAppSeams(): Promise<void> {
  const [{ apiClientSeams }, { clientCoreSeams }, { sdkBrowserSeams }] =
    await Promise.all([
      import("./api-client"),
      import("./client-core"),
      import("./sdk-browser"),
    ]);
  sdkBrowserSeams.createOpenSesame = () => ({
    getSession: vi.fn().mockResolvedValue(null),
    signIn: vi.fn(),
    continueAnonymously: vi.fn(),
    signOut: vi.fn(),
  });
  apiClientSeams.createApiClient = () => ({
    health: vi.fn().mockResolvedValue({ ok: true, body: "ok" }),
    probeDaemon: vi.fn().mockResolvedValue({ available: true }),
  });
  clientCoreSeams.loadSealedStore = vi.fn().mockResolvedValue(null);
  clientCoreSeams.persistSealedStore = vi.fn().mockResolvedValue(undefined);
}

describe("main entry", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = "";
  });

  it("throws when the #root element is missing", async () => {
    await expect(import("./main")).rejects.toThrow("Missing #root element");
  });

  it("mounts the App into the #root element", async () => {
    await stubAppSeams();
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
