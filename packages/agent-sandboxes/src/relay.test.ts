import type {
  BrowserDriver,
  Observation,
} from "@opensesame/cua-password-reset";
import { afterEach, describe, expect, it, vi } from "vitest";
import { relayDriverOverWebSocket } from "./relay-driver.js";
import { type RunningRelayServer, startRelayServer } from "./relay-server.js";

const OBSERVATION: Observation = {
  id: "obs-1",
  origin: "https://accounts.example.test",
  fields: [{ ref: "e1", kind: "email", label: "Email" }],
};

function fakeDriver(): BrowserDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    open: vi.fn(async (url: string) => {
      calls.push(`open ${url}`);
    }),
    snapshot: vi.fn(async () => OBSERVATION),
    click: vi.fn(async (ref: string) => {
      calls.push(`click ${ref}`);
    }),
    fill: vi.fn(async () => {}),
    fillSecret: vi.fn(async (ref: string) => {
      calls.push(`fillSecret ${ref}`);
    }),
    pageUrl: vi.fn(async () => "https://accounts.example.test/reset"),
    close: vi.fn(async () => {
      calls.push("close");
    }),
  };
}

describe("driver relay", () => {
  let server: RunningRelayServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("drives the hosted browser over an authenticated socket", async () => {
    const hosted = fakeDriver();
    server = await startRelayServer({ token: "s3cret-token", driver: hosted });
    const driver = relayDriverOverWebSocket(server.url, {
      token: "s3cret-token",
    });
    await driver.open("https://accounts.example.test/reset");
    await expect(driver.snapshot()).resolves.toEqual(OBSERVATION);
    await driver.fillSecret("e1", "value-never-logged");
    await expect(driver.pageUrl()).resolves.toContain("/reset");
    await driver.close();
    expect(hosted.calls).toEqual([
      "open https://accounts.example.test/reset",
      "fillSecret e1",
      "close",
    ]);
  });

  it("refuses a wrong relay token", async () => {
    server = await startRelayServer({
      token: "s3cret-token",
      driver: fakeDriver(),
    });
    const driver = relayDriverOverWebSocket(server.url, { token: "wrong" });
    await expect(
      driver.open("https://accounts.example.test/reset"),
    ).rejects.toThrow(/refused|failed/u);
  });

  it("surfaces hosted driver errors as relay errors", async () => {
    const hosted = fakeDriver();
    vi.mocked(hosted.open).mockRejectedValue(new Error("navigation blocked"));
    server = await startRelayServer({ token: "t", driver: hosted });
    const driver = relayDriverOverWebSocket(server.url, { token: "t" });
    await expect(driver.open("https://x.test/")).rejects.toThrow(
      "navigation blocked",
    );
  });
});
