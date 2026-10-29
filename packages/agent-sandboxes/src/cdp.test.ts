import { describe, expect, it } from "vitest";
import {
  CdpConnection,
  type CdpJsonValue,
  type CdpParams,
  type CdpSocket,
} from "./cdp-connection.js";
import { CdpBrowserDriver } from "./cdp-driver.js";

interface SentMessage {
  id: number;
  method: string;
  params?: CdpParams;
  sessionId?: string;
}

function fakeCdp(responder: (message: SentMessage) => CdpJsonValue) {
  const sent: SentMessage[] = [];
  let onMessage: ((data: string) => void) | null = null;
  const socket: CdpSocket = {
    send: (data) => {
      // SAFETY: checked at the socket boundary: the only sender is CdpConnection.call, which serializes CdpRequestMessage objects of exactly this shape.
      const message = JSON.parse(data) as SentMessage;
      sent.push(message);
      const result = responder(message);
      queueMicrotask(() => {
        onMessage?.(JSON.stringify({ id: message.id, result }));
      });
    },
    close: () => {},
    onMessage: (listener) => {
      onMessage = listener;
    },
    onClose: () => {},
  };
  return { socket, sent };
}

function evaluateValue(message: SentMessage): CdpJsonValue {
  const expression = String(message.params?.expression ?? "");
  if (expression.includes("__opensesameRefs") && expression.includes("fields"))
    return {
      result: {
        value: {
          url: "https://accounts.example.test/reset",
          text: "CAPTCHA verify you are human",
          fields: [{ ref: "e1", kind: "password", label: "New password" }],
        },
      },
    };
  if (expression === "location.href")
    return { result: { value: "https://accounts.example.test/reset" } };
  if (expression === "document.readyState")
    return { result: { value: "complete" } };
  return { result: { value: true } };
}

describe("CdpBrowserDriver", () => {
  it("attaches flat, snapshots, and keeps secrets out of JS source", async () => {
    const { socket, sent } = fakeCdp((message) => {
      switch (message.method) {
        case "Target.createTarget":
          return { targetId: "target-1" };
        case "Target.attachToTarget":
          return { sessionId: "session-1" };
        case "Runtime.evaluate":
          return evaluateValue(message);
        default:
          return {};
      }
    });
    const driver = await CdpBrowserDriver.connect(new CdpConnection(socket), {
      allowedDomains: ["accounts.example.test"],
    });
    const snapshot = await driver.snapshot();
    expect(snapshot.fields).toContainEqual({
      ref: "e2",
      kind: "static",
      label: "CAPTCHA verify you are human",
    });
    await driver.fillSecret("e1", "cdp-secret-value");
    const evaluations = sent.filter((m) => m.method === "Runtime.evaluate");
    expect(
      evaluations.some((m) =>
        String(m.params?.expression ?? "").includes("cdp-secret-value"),
      ),
    ).toBe(false);
    const insert = sent.find((m) => m.method === "Input.insertText");
    expect(insert?.params?.text).toBe("cdp-secret-value");
    expect(insert?.sessionId).toBe("session-1");
    await driver.close();
    expect(sent.some((m) => m.method === "Target.closeTarget")).toBe(true);
  });

  it("refuses navigation outside the allowlist without sending it", async () => {
    const { socket, sent } = fakeCdp((message) => {
      if (message.method === "Target.createTarget")
        return { targetId: "target-1" };
      if (message.method === "Target.attachToTarget")
        return { sessionId: "session-1" };
      return {};
    });
    const driver = await CdpBrowserDriver.connect(new CdpConnection(socket), {
      allowedDomains: ["accounts.example.test"],
    });
    await expect(driver.open("https://evil.example.test/")).rejects.toThrow(
      "approved domains",
    );
    expect(sent.some((m) => m.method === "Page.navigate")).toBe(false);
  });
});
