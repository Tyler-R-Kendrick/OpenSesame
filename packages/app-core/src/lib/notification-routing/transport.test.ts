import { channelCapabilities } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { RoutingError, routingClient } from "./transport.js";

describe("routing refusals", () => {
  it("words a refusal by its code first, then its status", () => {
    const stepUp = new RoutingError(403, "step_up_required").message;
    expect(stepUp).toMatch(/needs a recent sign-in/);
    // Not the approval vocabulary's "not addressed to you".
    expect(stepUp).not.toMatch(/addressed to you/);
    expect(new RoutingError(409, "destination_already_bound").message).toMatch(
      /another account/,
    );
    expect(new RoutingError(401, "").message).toMatch(/Sign in/);
    expect(new RoutingError(0, "").message).toMatch(/could not be reached/);
    expect(new RoutingError(418, "constructor").message).toBe(
      "That did not go through (418). Nothing changed.",
    );
  });

  it("says unreachable when nothing reached the server", async () => {
    const client = routingClient({
      fetch: async () => {
        throw new TypeError("offline");
      },
      signedIn: () => true,
    });
    await expect(client.channels()).rejects.toMatchObject({ status: 0 });
  });

  it("opens nothing but an https authorize address", async () => {
    const answer = (authorizeUrl: string) =>
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              challengeId: "chbc_1",
              nonce: "n0nce",
              expiresAt: "x",
              authorizeUrl,
            }),
            { status: 201 },
          ),
      );
    const catalogue = [
      {
        kind: "slack" as const,
        name: "Slack",
        configured: true,
        bindable: true,
        sentence: "",
        capabilities: channelCapabilities("slack"),
      },
    ];
    const safe = routingClient({
      fetch: answer("https://slack.example/oauth"),
      signedIn: () => true,
    });
    const unsafe = routingClient({
      fetch: answer("javascript:alert(1)"),
      signedIn: () => true,
    });

    expect((await safe.beginBinding("slack", catalogue)).authorizeUrl).toBe(
      "https://slack.example/oauth",
    );
    const refused = await unsafe.beginBinding("slack", catalogue);
    expect(refused.authorizeUrl).toBeUndefined();
    expect(refused.words).toMatch(/waiting to be confirmed/);
  });
});
