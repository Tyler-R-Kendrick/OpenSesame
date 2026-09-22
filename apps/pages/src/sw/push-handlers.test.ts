import { describe, expect, it } from "vitest";
import { installPushHandlers } from "./push-handlers.js";
import { FakeWorkerEnv } from "./test-env.js";

describe("push variant handlers (PWA-01, ADR 0084)", () => {
  it("shows a closed-table notification and never the payload's text", async () => {
    const env = new FakeWorkerEnv();
    installPushHandlers(env.sw);
    await env.dispatch("push", {
      data: {
        json: () => ({
          kind: "authorization_request",
          action: "review",
          ref: "abc_123",
          authorizationDetails: "SECRET",
        }),
      },
    });
    expect(env.notifications).toEqual([
      {
        title: "Authorization requested",
        options: {
          body: "Open OpenSesame to review it.",
          tag: "opensesame-approval-abc_123",
          data: { ref: "abc_123" },
        },
      },
    ]);
    expect(JSON.stringify(env.notifications)).not.toContain("SECRET");
  });

  it("a malformed body still rings, generically", async () => {
    const env = new FakeWorkerEnv();
    installPushHandlers(env.sw);
    await env.dispatch("push", {
      data: {
        json: () => {
          throw new SyntaxError("bad json");
        },
      },
    });
    expect(env.notifications[0]?.options.body).toBe("Open OpenSesame.");
  });

  it("a click focuses and navigates an in-scope window, else opens one", async () => {
    const env = new FakeWorkerEnv();
    installPushHandlers(env.sw);
    const open = env.clients.add({
      id: "w",
      url: `${env.scope}vault`,
      controlled: false,
    });
    let closed = 0;
    const notification = {
      data: { ref: "abc_123" },
      close: () => {
        closed += 1;
      },
    };
    await env.dispatch("notificationclick", { notification });
    expect(closed).toBe(1);
    expect(open.focused).toBe(1);
    expect(open.navigatedTo).toEqual([`${env.scope}approve/abc_123`]);
    expect(env.clients.opened).toEqual([]);

    env.clients.remove("w");
    await env.dispatch("notificationclick", { notification });
    expect(env.clients.opened).toEqual([`${env.scope}approve/abc_123`]);
  });
});
