// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveOpacity,
  fieldKind,
  focusedInput,
  pageFacts,
  passkeyOffered,
} from "./facts";
import { decideFill } from "./guard";

afterEach(() => {
  document.body.replaceChildren();
  document.body.removeAttribute("style");
});

/** The attributes a test field carries. */
interface InputAttrs {
  readonly type?: string;
  readonly autocomplete?: string;
  readonly name?: string;
  readonly id?: string;
  readonly style?: string;
}

function input(attrs: InputAttrs, parent: Node = document.body) {
  const el = document.createElement("input");
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, value);
  }
  parent.appendChild(el);
  return el;
}

/* SAFETY: test fixture; jsdom has no layout and the guard reads only these four numbers of the rect. */
const BOX = { left: 20, top: 40, width: 200, height: 30 } as DOMRect;

/** jsdom has no layout: give the field a box and a hit-test answer. */
function place(el: HTMLInputElement, hit: () => Element | null = () => el) {
  el.getBoundingClientRect = () => BOX;
  document.elementFromPoint = hit;
}

describe("fieldKind", () => {
  it("reads current passwords, usernames, and what is neither", () => {
    expect(fieldKind(input({ type: "password" }))).toBe("password");
    expect(
      fieldKind(input({ type: "password", autocomplete: "new-password" })),
    ).toBe("new_password");
    expect(fieldKind(input({ type: "text", autocomplete: "username" }))).toBe(
      "username",
    );
    expect(fieldKind(input({ type: "email" }))).toBe("username");
    expect(fieldKind(input({ type: "text", name: "login" }))).toBe("username");
    expect(fieldKind(input({ type: "text", name: "search" }))).toBe("other");
    expect(fieldKind(input({ type: "checkbox" }))).toBe("other");
    expect(
      fieldKind(input({ type: "text", autocomplete: "one-time-code" })),
    ).toBe("other");
  });
});

describe("effectiveOpacity", () => {
  it("multiplies an ancestor's opacity: 0 on a wrapper hides the field", () => {
    const wrapper = document.createElement("div");
    wrapper.style.opacity = "0";
    document.body.appendChild(wrapper);
    const field = input({ type: "password" }, wrapper);
    expect(effectiveOpacity(field, window)).toBe(0);
  });

  it("counts opacity on the body as well", () => {
    document.body.style.opacity = "0.1";
    const field = input({ type: "password" });
    expect(effectiveOpacity(field, window)).toBeCloseTo(0.1);
  });

  it("counts filter: opacity()", () => {
    const field = input({ type: "password" });
    field.style.filter = "opacity(0%)";
    expect(effectiveOpacity(field, window)).toBe(0);
  });
});

describe("focusedInput", () => {
  it("follows focus into an open shadow root", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const field = input({ type: "password" }, root);
    field.focus();
    expect(focusedInput(document)).toBe(field);
  });

  it("is null when focus is not on an input", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    expect(focusedInput(document)).toBeNull();
  });
});

describe("passkeyOffered", () => {
  it("sees a conditional-mediation field in the same form", () => {
    const form = document.createElement("form");
    document.body.appendChild(form);
    input({ type: "text", autocomplete: "username webauthn" }, form);
    const password = input({ type: "password" }, form);
    expect(passkeyOffered(password)).toBe(true);
  });

  it("does not borrow another form's passkey", () => {
    const one = document.createElement("form");
    const two = document.createElement("form");
    document.body.append(one, two);
    input({ type: "text", autocomplete: "webauthn" }, one);
    expect(passkeyOffered(input({ type: "password" }, two))).toBe(false);
  });
});

/** An open shadow root under a fresh host, appended to `parent`. */
function shadowRoot(parent: Node = document.body): ShadowRoot {
  const host = document.createElement("div");
  parent.appendChild(host);
  return host.attachShadow({ mode: "open" });
}

function formIn(parent: Node): HTMLFormElement {
  const form = document.createElement("form");
  parent.appendChild(form);
  return form;
}

const PASSKEY = { type: "text", autocomplete: "username webauthn" };

describe("passkeyOffered across shadow roots", () => {
  it("sees a sibling webauthn field of a form-less field in the same open root", () => {
    const root = shadowRoot();
    input(PASSKEY, root);
    expect(passkeyOffered(input({ type: "password" }, root))).toBe(true);
  });

  it("sees it when the password comes first in the root", () => {
    const root = shadowRoot();
    const password = input({ type: "password" }, root);
    input(PASSKEY, root);
    expect(passkeyOffered(password)).toBe(true);
  });

  it("scopes a form inside a shadow root to that form", () => {
    const root = shadowRoot();
    const form = formIn(root);
    input(PASSKEY, form);
    expect(passkeyOffered(input({ type: "password" }, form))).toBe(true);
    const other = formIn(root);
    expect(passkeyOffered(input({ type: "password" }, other))).toBe(false);
  });

  it("sees a sibling in a nested shadow root, and only the field's own root", () => {
    const outer = shadowRoot();
    const inner = shadowRoot(outer);
    input(PASSKEY, inner);
    expect(passkeyOffered(input({ type: "password" }, inner))).toBe(true);
    // The outer root's own field has a passkey in a root below it: not its root.
    expect(passkeyOffered(input({ type: "password" }, outer))).toBe(false);
  });

  it("does not count a webauthn field in the outer root for the inner one", () => {
    const outer = shadowRoot();
    input(PASSKEY, outer);
    const inner = shadowRoot(outer);
    expect(passkeyOffered(input({ type: "password" }, inner))).toBe(false);
  });

  it("does not count a webauthn field in a different root", () => {
    const one = shadowRoot();
    const two = shadowRoot();
    input(PASSKEY, one);
    expect(passkeyOffered(input({ type: "password" }, two))).toBe(false);
  });

  it("does not count a shadow root's webauthn field for a light-DOM field", () => {
    input(PASSKEY, shadowRoot());
    expect(passkeyOffered(input({ type: "password" }))).toBe(false);
  });

  it("does not count a light-DOM webauthn field for a shadow field", () => {
    input(PASSKEY);
    expect(passkeyOffered(input({ type: "password" }, shadowRoot()))).toBe(
      false,
    );
  });

  it("still sees a light-DOM sibling on the document", () => {
    input(PASSKEY);
    expect(passkeyOffered(input({ type: "password" }))).toBe(true);
  });
});

describe("effectiveOpacity through a slot", () => {
  it("counts a faded wrapper the field is slotted into", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const veil = document.createElement("div");
    veil.style.opacity = "0";
    veil.appendChild(document.createElement("slot"));
    root.appendChild(veil);
    const field = input({ type: "password" }, host);
    expect(effectiveOpacity(field, window)).toBe(0);
  });
});

describe("pageFacts feeding decideFill", () => {
  const arm = (origin: string) => ({
    trigger: "command",
    origin,
    armedAt: Date.now(),
  });

  it("fills a visible, focused field in the top frame", () => {
    const field = input({ type: "password" });
    place(field);
    field.focus();
    const facts = pageFacts(window);
    expect(facts.isTopFrame).toBe(true);
    expect(decideFill(arm(location.origin), facts, Date.now()).fill).toBe(true);
  });

  it("refuses a field covered by an overlay", () => {
    const field = input({ type: "password" });
    const overlay = document.createElement("div");
    document.body.appendChild(overlay);
    place(field, () => overlay);
    field.focus();
    const decision = decideFill(
      arm(location.origin),
      pageFacts(window),
      Date.now(),
    );
    expect(decision).toEqual({ fill: false, refusal: "covered" });
  });

  it("refuses a field faded out through its wrapper", () => {
    const wrapper = document.createElement("div");
    wrapper.style.opacity = "0";
    document.body.appendChild(wrapper);
    const field = input({ type: "password" }, wrapper);
    place(field);
    field.focus();
    const decision = decideFill(
      arm(location.origin),
      pageFacts(window),
      Date.now(),
    );
    expect(decision).toEqual({ fill: false, refusal: "transparent" });
  });

  it("refuses from inside an iframe", () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const inner = frame.contentWindow;
    expect(inner).not.toBeNull();
    if (!inner) return;
    const facts = pageFacts(inner);
    expect(facts.isTopFrame).toBe(false);
    expect(decideFill(arm(location.origin), facts, Date.now())).toEqual({
      fill: false,
      refusal: "not_top_frame",
    });
  });

  it("refuses a shadow-root password beside a sibling webauthn field", () => {
    const root = shadowRoot();
    input(PASSKEY, root);
    const field = input({ type: "password" }, root);
    field.getBoundingClientRect = () => BOX;
    root.elementFromPoint = () => field;
    field.focus();
    const facts = pageFacts(window);
    expect(facts.passkeyOffered).toBe(true);
    expect(decideFill(arm(location.origin), facts, Date.now())).toEqual({
      fill: false,
      refusal: "passkey_offered",
    });
  });

  it("fills a shadow-root password when the only passkey is in another root", () => {
    input(PASSKEY, shadowRoot());
    const root = shadowRoot();
    const field = input({ type: "password" }, root);
    field.getBoundingClientRect = () => BOX;
    root.elementFromPoint = () => field;
    field.focus();
    const facts = pageFacts(window);
    expect(facts.passkeyOffered).toBe(false);
    expect(decideFill(arm(location.origin), facts, Date.now()).fill).toBe(true);
  });

  it("refuses a field in a nested shadow root covered by an overlay in its root", () => {
    const outer = shadowRoot();
    const inner = shadowRoot(outer);
    const field = input({ type: "password" }, inner);
    const overlay = document.createElement("div");
    inner.appendChild(overlay);
    field.getBoundingClientRect = () => BOX;
    inner.elementFromPoint = () => overlay;
    field.focus();
    expect(
      decideFill(arm(location.origin), pageFacts(window), Date.now()),
    ).toEqual({ fill: false, refusal: "covered" });
  });
});
