/** @vitest-environment jsdom */
import { savedBoatConnection } from "@opensesame/app-core/lib/boat-ceremony.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { installConnectorIntegration } from "../connect/native-connector-integration.test-support.js";
import { BoatPanels } from "./BoatPanels.js";
import { boatCeremonyDependencies } from "./useBoatCeremony.js";

installConnectorIntegration();
afterEach(cleanup);

function fakeBoatTransport() {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/boat/agent/identity"))
      return Response.json({
        claim_token: "clm_panel_test",
        claim: {
          user_code: "654321",
          verification_uri:
            "https://boat.dev/api/boat/agent/identity/claim",
          expires_in: 600,
          interval: 0,
        },
      });
    if (url.endsWith("/api/boat/oauth2/token")) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (form.get("grant_type")?.includes("jwt-bearer"))
        return Response.json({ access_token: "tok_panel" });
      return Response.json({
        access_token: "tok_panel",
        identity_assertion: "assertion_panel",
      });
    }
    if (url.endsWith("/api/v1/me"))
      return Response.json({
        ok: true,
        user: { login: "person@example.test", email: "person@example.test" },
      });
    if (url.endsWith("/api/v1/limits"))
      return Response.json({
        ok: true,
        accessTier: "trial",
        blockedReason: "subscription_required",
      });
    if (url.endsWith("/api/boat/billing/checkout"))
      return Response.json({
        success: true,
        url: "https://checkout.stripe.com/c/pay/cs_test_panel",
      });
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl };
}

it("runs the claim ceremony: email, code, sealed connection, billing gate", async () => {
  boatCeremonyDependencies.transport = fakeBoatTransport;
  const onFlash = vi.fn();
  const onChanged = vi.fn();
  render(
    <BoatPanels connection={null} onFlash={onFlash} onChanged={onChanged} />,
  );
  await userEvent.type(
    screen.getByLabelText("Boat account email"),
    "person@example.test",
  );
  await userEvent.click(
    screen.getByRole("button", { name: /start claim/i }),
  );
  expect(await screen.findByText("654321")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: /claim this account/i }),
  ).toBeTruthy();
  // The poll sees the claim complete, seals the connection, and lands
  // on the billing step Boat still requires.
  expect(
    await screen.findByRole(
      "button",
      { name: /open boat checkout/i },
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  await waitFor(() => expect(savedBoatConnection()).not.toBeNull());
  expect(onChanged).toHaveBeenCalled();
});
