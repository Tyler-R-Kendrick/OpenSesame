import { describe, expect, it } from "vitest";
import { FillError } from "./daemon";
import { createFillService } from "./service";
import { ask, guardSender, harness, popup } from "./service-harness";

describe("autofill only on sites a person switched on", () => {
  it("never fills a site nobody switched on, not even from the command", async () => {
    const h = harness();
    h.enabled.clear();
    const service = createFillService(h.ports);
    expect(await service.trigger("command")).toEqual({ outcome: "site_off" });
    expect(await service.handle(ask({ op: "trigger" }), popup)).toEqual({
      outcome: "site_off",
    });
    expect(h.sent).toEqual([]);
    expect(h.daemonCalls).toEqual([]);
    expect(h.injected).toEqual([]);
  });

  it("refuses the value when the site was switched off after the gesture", async () => {
    const h = harness();
    const service = createFillService(h.ports);
    let valueReply: unknown;
    h.guard = async (message) => {
      h.enabled.clear();
      valueReply = await service.handle(
        ask({ op: "value", nonce: message.nonce, field: "password" }),
        guardSender(),
      );
      return { outcome: "no_value" };
    };
    await service.trigger("command");
    expect(valueReply).toEqual({ refusal: "site_off" });
    expect(h.daemonCalls.filter((c) => c.startsWith("value"))).toEqual([]);
  });

  it("reports a site that is off without probing the page or asking the daemon", async () => {
    const h = harness();
    h.enabled.clear();
    const status = await createFillService(h.ports).status();
    expect(status).toEqual({
      origin: "https://example.com",
      enabled: false,
      references: [],
      passkey: false,
    });
    expect(h.sent).toEqual([]);
    expect(h.daemonCalls).toEqual([]);
  });

  it("switches on only the origin of the tab in view", async () => {
    const h = harness();
    h.enabled.clear();
    const service = createFillService(h.ports);
    expect(
      await service.handle(
        ask({ op: "enable", origin: "https://bank.example" }),
        popup,
      ),
    ).toEqual({ error: "origin_mismatch" });
    expect(h.enabled.size).toBe(0);
    const status = await service.handle(
      ask({ op: "enable", origin: "https://example.com" }),
      popup,
    );
    expect(h.enabled.has("https://example.com")).toBe(true);
    expect(status).toMatchObject({
      origin: "https://example.com",
      enabled: true,
    });
  });

  it("does not let a page's content script switch a site on or off", async () => {
    const h = harness();
    h.enabled.clear();
    const service = createFillService(h.ports);
    for (const op of ["enable", "disable", "status"]) {
      expect(
        await service.handle(
          ask({ op, origin: "https://example.com" }),
          guardSender(),
        ),
      ).toEqual({ error: "forbidden_sender" });
    }
    expect(h.enabled.size).toBe(0);
  });

  it("switches the site in view off", async () => {
    const h = harness();
    const service = createFillService(h.ports);
    const status = await service.handle(ask({ op: "disable" }), popup);
    expect(h.enabled.size).toBe(0);
    expect(status).toMatchObject({ enabled: false });
  });

  it("injects the guard only as a fallback, into a switched-on site's top frame", async () => {
    const h = harness();
    const service = createFillService(h.ports);
    let first = true;
    h.guard = () => {
      if (first) {
        first = false;
        throw new Error(
          "Could not establish connection. Receiving end does not exist.",
        );
      }
      return { outcome: "filled" };
    };
    expect(await service.trigger("command")).toEqual({ outcome: "filled" });
    expect(h.injected).toEqual([7]);
  });

  it("says the plugin is off when the daemon answers like it has no fill route", async () => {
    const h = harness({
      match: async () => {
        throw new FillError("plugin_off");
      },
    });
    const service = createFillService(h.ports);
    expect((await service.status()).error).toBe("plugin_off");
    expect(await service.trigger("command")).toEqual({ outcome: "plugin_off" });
    expect(h.sent.filter((m) => m.mode === "fill")).toEqual([]);
  });

  it("asks the daemon for a pairing code only from the popup", async () => {
    const h = harness({
      pair: async () => ({ state: "pending", code: "ABCDEFGH" }),
    });
    const service = createFillService(h.ports);
    expect(await service.pairFrom(popup)).toEqual({
      state: "pending",
      code: "ABCDEFGH",
    });
    expect(await service.pairFrom(guardSender())).toEqual({
      error: "forbidden_sender",
    });
  });
});
