/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeymapHandler } from "./keymap.js";
import { handlePaneEscape } from "./pane-escape.js";

afterEach(() => document.body.replaceChildren());

function fixture(kind = "input", className = "vault__detail") {
  const pane = document.createElement("section");
  pane.className = className;
  const field = document.createElement(kind);
  if (kind === "div") {
    field.contentEditable = "true";
    field.setAttribute("contenteditable", "true");
    field.tabIndex = 0;
  }
  const close = document.createElement("button");
  close.dataset.paneClose = "";
  const onClose = vi.fn();
  close.addEventListener("click", onClose);
  pane.append(field, close);
  document.body.append(pane);
  return { pane, field, close, onClose };
}

function pressEscape(target: HTMLElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.addEventListener("keydown", handlePaneEscape, { once: true });
  target.dispatchEvent(event);
  return event;
}

describe("pane Escape", () => {
  it.each(["input", "textarea", "div"])(
    "leaves %s intact before closing its pane on a separate Escape",
    (kind) => {
      const { pane, field, onClose } = fixture(kind);
      field.focus();
      expect(pressEscape(field).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(pane);
      expect(onClose).not.toHaveBeenCalled();
      pressEscape(pane);
      expect(onClose).toHaveBeenCalledOnce();
    },
  );

  it("runs blur without clearing the field or submitting", () => {
    const { pane, field } = fixture("textarea");
    field.textContent = "draft to keep";
    const blur = vi.fn();
    field.addEventListener("blur", blur);
    field.focus();
    pressEscape(field);
    expect(blur).toHaveBeenCalledOnce();
    expect(field.textContent).toBe("draft to keep");
    expect(document.activeElement).toBe(pane);
  });

  it("keeps nonclosable panes focused and never closes a nested pane", () => {
    const { pane, field, close, onClose } = fixture("input", "panel");
    const nested = document.createElement("section");
    nested.className = "panel";
    nested.append(close);
    pane.append(nested);
    field.focus();
    pressEscape(field);
    pressEscape(pane);
    expect(document.activeElement).toBe(pane);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close disabled or hidden actions", () => {
    const { pane, field, close, onClose } = fixture();
    field.focus();
    pressEscape(field);
    close.disabled = true;
    pressEscape(pane);
    close.disabled = false;
    close.hidden = true;
    pressEscape(pane);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    { isComposing: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { shiftKey: true },
  ])("leaves composition and modified Escape alone: %j", (init) => {
    const { field, onClose } = fixture();
    field.focus();
    expect(pressEscape(field, init).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(field);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("holding Escape cannot dismiss after leaving the field", () => {
    const { pane, field, onClose } = fixture();
    field.focus();
    pressEscape(field);
    pressEscape(pane, { repeat: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the shell keymap uses the same focus transition instead of tree shortcuts", () => {
    const { field, pane } = fixture();
    const navigate = vi.fn();
    const handler = createKeymapHandler({ navigate, showHelp: vi.fn() });
    window.addEventListener("keydown", handler, true);
    try {
      field.focus();
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(document.activeElement).toBe(pane);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", handler, true);
    }
  });
});
