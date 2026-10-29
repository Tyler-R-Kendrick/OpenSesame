import { describe, expect, it } from "vitest";
import { CdpConnection, type CdpSocket } from "./cdp-connection.js";
import { CdpBrowserDriver } from "./cdp-driver.js";

function fakeCdp() {
  const sent: string[] = [];
  let onMessage: ((data: string) => void) | undefined;
  const socket: CdpSocket = {
    send: (data) => {
      sent.push(data);
      queueMicrotask(() =>
        onMessage?.(JSON.stringify({ id: 1, result: { ok: true } })),
      );
    },
    close: () => {},
    onMessage: (listener) => {
      onMessage = listener;
    },
    onClose: () => {},
  };
  return { socket, sent };
}

describe("CDP browser containment", () => {
  it("keeps the low-level CDP transport available for trusted callers", async () => {
    const { socket, sent } = fakeCdp();
    const connection = new CdpConnection(socket);
    await expect(connection.call("Browser.getVersion")).resolves.toEqual({
      ok: true,
    });
    expect(sent).toHaveLength(1);
  });

  it("rejects direct and normal construction before sending any CDP command", async () => {
    const { socket, sent } = fakeCdp();
    const connection = new CdpConnection(socket);
    const options = { allowedDomains: ["accounts.example.test"] };
    await expect(CdpBrowserDriver.connect(connection, options)).rejects.toThrow(
      "temporarily unavailable",
    );
    expect(() =>
      Reflect.construct(CdpBrowserDriver, [connection, options]),
    ).toThrow("temporarily unavailable");
    expect(sent).toEqual([]);
  });

  it("rejects forged driver methods before sending URLs or secret values", async () => {
    const { socket, sent } = fakeCdp();
    const connection = new CdpConnection(socket);
    const driver: CdpBrowserDriver = Object.create(CdpBrowserDriver.prototype);
    Object.assign(driver, {
      connection,
      options: { allowedDomains: ["accounts.example.test"] },
      sessionId: "session-1",
      targetId: "target-1",
    });
    await expect(
      driver.open("https://accounts.example.test/reset?token=canary"),
    ).rejects.toThrow("temporarily unavailable");
    await expect(driver.snapshot()).rejects.toThrow("temporarily unavailable");
    await expect(driver.click("e1")).rejects.toThrow("temporarily unavailable");
    await expect(driver.fill("e1", "secret-canary")).rejects.toThrow(
      "temporarily unavailable",
    );
    await expect(driver.fillSecret("e1", "secret-canary")).rejects.toThrow(
      "temporarily unavailable",
    );
    await expect(driver.pageUrl()).rejects.toThrow("temporarily unavailable");
    await expect(driver.close()).rejects.toThrow("temporarily unavailable");
    await expect(
      Object.getOwnPropertyDescriptor(
        CdpBrowserDriver.prototype,
        "evaluate",
      )?.value.call(driver, "secret-canary", undefined),
    ).rejects.toThrow("temporarily unavailable");
    expect(sent).toEqual([]);
  });
});
