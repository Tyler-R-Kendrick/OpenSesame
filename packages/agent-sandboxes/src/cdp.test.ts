import { describe, expect, it } from "vitest";
import {
  CdpConnection,
  type CdpJsonValue,
  type CdpParams,
  type CdpSocket,
} from "./cdp-connection.js";
import { CdpBrowserDriver, isAllowedCdpRequest } from "./cdp-driver.js";

interface SentMessage {
  id?: number;
  method: string;
  params?: CdpParams;
  sessionId?: string;
}

function fakeCdp() {
  const sent: SentMessage[] = [];
  let onMessage: ((data: string) => void) | undefined;
  const state = { href: "https://accounts.example.test/reset" };
  const evaluateValue = (expression: string): CdpJsonValue => {
    if (expression === "document.readyState") return "complete";
    if (expression === "location.href") return state.href;
    if (expression.includes("__opensesameRefs = new Map"))
      return {
        url: state.href,
        text: "",
        fields: [{ ref: "e1", kind: "password", label: "New password" }],
      };
    if (expression.includes("isConnected")) return state.href;
    return true;
  };
  const resultFor = (message: SentMessage): CdpJsonValue => {
    if (message.method === "Target.createTarget") return { targetId: "t-1" };
    if (message.method === "Target.attachToTarget") return { sessionId: "s-1" };
    if (message.method === "Runtime.evaluate")
      return {
        result: {
          value: evaluateValue(String(message.params?.expression ?? "")),
        },
      };
    return {};
  };
  const socket: CdpSocket = {
    send: (data) => {
      // SAFETY: checked at the fake-socket boundary: every sender in this file is CdpConnection, which serializes SentMessage objects.
      const message = JSON.parse(data) as SentMessage;
      sent.push(message);
      queueMicrotask(() =>
        onMessage?.(
          JSON.stringify({
            id: message.id,
            sessionId: message.sessionId,
            result: resultFor(message),
          }),
        ),
      );
    },
    close: () => {},
    onMessage: (listener) => {
      onMessage = listener;
    },
    onClose: () => {},
  };
  const emitPaused = (requestId: string, url: string) =>
    onMessage?.(
      JSON.stringify({
        method: "Fetch.requestPaused",
        sessionId: "s-1",
        params: { requestId, request: { url, method: "GET" } },
      }),
    );
  return { socket, sent, state, emitPaused };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CDP browser isolation", () => {
  it("keeps the low-level CDP transport available for trusted callers", async () => {
    const { socket, sent } = fakeCdp();
    const connection = new CdpConnection(socket);
    await expect(connection.call("Browser.getVersion")).resolves.toEqual({});
    expect(sent).toHaveLength(1);
  });

  it("allows only approved destinations and inert local schemes", () => {
    const allowed = ["accounts.example.test"];
    expect(
      isAllowedCdpRequest("https://accounts.example.test/a", allowed),
    ).toBe(true);
    expect(isAllowedCdpRequest("wss://accounts.example.test/s", allowed)).toBe(
      true,
    );
    expect(isAllowedCdpRequest("data:text/plain,x", allowed)).toBe(true);
    expect(isAllowedCdpRequest("about:blank", allowed)).toBe(true);
    expect(isAllowedCdpRequest("https://evil.example/", allowed)).toBe(false);
    expect(
      isAllowedCdpRequest("https://sub.accounts.example.test/", allowed),
    ).toBe(false);
    expect(isAllowedCdpRequest("chrome-extension://abc/x.js", allowed)).toBe(
      false,
    );
    expect(isAllowedCdpRequest("not a url", allowed)).toBe(false);
  });

  it("installs the Fetch boundary on connect and fails unapproved requests in-browser", async () => {
    const { socket, sent, emitPaused } = fakeCdp();
    const connection = new CdpConnection(socket);
    await CdpBrowserDriver.connect(connection, {
      allowedDomains: ["accounts.example.test"],
    });
    expect(sent.some((m) => m.method === "Fetch.enable")).toBe(true);
    emitPaused("r-allowed", "https://accounts.example.test/app.js");
    emitPaused("r-evil", "https://evil.example/steal?token=canary");
    emitPaused("r-redirect", "http://169.254.169.254/latest/meta-data");
    await tick();
    const continued = sent.filter((m) => m.method === "Fetch.continueRequest");
    const failed = sent.filter((m) => m.method === "Fetch.failRequest");
    expect(continued.map((m) => m.params?.requestId)).toEqual(["r-allowed"]);
    expect(failed.map((m) => m.params?.requestId).sort()).toEqual([
      "r-evil",
      "r-redirect",
    ]);
  });

  it("refuses secret entry after the document leaves the snapshotted origin", async () => {
    const { socket, sent, state } = fakeCdp();
    const connection = new CdpConnection(socket);
    const driver = await CdpBrowserDriver.connect(connection, {
      allowedDomains: ["accounts.example.test", "other.example.test"],
    });
    await driver.snapshot();
    state.href = "https://other.example.test/collect";
    await expect(driver.fillSecret("e1", "secret-canary")).rejects.toThrow(
      "document changed",
    );
    expect(sent.some((m) => m.method === "Input.insertText")).toBe(false);
    expect(sent.some((m) => JSON.stringify(m).includes("secret-canary"))).toBe(
      false,
    );
  });

  it("types secrets only into the approved snapshotted document", async () => {
    const { socket, sent } = fakeCdp();
    const connection = new CdpConnection(socket);
    const driver = await CdpBrowserDriver.connect(connection, {
      allowedDomains: ["accounts.example.test"],
    });
    await driver.snapshot();
    await driver.fillSecret("e1", "secret-canary");
    const insert = sent.find((m) => m.method === "Input.insertText");
    expect(insert?.params?.text).toBe("secret-canary");
  });

  it("rejects navigation to unapproved domains before sending it", async () => {
    const { socket, sent } = fakeCdp();
    const connection = new CdpConnection(socket);
    const driver = await CdpBrowserDriver.connect(connection, {
      allowedDomains: ["accounts.example.test"],
    });
    await expect(
      driver.open("https://evil.example/reset?token=canary"),
    ).rejects.toThrow("approved domains");
    expect(sent.some((m) => m.method === "Page.navigate")).toBe(false);
  });
});
