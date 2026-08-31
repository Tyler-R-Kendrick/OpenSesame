import { describe, expect, it } from "vitest";

import { createTeamsAdapter } from "../adapters/teams.js";
import { jsonFetch, renderInput } from "./helpers.js";

const WEBHOOK_URL =
  "https://example.webhook.office.com/webhookb2/abc/IncomingWebhook/def";

describe("teams is structurally notify-and-rendezvous only", () => {
  it("exposes no callback verifier at all", () => {
    const teams = createTeamsAdapter({ webhookUrl: WEBHOOK_URL });
    // Not "returns a refusal" — absent. There is no flag an operator or a
    // future refactor could flip to make Teams settle a request.
    expect(teams.verifyCallback).toBeUndefined();
    expect("verifyCallback" in teams).toBe(false);
  });

  it("declares that it cannot render decision actions", () => {
    const teams = createTeamsAdapter({ webhookUrl: WEBHOOK_URL });
    expect(teams.capabilities().canRenderDecisionActions).toBe(false);
    expect(teams.capabilities().canReceiveAuthenticatedCallback).toBe(false);
    expect(teams.capabilities().maximumInteractionMode).toBe("rendezvous");
  });

  it("exposes no update either, having no message handle to revise", () => {
    const teams = createTeamsAdapter({ webhookUrl: WEBHOOK_URL });
    expect(teams.update).toBeUndefined();
  });

  it("posts a card whose only action navigates", async () => {
    const recorder = jsonFetch("1");
    const teams = createTeamsAdapter({
      webhookUrl: WEBHOOK_URL,
      fetchImpl: recorder.impl,
    });
    const outcome = await teams.deliver(
      teams.render(renderInput({ kind: "teams" })),
      { channel: "teams" },
    );
    expect(outcome).toEqual({ status: "delivered" });
    const body = recorder.calls[0]?.body ?? "";
    expect(body).toContain('"@type":"OpenUri"');
    expect(body).not.toContain("HttpPOST");
    expect(body).not.toContain("ActionCard");
    expect(body).toContain("https://os.example/approve/rz-QHXT-KPLM");
  });

  it("escapes Markdown so requester text cannot forge a link in the card", async () => {
    const recorder = jsonFetch("1");
    const teams = createTeamsAdapter({
      webhookUrl: WEBHOOK_URL,
      fetchImpl: recorder.impl,
    });
    await teams.deliver(
      teams.render(
        renderInput({
          kind: "teams",
          bindingMessage: "[Approve here](https://evil.test)",
        }),
      ),
      { channel: "teams" },
    );
    const body = recorder.calls[0]?.body ?? "";
    expect(body).not.toContain("[Approve here](https://evil.test)");
    expect(body).toContain("\\\\[Approve here\\\\]");
  });
});

describe("teams configuration", () => {
  it("is unconfigured without an HTTPS webhook URL", () => {
    expect(createTeamsAdapter({}).isConfigured()).toBe(false);
    expect(
      createTeamsAdapter({
        webhookUrl: "http://insecure.test/hook",
      }).isConfigured(),
    ).toBe(false);
    expect(createTeamsAdapter({ webhookUrl: WEBHOOK_URL }).isConfigured()).toBe(
      true,
    );
  });

  it("re-checks a per-destination override rather than trusting the row", async () => {
    const recorder = jsonFetch("1");
    const teams = createTeamsAdapter({
      webhookUrl: WEBHOOK_URL,
      fetchImpl: recorder.impl,
    });
    const outcome = await teams.deliver(
      teams.render(renderInput({ kind: "teams" })),
      { channel: "teams", incomingWebhookUrl: "http://insecure.test/hook" },
    );
    expect(outcome).toEqual({
      status: "unconfigured",
      error: "no_webhook_url",
    });
    expect(recorder.calls).toHaveLength(0);
  });

  it("classifies a 500 as retryable and a 400 as permanent", async () => {
    const flaky = createTeamsAdapter({
      webhookUrl: WEBHOOK_URL,
      fetchImpl: jsonFetch("nope", 500).impl,
    });
    await expect(
      flaky.deliver(flaky.render(renderInput({ kind: "teams" })), {
        channel: "teams",
      }),
    ).resolves.toEqual({ status: "retryable", error: "status:500" });

    const rejected = createTeamsAdapter({
      webhookUrl: WEBHOOK_URL,
      fetchImpl: jsonFetch("nope", 400).impl,
    });
    await expect(
      rejected.deliver(rejected.render(renderInput({ kind: "teams" })), {
        channel: "teams",
      }),
    ).resolves.toEqual({ status: "permanent", error: "status:400" });
  });
});
