import { expect, it } from "vitest";
import {
  type AuditEvent,
  isReceiptEvent,
  outcomeChip,
  receiptLabel,
  receiptTarget,
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
    "access.connection.granted",
    "agent.run.finished",
    "connection.binding.bound",
  ])
    expect(isReceiptEvent({ ...base, eventType }), eventType).toBe(true);
  expect(isReceiptEvent({ ...base, eventType: "auth.login" })).toBe(false);
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

it("marks a refusal as a warning and a failure as an error", () => {
  expect(outcomeChip("denied")).toBe("chip--warn");
  expect(outcomeChip("failed")).toBe("chip--err");
  expect(outcomeChip("succeeded")).toBe("chip--ok");
});
