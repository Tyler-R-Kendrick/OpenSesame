// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  type RequestValue,
  answerArm,
  claimDocument,
  fromThisExtension,
} from "./guard-runtime";
import {
  type ArmMessage,
  type ValueReply,
  type ValueRequest,
  armMessage,
} from "./wire";

const VALUE = "the-one-value";
const OWN = "abcdefghijklmnopabcdefghijklmnop";

afterEach(() => {
  document.body.replaceChildren();
});

/* SAFETY: test fixture; jsdom has no layout and the guard reads only these four numbers of the rect. */
const BOX = { left: 20, top: 40, width: 200, height: 30 } as DOMRect;

function field(): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "password";
  document.body.appendChild(el);
  el.getBoundingClientRect = () => BOX;
  document.elementFromPoint = () => el;
  el.focus();
  return el;
}

/** The parts of an arm a test changes. */
interface ArmOverrides {
  readonly mode?: string;
  readonly trigger?: string;
  readonly origin?: string;
}

const arm = (over: ArmOverrides = {}): ArmMessage =>
  armMessage.parse({
    type: "opensesame.fill.arm",
    mode: "fill",
    nonce: "n-1",
    origin: location.origin,
    trigger: "command",
    armedAt: Date.now(),
    ...over,
  });

const GIVE_VALUE: ValueReply = { value: VALUE };

function runtime(reply: () => ValueReply = () => GIVE_VALUE) {
  const sent: ValueRequest[] = [];
  const port: RequestValue = async (request) => {
    sent.push(request);
    return reply();
  };
  return { sent, port };
}

describe("the injected guard", () => {
  it("asks for the value only after its checks, and writes it", async () => {
    const input = field();
    const { sent, port } = runtime();
    const reply = await answerArm(window, port, arm());
    expect(reply).toEqual({ outcome: "filled" });
    expect(input.value).toBe(VALUE);
    expect(sent).toEqual([
      {
        type: "opensesame.fill",
        op: "value",
        nonce: "n-1",
        field: "password",
      },
    ]);
    expect(JSON.stringify(reply)).not.toContain(VALUE);
  });

  it("does not ask for a value for a covered field", async () => {
    const input = field();
    const overlay = document.createElement("div");
    document.body.appendChild(overlay);
    document.elementFromPoint = () => overlay;
    const { sent, port } = runtime();
    expect(await answerArm(window, port, arm())).toEqual({
      outcome: "covered",
    });
    expect(sent).toEqual([]);
    expect(input.value).toBe("");
  });

  it("re-checks after the round trip: an overlay swapped in is caught", async () => {
    const input = field();
    const overlay = document.createElement("div");
    document.body.appendChild(overlay);
    const { port } = runtime(() => {
      document.elementFromPoint = () => overlay;
      return { value: VALUE };
    });
    expect(await answerArm(window, port, arm())).toEqual({
      outcome: "covered",
    });
    expect(input.value).toBe("");
  });

  it("re-checks after the round trip: focus moved to another field", async () => {
    const first = field();
    const { port } = runtime(() => {
      const second = field();
      second.focus();
      return { value: VALUE };
    });
    expect(await answerArm(window, port, arm())).toEqual({
      outcome: "focus_moved",
    });
    expect(first.value).toBe("");
  });

  it("refuses autofill on load: an arm with a page trigger asks for nothing", async () => {
    field();
    const { sent, port } = runtime();
    expect(await answerArm(window, port, arm({ trigger: "load" }))).toEqual({
      outcome: "untrusted_trigger",
    });
    expect(sent).toEqual([]);
  });

  it("passes on the background's refusal as an outcome", async () => {
    field();
    const { port } = runtime(() => ({ refusal: "no_match" }));
    expect(await answerArm(window, port, arm())).toEqual({
      outcome: "no_match",
    });
  });

  it("a probe reports a passkey and never asks for a value", async () => {
    const form = document.createElement("form");
    document.body.appendChild(form);
    const passkey = document.createElement("input");
    passkey.setAttribute("autocomplete", "username webauthn");
    form.appendChild(passkey);
    passkey.focus();
    const { sent, port } = runtime();
    expect(await answerArm(window, port, arm({ mode: "probe" }))).toEqual({
      passkey: true,
    });
    expect(sent).toEqual([]);
  });
});

describe("who may arm the guard", () => {
  it("installs one guard however often it is injected", () => {
    /* SAFETY: test fixture; a fresh object whose prototype is the jsdom window stands in for a second document's isolated-world view. */
    const view = Object.create(window) as Window;
    expect(claimDocument(view)).toBe(true);
    expect(claimDocument(view)).toBe(false);
  });

  it("answers only this extension's arms", () => {
    expect(fromThisExtension({ id: OWN }, OWN)).toBe(true);
    expect(fromThisExtension({ id: "someone-else" }, OWN)).toBe(false);
    expect(fromThisExtension({}, OWN)).toBe(false);
  });

  it("decodes nothing but an arm", () => {
    expect(armMessage.safeParse({ type: "other" }).success).toBe(false);
    expect(
      armMessage.safeParse({ ...arm(), mode: "fill-everything" }).success,
    ).toBe(false);
    expect(armMessage.safeParse(arm()).success).toBe(true);
  });
});
