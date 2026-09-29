import { describe, expect, it } from "vitest";
import { FillError } from "./daemon";
import { createFillService } from "./service";
import { VALUE, ask, guardSender, harness, popup } from "./service-harness";
import { fillRequest } from "./wire";

describe("the background fill flow", () => {
  it("arms one gesture, answers the guard with the value, and tells the popup only an outcome", async () => {
    const h = harness();
    const service = createFillService(h.ports);
    let valueReply: unknown;
    h.guard = () => {
      // The guard, having checked the page, asks for the value.
      return service
        .handle(
          ask({
            op: "value",
            nonce: h.sent[0]?.nonce ?? "",
            field: "password",
          }),
          guardSender(),
        )
        .then((reply) => {
          valueReply = reply;
          return { outcome: "filled" };
        });
    };
    const result = await service.handle(ask({ op: "trigger" }), popup);
    expect(result).toEqual({ outcome: "filled" });
    expect(valueReply).toEqual({ value: VALUE });
    expect(h.daemonCalls).toContain(
      "value Web/example.com https://example.com password",
    );
    // No arm message and nothing stored carries the value.
    expect(JSON.stringify(h.sent)).not.toContain(VALUE);
    expect(JSON.stringify([...h.stored])).not.toContain(VALUE);
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  it("refuses a value request nobody armed: a page cannot trigger a fill", async () => {
    const h = harness();
    const service = createFillService(h.ports);
    const reply = await service.handle(
      ask({ op: "value", nonce: "guessed", field: "password" }),
      guardSender(),
    );
    expect(reply).toEqual({ refusal: "unknown_gesture" });
    expect(h.daemonCalls).toEqual([]);
  });

  it("refuses the value to a cross-origin iframe of the armed tab", async () => {
    const h = harness();
    const service = createFillService(h.ports);
    let valueReply: unknown;
    h.guard = async (message) => {
      valueReply = await service.handle(
        ask({ op: "value", nonce: message.nonce, field: "password" }),
        guardSender({ frameId: 4, origin: "https://ads.test" }),
      );
      return { outcome: "no_value" };
    };
    await service.trigger("command");
    expect(valueReply).toEqual({ refusal: "not_top_frame" });
    expect(h.daemonCalls.filter((c) => c.startsWith("value"))).toEqual([]);
  });

  it("refuses the value when the tab has navigated to another origin", async () => {
    const h = harness();
    const service = createFillService(h.ports);
    let valueReply: unknown;
    h.guard = async (message) => {
      valueReply = await service.handle(
        ask({ op: "value", nonce: message.nonce, field: "password" }),
        guardSender({ origin: "https://evil.test", url: "https://evil.test/" }),
      );
      return {};
    };
    await service.trigger("command");
    expect(valueReply).toEqual({ refusal: "origin_mismatch" });
  });

  it("does not let a page's content script run popup operations", async () => {
    const service = createFillService(harness().ports);
    expect(await service.handle(ask({ op: "trigger" }), guardSender())).toEqual(
      {
        error: "forbidden_sender",
      },
    );
    expect(
      await service.handle(ask({ op: "status" }), { id: "other-extension" }),
    ).toEqual({ error: "forbidden_sender" });
    expect(
      fillRequest.safeParse({ type: "opensesame.fill", op: "toString" })
        .success,
    ).toBe(false);
  });

  it("arms nothing for a page with no web origin", async () => {
    const h = harness();
    h.ports.activeTab = async () => ({ id: 3, url: "chrome://settings" });
    const service = createFillService(h.ports);
    expect(await service.trigger("command")).toEqual({ outcome: "no_page" });
    expect(h.sent).toEqual([]);
  });

  it("asks the person to choose when more than one entry matches", async () => {
    const h = harness({ match: async () => ["Web/a", "Web/b"] });
    const service = createFillService(h.ports);
    expect(await service.trigger("command")).toEqual({
      outcome: "choose_in_popup",
    });
    expect(h.sent).toEqual([]);
    await service.handle(ask({ op: "trigger", reference: "Web/b" }), popup);
    expect(h.sent.at(-1)?.trigger).toBe("popup");
    // The choice is remembered for this origin, as a reference.
    h.sent.length = 0;
    await service.trigger("command");
    expect(h.sent).toHaveLength(1);
    expect([...h.stored.values()]).toEqual(["Web/b"]);
  });

  it("refuses a chosen reference the daemon does not match to this origin", async () => {
    const h = harness();
    const service = createFillService(h.ports);
    expect(
      await service.handle(
        ask({ op: "trigger", reference: "Web/elsewhere" }),
        popup,
      ),
    ).toEqual({ outcome: "no_match" });
    expect(h.sent).toEqual([]);
  });

  it("reports status with a passkey probe and no value", async () => {
    const h = harness();
    h.guard = (message) => ({ passkey: message.mode === "probe" });
    const service = createFillService(h.ports);
    expect(await service.handle(ask({ op: "status" }), popup)).toEqual({
      origin: "https://example.com",
      enabled: true,
      references: ["Web/example.com"],
      passkey: true,
    });
    expect(service.ledger.size).toBe(0);
  });

  it("reports an unpaired extension", async () => {
    const h = harness({
      match: async () => {
        throw new FillError("not_paired");
      },
    });
    const status = await createFillService(h.ports).status();
    expect(status.error).toBe("not_paired");
    expect(status.references).toEqual([]);
  });
});
