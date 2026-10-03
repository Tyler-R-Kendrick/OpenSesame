import { describe, expect, it } from "vitest";
import { open, setup } from "./test-support/driver-rig";
import { CURRENT } from "./test-support/rig";
import { RP } from "./test-support/site";

describe("read_dom_redacted", () => {
  it("scrubs every value the runner knows even from page text a site echoes back", async () => {
    const { step, pages, r } = await setup();
    await open(step);
    const handle = `candidate:${crypto.randomUUID()}`;
    await step({ step: "generate_candidate", handle });
    const candidate = (
      await r.vault.secrets({ runId: "run:1", origin: RP })
    ).find((v) => v !== CURRENT);
    expect(candidate).toBeDefined();
    for (const echo of [candidate ?? "", CURRENT]) {
      const body = pages.dom.window.document.body;
      body.insertAdjacentHTML(
        "beforeend",
        `<div>echo ${echo}</div><a title="${echo}">x</a>`,
      );
    }
    const outcome = await step({ step: "read_dom_redacted", strip: [] });
    expect(outcome.outcome).toBe("dom");
    const text = outcome.outcome === "dom" ? outcome.text : "";
    expect(text).not.toContain(CURRENT);
    expect(text).not.toContain(candidate ?? "?");
    expect(text).toContain("[redacted]");
  });

  it("reports an epoch that moves only when the layout does", async () => {
    const { step, pages } = await setup();
    await open(step);
    const read = async () => {
      const o = await step({ step: "read_dom_redacted", strip: [] });
      return o.outcome === "dom" ? o.epoch : -1;
    };
    const first = await read();
    expect(await read()).toBe(first);
    const field = pages.dom.window.document.querySelector("#new");
    if (!field) throw new Error("no field");
    field.getBoundingClientRect = () => ({
      left: 1,
      top: 2,
      width: 3,
      height: 4,
      right: 4,
      bottom: 6,
      x: 1,
      y: 2,
      toJSON: () => ({}),
    });
    expect(await read()).toBe(first + 1);
  });
});

describe("screenshot_redacted", () => {
  it("covers the requested boxes and says how many it covered", async () => {
    const { step } = await setup();
    await open(step);
    const outcome = await step({
      step: "screenshot_redacted",
      epoch: 0,
      mask_selectors: ["#current", "#new", "#missing"],
    });
    expect(outcome).toMatchObject({ outcome: "frame", masked_boxes: 2 });
  });

  it("moves the epoch when the page moved between the mask and the still", async () => {
    const { step, pages } = await setup();
    await open(step);
    const read = await step({ step: "read_dom_redacted", strip: [] });
    const epoch = read.outcome === "dom" ? read.epoch : -1;
    pages.moveBeforeStill = () => {
      const field = pages.dom.window.document.querySelector("#new");
      if (field) {
        field.getBoundingClientRect = () => ({
          left: 9,
          top: 9,
          width: 9,
          height: 9,
          right: 18,
          bottom: 18,
          x: 9,
          y: 9,
          toJSON: () => ({}),
        });
      }
    };
    const outcome = await step({
      step: "screenshot_redacted",
      epoch,
      mask_selectors: ["#new"],
    });
    expect(outcome.outcome === "frame" ? outcome.epoch : -1).toBe(epoch + 1);
  });

  it("fails when a still the Host can store cannot be taken", async () => {
    const { step, pages } = await setup();
    await open(step);
    pages.capture = async () => null;
    expect(
      await step({ step: "screenshot_redacted", epoch: 0, mask_selectors: [] }),
    ).toEqual({ outcome: "failed", error: "transport" });
  });
});
