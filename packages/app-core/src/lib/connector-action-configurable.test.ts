import { expect, it } from "vitest";
import { isRefusedPlan } from "./connect-plan.js";
import { connectorCardAction } from "./connector-action-capability.js";
it("opens a compiled configuration route without promoting a saved draft to verified", () => {
  const provider = { id: "resend" };
  const connection = {
    providerId: provider.id,
    connectionId: "saved-draft",
    status: "active" as const,
  };
  const routes = [
    { method: "oauth" as const, available: false, configurable: true },
  ];
  expect(connectorCardAction(provider, { routes, now: 1 })).toMatchObject({
    kind: "connect",
    method: "oauth",
  });
  expect(
    connectorCardAction(provider, { routes, connection, now: 1 }),
  ).toMatchObject({ kind: "resume" });
  expect(
    connectorCardAction(provider, {
      routes: [{ ...routes[0], configurable: false }],
      now: 1,
    }),
  ).toMatchObject({ kind: "unavailable" });
  expect(isRefusedPlan("agentcard")).toBe(false);
  expect(
    connectorCardAction(
      { id: "agentcard" },
      {
        routes: [{ method: "api-key", available: false, configurable: true }],
        now: 1,
      },
    ),
  ).toMatchObject({ kind: "connect", method: "api-key" });
  expect(
    connectorCardAction({ id: "unknown-provider" }, { routes: [], now: 1 }),
  ).toMatchObject({ kind: "unavailable" });
});
