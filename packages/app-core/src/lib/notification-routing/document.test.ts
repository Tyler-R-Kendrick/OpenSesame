import { describe, expect, it } from "vitest";
import {
  type NotificationRoutingDocument,
  addChannel,
  emptyRoutingDocument,
  moveChannel,
  parseRoutingDocument,
  preferenceFor,
  removeChannel,
  routingFromWire,
  routingToWire,
  serializeRoutingDocument,
  setFanOut,
} from "./document.js";

const DOC: NotificationRoutingDocument = {
  version: 1,
  byClass: {
    authorization_request: { channels: ["telegram", "in_app"], fanOut: false },
    security_event: { channels: ["in_app"], fanOut: false },
  },
};

describe("the routing document", () => {
  it("round-trips through its canonical text", () => {
    const text = serializeRoutingDocument(DOC);
    expect(text.endsWith("}\n")).toBe(true);
    const parsed = parseRoutingDocument(JSON.parse(text));
    expect(parsed).toEqual({ ok: true, document: DOC });
    // Canonical: class order is os-domain's, whatever order it was written in.
    const shuffled: NotificationRoutingDocument = {
      version: 1,
      byClass: {
        security_event: DOC.byClass.security_event,
        authorization_request: DOC.byClass.authorization_request,
      },
    };
    expect(serializeRoutingDocument(shuffled)).toBe(text);
  });

  it("refuses a document that tries to set what it takes to approve", () => {
    const widened = {
      version: 1,
      directApprovalChannels: ["telegram"],
      byClass: {
        authorization_request: {
          channels: ["telegram"],
          fanOut: false,
          requireTransactionBoundActivation: false,
        },
      },
    };
    const parsed = parseRoutingDocument(widened);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.join(" ")).toMatch(
        /directApprovalChannels cannot set what it takes to approve/,
      );
      expect(parsed.errors.join(" ")).toMatch(
        /requireTransactionBoundActivation cannot set/,
      );
    }
  });

  it("refuses an unknown channel, class or version whole", () => {
    for (const bad of [
      { version: 1, byClass: { authorization_request: { channels: ["fax"] } } },
      { version: 1, byClass: { marketing: { channels: ["in_app"] } } },
      { version: 2, byClass: {} },
      { version: 1, byClass: { security_event: { channels: ["sms", "sms"] } } },
      {
        version: 1,
        byClass: { security_event: { channels: [], fanOut: "yes" } },
      },
      "not a document",
    ]) {
      expect(parseRoutingDocument(bad).ok).toBe(false);
    }
  });

  it("reads the Identity API's byClass, and writes it back", () => {
    const document = routingFromWire(JSON.parse(JSON.stringify(DOC.byClass)));
    expect(document).toEqual(DOC);
    expect(routingToWire(DOC)).toEqual({ byClass: DOC.byClass });
    expect(
      routingFromWire({ authorization_request: { channels: ["fax"] } }),
    ).toBeNull();
  });
});

describe("edits", () => {
  it("routes a class nobody configured to the inbox", () => {
    expect(
      preferenceFor(emptyRoutingDocument(), "authorization_decision"),
    ).toEqual({
      channels: ["in_app"],
      fanOut: false,
    });
  });

  it("moves a channel later, and returns the same document when nothing moved", () => {
    const moved = moveChannel(DOC, "authorization_request", 0, 1);
    expect(moved.byClass.authorization_request?.channels).toEqual([
      "in_app",
      "telegram",
    ]);
    expect(moveChannel(DOC, "authorization_request", 1, 1)).toBe(DOC);
    expect(moveChannel(DOC, "authorization_request", 0, -1)).toBe(DOC);
    // The original is untouched: edits are pure.
    expect(DOC.byClass.authorization_request?.channels).toEqual([
      "telegram",
      "in_app",
    ]);
  });

  it("adds and removes, and never removes the inbox", () => {
    const added = addChannel(DOC, "security_event", "slack");
    expect(added.byClass.security_event?.channels).toEqual(["in_app", "slack"]);
    expect(addChannel(added, "security_event", "slack")).toBe(added);
    const removed = removeChannel(added, "security_event", "slack");
    expect(removed.byClass.security_event?.channels).toEqual(["in_app"]);
    expect(removeChannel(DOC, "security_event", "in_app")).toBe(DOC);
  });

  it("toggles fan-out", () => {
    const on = setFanOut(DOC, "security_event", true);
    expect(on.byClass.security_event?.fanOut).toBe(true);
    expect(setFanOut(on, "security_event", true)).toBe(on);
  });
});
