/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { firstControl, keyboardIsIdle, landFocus } from "./focus.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("keyboardIsIdle", () => {
  it("is idle on body and after the focused element leaves the document", () => {
    expect(keyboardIsIdle()).toBe(true);
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    expect(keyboardIsIdle()).toBe(false);
    button.remove();
    expect(keyboardIsIdle()).toBe(true);
  });
});

describe("landFocus", () => {
  it("lands on a live control and reports it", () => {
    const input = document.createElement("input");
    document.body.append(input);
    expect(landFocus(input)).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("refuses nothing, a detached node, and a disabled control", () => {
    expect(landFocus(null)).toBe(false);
    expect(landFocus(document.createElement("button"))).toBe(false);
    const disabled = document.createElement("button");
    disabled.disabled = true;
    document.body.append(disabled);
    expect(landFocus(disabled)).toBe(false);
    expect(keyboardIsIdle()).toBe(true);
  });
});

describe("firstControl", () => {
  it("skips disabled controls and negative tab stops", () => {
    document.body.innerHTML = `
      <div id="root">
        <button disabled>no</button>
        <div tabindex="-1">no</div>
        <a>no href</a>
        <a href="#x" id="yes">yes</a>
        <button id="later">later</button>
      </div>`;
    expect(firstControl(document.getElementById("root"))?.id).toBe("yes");
    expect(firstControl(null)).toBeNull();
  });
});
