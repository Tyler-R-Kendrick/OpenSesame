// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { effectiveOpacity, fieldFacts, passkeyOffered } from "./facts";
import type { RootReader } from "./flat-tree";

afterEach(() => {
  document.body.replaceChildren();
});

const PASSKEY = { type: "text", autocomplete: "username webauthn" };

interface InputAttrs {
  readonly type: string;
  readonly autocomplete?: string;
}

function input(attrs: InputAttrs, parent: Node = document.body) {
  const el = document.createElement("input");
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, value);
  }
  parent.appendChild(el);
  return el;
}

function host(parent: Node = document.body, tag = "div"): HTMLElement {
  const el = document.createElement(tag);
  parent.appendChild(el);
  return el;
}

function shadowRoot(parent: Node = document.body): ShadowRoot {
  return host(parent).attachShadow({ mode: "open" });
}

function formIn(parent: Node): HTMLFormElement {
  const form = document.createElement("form");
  parent.appendChild(form);
  return form;
}

/** A root jsdom, like a browser, will not hand back through `shadowRoot`. */
const closedRoots = new WeakMap<Element, ShadowRoot>();

function closedRoot(el: HTMLElement): ShadowRoot {
  const root = el.attachShadow({ mode: "closed" });
  closedRoots.set(el, root);
  return root;
}

/** What a content script gets from `browser.dom.openOrClosedShadowRoot`. */
const reader: RootReader = (el) => closedRoots.get(el) ?? el.shadowRoot;

/** A slot inside `parent`, wrapped in a div with the given style. */
function slotIn(parent: Node, style = ""): HTMLSlotElement {
  const wrap = document.createElement("div");
  wrap.setAttribute("style", style);
  const slot = document.createElement("slot");
  wrap.appendChild(slot);
  parent.appendChild(wrap);
  return slot;
}

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
    expect(passkeyOffered(input({ type: "password" }, formIn(root)))).toBe(
      false,
    );
  });

  it("does not count a webauthn field under a different top-level host", () => {
    const one = shadowRoot();
    const two = shadowRoot();
    input(PASSKEY, one);
    expect(passkeyOffered(input({ type: "password" }, two))).toBe(false);
  });

  it("counts a webauthn field in a root nested under the field's own host", () => {
    const outer = shadowRoot();
    input(PASSKEY, shadowRoot(outer));
    expect(passkeyOffered(input({ type: "password" }, outer))).toBe(true);
  });

  it("counts the outer root's webauthn field for a field in a nested root", () => {
    const outer = shadowRoot();
    input(PASSKEY, outer);
    const inner = shadowRoot(outer);
    expect(passkeyOffered(input({ type: "password" }, inner))).toBe(true);
  });

  it("counts a webauthn field in a root nested two levels down", () => {
    const outer = shadowRoot();
    const password = input({ type: "password" }, outer);
    input(PASSKEY, shadowRoot(shadowRoot(outer)));
    expect(passkeyOffered(password)).toBe(true);
  });

  it("sees a webauthn field in a shadow host inside the field's form", () => {
    const form = formIn(document.body);
    input(PASSKEY, shadowRoot(form));
    expect(passkeyOffered(input({ type: "password" }, form))).toBe(true);
  });

  it("does not borrow a shadow host's passkey from another form", () => {
    input(PASSKEY, shadowRoot(formIn(document.body)));
    const other = formIn(document.body);
    expect(passkeyOffered(input({ type: "password" }, other))).toBe(false);
  });

  it("sees a webauthn field in an open root beside a form-less light-DOM field", () => {
    input(PASSKEY, shadowRoot());
    expect(passkeyOffered(input({ type: "password" }))).toBe(true);
  });

  it("sees it when the web component comes after the field", () => {
    const password = input({ type: "password" });
    input(PASSKEY, shadowRoot());
    expect(passkeyOffered(password)).toBe(true);
  });

  it("scopes a shadow field inside a light-DOM form to that form", () => {
    const form = formIn(document.body);
    input(PASSKEY, form);
    expect(passkeyOffered(input({ type: "password" }, shadowRoot(form)))).toBe(
      true,
    );
    const other = formIn(document.body);
    input(PASSKEY, other);
    const root = shadowRoot(formIn(document.body));
    expect(passkeyOffered(input({ type: "password" }, root))).toBe(false);
  });

  it("does not count a light-DOM webauthn field for a field under a shadow host", () => {
    input(PASSKEY);
    expect(passkeyOffered(input({ type: "password" }, shadowRoot()))).toBe(
      false,
    );
  });

  it("sees a webauthn field a slotted field's host holds in its root", () => {
    const wc = host();
    const root = wc.attachShadow({ mode: "open" });
    root.appendChild(document.createElement("slot"));
    input(PASSKEY, root);
    expect(passkeyOffered(input({ type: "password" }, wc))).toBe(true);
  });

  it("sees a webauthn field in a root the page hid from shadowRoot", () => {
    input(PASSKEY, closedRoot(host()));
    const password = input({ type: "password" });
    expect(passkeyOffered(password, reader)).toBe(true);
    expect(passkeyOffered(password, null)).toBe(false);
  });

  it("still sees a light-DOM sibling on the document", () => {
    input(PASSKEY);
    expect(passkeyOffered(input({ type: "password" }))).toBe(true);
  });
});

describe("effectiveOpacity through a slot", () => {
  it("counts a faded wrapper the field is slotted into", () => {
    const wc = host();
    slotIn(wc.attachShadow({ mode: "open" }), "opacity:0");
    expect(effectiveOpacity(input({ type: "password" }, wc), window)).toBe(0);
  });

  it("chains through nested slots, each wrapper fading the field", () => {
    const outer = host();
    const outerRoot = outer.attachShadow({ mode: "open" });
    const mid = host(outerRoot);
    slotIn(mid.attachShadow({ mode: "open" }), "opacity:0.5");
    const relay = host(mid);
    relay.setAttribute("style", "opacity:0.5");
    relay.appendChild(document.createElement("slot"));
    const field = input({ type: "password" }, outer);
    expect(effectiveOpacity(field, window)).toBeCloseTo(0.25);
  });

  it("counts a faded wrapper above a field inside a slotted div", () => {
    const wc = host();
    slotIn(wc.attachShadow({ mode: "open" }), "opacity:0");
    const cell = host(wc);
    expect(effectiveOpacity(input({ type: "password" }, cell), window)).toBe(0);
  });
});

describe("a field whose slot assignment cannot be observed", () => {
  /* SAFETY: test fixture; jsdom has no layout and the guard reads only these four numbers of the rect. */
  const BOX = { left: 20, top: 40, width: 200, height: 30 } as DOMRect;
  const view = (el: HTMLInputElement, roots: RootReader | null = reader) => {
    el.getBoundingClientRect = () => BOX;
    document.elementFromPoint = () => el;
    return fieldFacts(el, window, roots);
  };

  it("is not hit-testable when its parent hides a closed root", () => {
    const wc = host();
    slotIn(closedRoot(wc), "opacity:0");
    const field = input({ type: "password" }, wc);
    expect(effectiveOpacity(field, window)).toBe(1);
    expect(view(field).hitSelf).toBe(false);
  });

  it("is refused even when the closed root's slot is fully visible", () => {
    const wc = host();
    slotIn(closedRoot(wc));
    expect(view(input({ type: "password" }, wc)).hitSelf).toBe(false);
  });

  it("is refused for a descendant of a slotted-into-closed-root element", () => {
    const wc = host();
    slotIn(closedRoot(wc), "opacity:0");
    const cell = host(wc);
    expect(view(input({ type: "password" }, cell)).hitSelf).toBe(false);
  });

  it("is refused behind a custom element when the browser API is absent", () => {
    const wc = host(document.body, "login-box");
    slotIn(closedRoot(wc), "opacity:0");
    expect(view(input({ type: "password" }, wc), null).hitSelf).toBe(false);
  });

  it("is still hit-testable beside an ordinary parent and an open root", () => {
    expect(view(input({ type: "password" }, host())).hitSelf).toBe(true);
    const wc = host();
    slotIn(wc.attachShadow({ mode: "open" }));
    expect(view(input({ type: "password" }, wc)).hitSelf).toBe(true);
  });
});
