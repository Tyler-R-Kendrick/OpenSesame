import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createBridge } from "./bridge.js";
import { POPUP_MESSAGE, handlePopup, parsePopupMessage } from "./popup-api.js";
import { EXTENSION_ID, fakePorts } from "./test-ports.js";

const APP = "https://opensesame-labs.github.io";
const table = [
  { providerId: "plivo", authorities: ["api.plivo.com"] },
] as const;
const popup = {
  id: EXTENSION_ID,
  tabId: undefined,
  frameId: undefined,
  url: undefined,
};

describe("what the popup may ask", () => {
  it("decodes the five actions", () => {
    expect(
      parsePopupMessage({
        type: POPUP_MESSAGE,
        action: "status",
        origin: `${APP}/x`,
      }),
    ).toEqual({ action: "status", origin: APP });
    expect(
      parsePopupMessage({ type: POPUP_MESSAGE, action: "status" }),
    ).toEqual({ action: "status", origin: null });
    expect(
      parsePopupMessage({ type: POPUP_MESSAGE, action: "enable", origin: APP }),
    ).toEqual({ action: "enable", origin: APP });
    expect(
      parsePopupMessage({
        type: POPUP_MESSAGE,
        action: "disable",
        origin: APP,
      }),
    ).toEqual({ action: "disable", origin: APP });
    expect(
      parsePopupMessage({ type: POPUP_MESSAGE, action: "granted" }),
    ).toEqual({ action: "granted" });
    expect(
      parsePopupMessage({
        type: POPUP_MESSAGE,
        action: "revoke",
        host: "api.plivo.com",
      }),
    ).toEqual({
      action: "revoke",
      host: "api.plivo.com",
    });
  });

  it.each([
    [null],
    ["x"],
    [{ type: "other", action: "granted" }],
    [{ type: POPUP_MESSAGE, action: "eval" }],
    [{ type: POPUP_MESSAGE, action: "enable", origin: "http://example.com" }],
    [{ type: POPUP_MESSAGE, action: "revoke", host: "Bad Host" }],
    [{ type: POPUP_MESSAGE }],
  ] satisfies [BoundaryValue][])("refuses %j", (message) => {
    expect(parsePopupMessage(message)).toBeNull();
  });
});

describe("what the popup is told and does", () => {
  it("reports this origin, what waits and what is allowed, naming the providers", async () => {
    const fake = fakePorts();
    const bridge = createBridge(fake.ports, table, "0.1.0");
    await bridge.hosts.ask(["api.plivo.com"]);
    const reply = await handlePopup(
      bridge,
      { action: "status", origin: APP },
      popup,
    );
    expect(reply).toEqual({
      status: {
        origin: APP,
        enabled: false,
        pending: [{ host: "api.plivo.com", providers: ["plivo"] }],
        granted: [],
      },
    });
    fake.hosts.add("api.plivo.com");
    expect(
      await handlePopup(bridge, { action: "status", origin: null }, popup),
    ).toMatchObject({
      status: {
        enabled: false,
        pending: [],
        granted: [{ host: "api.plivo.com", providers: ["plivo"] }],
      },
    });
  });

  it("switches an origin on and off", async () => {
    const fake = fakePorts();
    const bridge = createBridge(fake.ports, table, "0.1.0");
    expect(
      await handlePopup(bridge, { action: "enable", origin: APP }, popup),
    ).toEqual({ outcome: "permission_not_granted" });
    fake.origins.add(APP);
    expect(
      await handlePopup(bridge, { action: "enable", origin: APP }, popup),
    ).toEqual({ outcome: "enabled" });
    expect(
      await handlePopup(bridge, { action: "disable", origin: APP }, popup),
    ).toEqual({ outcome: "done" });
    expect(fake.registered.size).toBe(0);
  });

  it("reads a grant back and gives one back", async () => {
    const fake = fakePorts();
    const bridge = createBridge(fake.ports, table, "0.1.0");
    await bridge.hosts.ask(["api.plivo.com"]);
    fake.hosts.add("api.plivo.com");
    expect(await handlePopup(bridge, { action: "granted" }, popup)).toEqual({
      outcome: "done",
    });
    expect(fake.state.badge).toBe("");
    expect(
      await handlePopup(
        bridge,
        { action: "revoke", host: "api.plivo.com" },
        popup,
      ),
    ).toEqual({ outcome: "done" });
    expect(fake.hosts.size).toBe(0);
  });

  it("answers nothing to a message that came from a tab", async () => {
    const fake = fakePorts();
    const bridge = createBridge(fake.ports, table, "0.1.0");
    const fromTab = { ...popup, tabId: 3, frameId: 0, url: APP };
    for (const action of [
      { action: "status", origin: APP },
      { action: "enable", origin: APP },
      { action: "granted" },
      { action: "revoke", host: "api.plivo.com" },
    ] as const)
      expect(await handlePopup(bridge, action, fromTab)).toEqual({
        error: "forbidden_sender",
      });
    expect(fake.registered.size).toBe(0);
  });
});
