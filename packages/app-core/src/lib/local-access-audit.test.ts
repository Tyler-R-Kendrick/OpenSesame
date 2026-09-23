import { assertNoSentinels } from "@opensesame/testing";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  listAccessAuditEvents,
  recordAccessAuditEvent,
  sanitizeConnectionEvent,
} from "./local-access-audit.js";
import { localRequestFixture } from "./local-request.fixture.js";
import { lockAllTombs } from "./vfs.js";

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
});

afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("records allowlisted Access audit metadata and drops SII/PII keys", async () => {
  const fixture = await localRequestFixture();
  await recordAccessAuditEvent(fixture.tomb, {
    eventType: "access.connection.granted",
    outcome: "succeeded",
    targetType: "connection",
    targetId: "github",
    metadata: {
      providerId: "github",
      connectionId: "con_gh",
      resourceType: "connection",
      resourceId: "github",
      action: "grant",
      kind: "share",
      // Must never survive redaction:
      accountLogin: "octocat",
      email: "octo@example.com",
      fullName: "octocat/secrets",
      displayName: "Ada Lovelace",
      token: "ghp_sentinel_should_drop",
    },
  });

  const events = await listAccessAuditEvents(fixture.tomb);
  expect(events).toHaveLength(1);
  const event = events[0];
  if (!event) throw new Error("missing event");
  expect(event.eventType).toBe("access.connection.granted");
  expect(event.metadata).toEqual({
    providerId: "github",
    connectionId: "con_gh",
    resourceType: "connection",
    resourceId: "github",
    action: "grant",
    kind: "share",
  });
  assertNoSentinels(JSON.stringify(event));
  const serialized = JSON.stringify(event);
  expect(serialized).not.toContain("octocat");
  expect(serialized).not.toContain("example.com");
  expect(serialized).not.toContain("Ada Lovelace");
  expect(serialized).not.toContain("ghp_");
});

it("scrubs free-text Host connection event detail", () => {
  expect(
    sanitizeConnectionEvent({
      id: "e1",
      kind: "bound",
      at: "2026-09-18T12:00:00Z",
      detail: "identity · owner",
    }).detail,
  ).toBeNull();
  expect(
    sanitizeConnectionEvent({
      id: "e2",
      kind: "bound",
      at: "2026-09-18T12:00:00Z",
      detail: "identity",
    }).detail,
  ).toBe("identity");
});
