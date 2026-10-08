// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  pfFill,
  pfLayout,
  pfMask,
  pfPresence,
  pfReadDom,
  pfSubmit,
  pfUnmask,
  pfWaitFor,
} from "./page-fns";

// Call the actual instrumented production functions against DOM globals.
// Existing source-serialization tests remain a separate executeScript oracle.
afterEach(() => {
  vi.unstubAllGlobals();
  pfUnmask();
  document.body.replaceChildren();
});

it("waits for actual attribute and child mutations, and rejects malformed or absent selectors", async () => {
  document.body.innerHTML = '<div id="later"></div>';
  expect(await pfWaitFor("#later", 50)).toBe("ok");
  expect(await pfWaitFor("[", 50)).toBe("invalid");
  const attribute = pfWaitFor('[data-ready="yes"]', 100);
  document.getElementById("later")?.setAttribute("data-ready", "yes");
  expect(await attribute).toBe("ok");
  const child = pfWaitFor("#child", 100);
  const element = document.createElement("p");
  element.id = "child";
  document.body.append(element);
  expect(await child).toBe("ok");
  expect(await pfWaitFor("#absent", 1)).toBe("timeout");
});

it("fills actual allowed input kinds and textarea through native setters and bubbling events", () => {
  const events: string[] = [];
  document.body.addEventListener(
    "input",
    (event) => {
      if (event.target instanceof HTMLInputElement)
        events.push(`input:${event.target.id}`);
    },
    { once: true },
  );
  document.body.innerHTML = `${[
    "text",
    "password",
    "email",
    "tel",
    "search",
    "url",
  ]
    .map((type) => `<input id="${type}" type="${type}">`)
    .join("")}<textarea id="textarea"></textarea>`;
  for (const type of [
    "text",
    "password",
    "email",
    "tel",
    "search",
    "url",
    "textarea",
  ]) {
    const field = document.getElementById(type);
    if (
      !(
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement
      )
    )
      throw new Error("Expected actual field");
    const changed: string[] = [];
    field.addEventListener("change", () => changed.push(field.value));
    expect(pfFill(`#${type}`, "public-fixture-value")).toBe("ok");
    expect(field.value).toBe("public-fixture-value");
    expect(changed).toEqual(["public-fixture-value"]);
    expect(document.activeElement).toBe(field);
    expect(pfPresence(`#${type}`, "public-fixture-value")).toBe("present");
    expect(pfPresence(`#${type}`, "different")).toBe("mismatch");
  }
  expect(events).toEqual(["input:text"]);
});

it("refuses noneditable, hidden, shadow-contained and nonfield nodes without changing them", () => {
  document.body.innerHTML =
    '<input id="disabled" disabled value="unchanged">' +
    '<input id="readonly" readonly value="unchanged"><input id="number" type="number" value="9">' +
    '<input id="hidden" type="hidden"><input id="display" style="display:none">' +
    '<input id="visibility" style="visibility:hidden"><p id="text">label</p><div id="shadow"></div>';
  const shadow = document
    .getElementById("shadow")
    ?.attachShadow({ mode: "open" });
  if (!shadow) throw new Error("Expected actual shadow root");
  shadow.innerHTML = '<input id="shadow-field" value="shadow-public-fixture">';
  for (const id of [
    "disabled",
    "readonly",
    "number",
    "hidden",
    "display",
    "visibility",
    "text",
    "missing",
    "shadow-field",
  ])
    expect(pfFill(`#${id}`, "replacement"), id).toBe("no_such_field");
  expect(pfFill("[", "replacement")).toBe("invalid");
  expect(document.querySelector<HTMLInputElement>("#disabled")?.value).toBe(
    "unchanged",
  );
  expect(shadow.querySelector<HTMLInputElement>("#shadow-field")?.value).toBe(
    "shadow-public-fixture",
  );
  expect(pfPresence("#missing", "fixture")).toBe("absent");
  expect(pfPresence("#text", "label")).toBe("absent");
  expect(pfPresence("#hidden", "fixture")).toBe("absent");
  expect(pfPresence("[", "fixture")).toBe("invalid");
});

it("denies detached-document fields and non-HTMLElement submission without returning values", () => {
  const detached = document.implementation.createHTMLDocument("detached");
  detached.body.innerHTML =
    '<input id="field" value="public-fixture"><svg id="vector"></svg>';
  vi.stubGlobal("document", detached);
  expect(pfFill("#field", "other")).toBe("no_such_field");
  expect(pfPresence("#field", "public-fixture")).toBe("absent");
  expect(pfSubmit("#field")).toBe("no_such_element");
  expect(pfLayout().split("|")[1]).toBe("0x0");
});

it("dispatches real click and form submission exactly once, retaining invalid-selector refusals", () => {
  document.body.innerHTML =
    '<form id="form"><button id="submit" type="submit">Submit</button></form><svg id="svg"></svg>';
  const submitted: Event[] = [];
  document.getElementById("form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitted.push(event);
  });
  expect(pfSubmit("#form")).toBe("ok");
  expect(pfSubmit("#submit")).toBe("ok");
  expect(submitted).toHaveLength(2);
  expect(pfSubmit("#svg")).toBe("no_such_element");
  expect(pfSubmit("#missing")).toBe("no_such_element");
  expect(pfSubmit("[")).toBe("invalid");
});

it("redacts actual fields and requested markup while preserving live DOM and public control labels", () => {
  document.body.innerHTML =
    '<input id="typed" value="attribute-fixture"><textarea>area-fixture</textarea>' +
    '<input type="hidden" value="hidden-fixture"><input type="checkbox" value="public-choice">' +
    '<input type="submit" value="Public submit"><div id="strip" value="remove-fixture">strip-fixture</div>' +
    "<script>script-fixture</script><style>style-fixture</style><template>template-fixture</template>" +
    '<noscript>noscript-fixture</noscript><link href="fixture.css"><!--comment-fixture-->';
  expect(pfFill("#typed", "live-fixture")).toBe("ok");
  const result = pfReadDom(["[", "#strip"]);
  for (const gone of [
    "attribute-fixture",
    "live-fixture",
    "area-fixture",
    "hidden-fixture",
    "remove-fixture",
    "strip-fixture",
    "script-fixture",
    "style-fixture",
    "template-fixture",
    "noscript-fixture",
    "comment-fixture",
    "fixture.css",
  ])
    expect(result, gone).not.toContain(gone);
  expect(result).toContain("public-choice");
  expect(result).toContain("Public submit");
  expect(document.querySelector<HTMLInputElement>("#typed")?.value).toBe(
    "live-fixture",
  );
  expect(document.querySelector("script")).not.toBeNull();
  document.body.textContent = "x".repeat(210_000);
  expect(pfReadDom([])).toHaveLength(200_000);
});

it("tracks real geometry changes, bounds sampled controls and removes every actual opaque mask", () => {
  document.body.innerHTML =
    '<input id="box"><textarea></textarea><select></select><iframe></iframe>';
  const field = document.getElementById("box");
  if (!field) throw new Error("Expected actual geometry target");
  field.getBoundingClientRect = () => new DOMRect(10.4, 20.6, 100.2, 30.8);
  expect(pfLayout().split("|")[3]).toContain("10,21,100,31");
  expect(pfMask(["input,textarea", "#absent", "[", "#box"])).toBe(2);
  const covers = document.querySelectorAll<HTMLElement>(
    "[data-opensesame-mask]",
  );
  expect(covers).toHaveLength(3);
  expect(covers[0]?.style.left).toBe("10.4px");
  expect(covers[0]?.style.pointerEvents).toBe("none");
  expect(pfUnmask()).toBe(3);
  expect(pfUnmask()).toBe(0);
  document.body.innerHTML = "<input>".repeat(205);
  const layout = pfLayout().split("|");
  expect(layout[2]).toBe("205");
  expect(layout[3]?.split(";")).toHaveLength(200);
});
