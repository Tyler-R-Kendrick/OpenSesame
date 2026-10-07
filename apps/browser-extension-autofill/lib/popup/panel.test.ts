// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type {
  ErrorReply,
  FillStatus,
  OutcomeReply,
  PairState,
} from "../fill/wire";
import { DAEMON_PATTERN } from "../sites/patterns";
import { type PanelElements, type PanelPorts, mountPanel } from "./panel";

function byId<T extends HTMLElement>(id: string, kind: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof kind)) throw new Error(`missing #${id}`);
  return found;
}

function elements(): PanelElements {
  document.body.innerHTML = `
    <p id="o"></p>
    <button id="site" role="switch" aria-label="Autofill on this site" title="Autofill on this site"></button>
    <button id="pair" aria-label="Pair" title="Pair"></button>
    <output id="code"></output>
    <fieldset id="refs"><legend>Entry</legend></fieldset>
    <button id="go" aria-label="Fill" title="Fill"></button>
    <span id="mark" role="img"></span>`;
  return {
    origin: byId("o", HTMLParagraphElement),
    site: byId("site", HTMLButtonElement),
    pair: byId("pair", HTMLButtonElement),
    code: byId("code", HTMLOutputElement),
    refs: byId("refs", HTMLFieldSetElement),
    go: byId("go", HTMLButtonElement),
    mark: byId("mark", HTMLSpanElement),
  };
}

const ON: FillStatus = {
  origin: "https://example.com",
  enabled: true,
  references: ["Web/example.com"],
  passkey: false,
};
const OFF: FillStatus = { ...ON, enabled: false };
const FILLED: OutcomeReply = { outcome: "filled" };

/** What the fake background answers, and what the popup asked of it. */
interface Fake extends PanelPorts {
  readonly calls: string[];
  readonly asked: string[][];
}

interface Answers {
  readonly status: FillStatus | ErrorReply;
  readonly enable?: FillStatus;
  readonly disable?: FillStatus;
  readonly pair?: PairState;
  readonly granted?: boolean;
}

function fake(answers: Answers): Fake {
  const calls: string[] = [];
  const asked: string[][] = [];
  return {
    calls,
    asked,
    check: () => {},
    status: async () => {
      calls.push("status");
      return answers.status;
    },
    trigger: async (reference) => {
      calls.push(`trigger ${reference ?? ""}`);
      return FILLED;
    },
    enable: async (origin) => {
      calls.push(`enable ${origin}`);
      return answers.enable ?? ON;
    },
    disable: async () => {
      calls.push("disable");
      return answers.disable ?? OFF;
    },
    pair: async () => {
      calls.push("pair");
      return answers.pair ?? { state: "paired" };
    },
    request: async (origins) => {
      asked.push([...origins]);
      return answers.granted ?? true;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the companion popup", () => {
  it("puts a passkey first: the fill key is disabled and the mark says so", async () => {
    const els = elements();
    await mountPanel(els, () => fake({ status: { ...ON, passkey: true } }));
    expect(els.go.disabled).toBe(true);
    expect(els.mark.getAttribute("aria-label")).toContain("passkey");
    expect(els.mark.dataset.tone).toBe("warn");
  });

  it("switching a site on asks the browser for that one host, then tells the background", async () => {
    const els = elements();
    const p = fake({ status: OFF });
    await mountPanel(els, () => p);
    expect(els.site.getAttribute("aria-checked")).toBe("false");
    els.site.click();
    await settle();
    expect(p.asked).toEqual([["https://example.com/*", DAEMON_PATTERN]]);
    expect(p.calls.at(-1)).toBe("enable https://example.com");
    expect(els.site.getAttribute("aria-checked")).toBe("true");
  });

  it("a grant the browser refused switches nothing on", async () => {
    const els = elements();
    const p = fake({ status: OFF, granted: false });
    await mountPanel(els, () => p);
    els.site.click();
    await settle();
    expect(p.calls).toEqual(["status"]);
    expect(els.mark.getAttribute("aria-label")).toBe(
      "The browser did not grant this site",
    );
  });

  it("switching off tells the background and asks the browser for nothing", async () => {
    const els = elements();
    const p = fake({ status: ON });
    await mountPanel(els, () => p);
    els.site.click();
    await settle();
    expect(p.asked).toEqual([]);
    expect(p.calls.at(-1)).toBe("disable");
    expect(els.go.hidden).toBe(true);
  });

  it("offers pairing only when unpaired, asks for the daemon's host, and shows the code", async () => {
    const els = elements();
    const p = fake({
      status: { ...ON, references: [], error: "not_paired" },
      pair: { state: "pending", code: "ABCDEFGH" },
    });
    await mountPanel(els, () => p);
    expect(els.pair.hidden).toBe(false);
    els.pair.click();
    await settle();
    expect(p.asked).toEqual([[DAEMON_PATTERN]]);
    expect(els.code.value).toBe("ABCD-EFGH");
  });

  it("says the plugin is off, and offers no fill", async () => {
    const els = elements();
    await mountPanel(els, () =>
      fake({ status: { ...ON, references: [], error: "plugin_off" } }),
    );
    expect(els.go.hidden).toBe(true);
    expect(els.pair.hidden).toBe(true);
    expect(els.mark.dataset.tone).toBe("off");
  });

  it("fills with the chosen entry and reports only an outcome", async () => {
    const els = elements();
    const p = fake({ status: { ...ON, references: ["Web/a", "Web/b"] } });
    await mountPanel(els, () => p);
    expect(els.refs.hidden).toBe(false);
    els.refs.querySelector<HTMLInputElement>('input[value="Web/b"]')?.click();
    els.go.click();
    await settle();
    expect(p.calls.at(-1)).toBe("trigger Web/b");
    expect(els.mark.dataset.tone).toBe("ok");
  });

  it("offers no switch for a tab with no web page", async () => {
    const els = elements();
    await mountPanel(els, () =>
      fake({
        status: {
          origin: null,
          enabled: false,
          references: [],
          passkey: false,
        },
      }),
    );
    expect(els.site.hidden).toBe(true);
    expect(els.go.hidden).toBe(true);
    expect(els.mark.getAttribute("aria-label")).toBe(
      "This tab has no web page to fill",
    );
  });

  it("marks a background it cannot reach", async () => {
    const els = elements();
    await mountPanel(els, () =>
      fake({ status: { error: "daemon_unreachable" } }),
    );
    expect(els.mark.dataset.tone).toBe("warn");
    expect(els.go.hidden).toBe(true);
  });
});
