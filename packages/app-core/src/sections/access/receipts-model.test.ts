import { expect, it } from "vitest";
import { RECEIPT_EVENT_TYPES } from "../../lib/device-receipts.js";
import {
  type AuditEvent,
  isReceiptEvent,
  outcomeChip,
  receiptLabel,
  receiptTarget,
  receiptWords,
} from "./receipts-model.js";

const base = {
  id: "e1",
  occurredAt: "2026-10-04T00:00:00.000Z",
  outcome: "succeeded",
};

it("counts what the device decided as a receipt, with what an agent did", () => {
  for (const eventType of [
    "access.request.approved",
    "access.sign_in.revoked",
    "access.siop.denied",
    "access.session.revoked",
    "agent.run.finished",
    "connection.binding.bound",
  ])
    expect(isReceiptEvent({ ...base, eventType }), eventType).toBe(true);
  expect(isReceiptEvent({ ...base, eventType: "auth.login" })).toBe(false);
  // An `access.*` event the device does not word is not this panel's to show.
  for (const eventType of [
    "access.connection.granted",
    "access.something.remote",
  ])
    expect(isReceiptEvent({ ...base, eventType }), eventType).toBe(false);
  expect(
    isReceiptEvent({ ...base, eventType: "auth.login", actorType: "agent" }),
  ).toBe(true);
});

it("says each decision in words, and any other event as it was named", () => {
  expect(receiptLabel("access.sign_in.granted")).toBe("Application signed in");
  expect(receiptLabel("access.request.withdrawn")).toBe("Request withdrawn");
  expect(receiptLabel("provider.thing.happened")).toBe(
    "provider.thing.happened",
  );
});

it("names the thing a receipt is about only when its metadata does", () => {
  const event: AuditEvent = {
    ...base,
    eventType: "access.request.created",
    metadata: { targetType: "application", targetId: "local_x" },
  };
  expect(receiptTarget(event)).toEqual({ type: "application", id: "local_x" });
  expect(
    receiptTarget({ ...event, metadata: { targetType: "application" } }),
  ).toBe(null);
  expect(receiptTarget({ ...event, metadata: undefined })).toBe(null);
});

it("words one refused drop with the wrong-code count it carries", () => {
  const refused: AuditEvent = {
    ...base,
    eventType: "access.drop.refused",
    outcome: "denied",
  };
  expect(receiptWords(refused)).toBe("Drop refused");
  expect(receiptWords({ ...refused, metadata: { count: 1 } })).toBe(
    "Refused · 1 wrong code",
  );
  expect(receiptWords({ ...refused, metadata: { count: 3 } })).toBe(
    "Refused · 3 wrong codes",
  );
  expect(receiptWords({ ...refused, metadata: { count: 0 } })).toBe(
    "Drop refused",
  );
});

it("marks a refusal as a warning and a failure as an error", () => {
  expect(outcomeChip("denied")).toBe("chip--warn");
  expect(outcomeChip("failed")).toBe("chip--err");
  expect(outcomeChip("succeeded")).toBe("chip--ok");
});

it("has words for every decision the device can record, and no other", () => {
  for (const eventType of RECEIPT_EVENT_TYPES)
    expect(receiptLabel(eventType), eventType).not.toBe(eventType);
  expect(receiptLabel("access.session.revoked")).toBe("Session ended");
});
