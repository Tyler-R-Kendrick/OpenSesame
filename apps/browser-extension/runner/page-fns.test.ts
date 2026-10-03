import type { BoundaryValue } from "@opensesame/os-domain";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
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

/** Evaluate a page function from its source inside a fresh page, as the browser does. */
function inPage(html: string) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://rp.example/",
  });
  const call = <A extends BoundaryValue[], R>(
    fn: (...args: A) => R,
    ...args: A
  ) => {
    // SAFETY: the evaluated source is the page function's own text, so its type matches that signature.
    const body = dom.window.eval(`(${fn.toString()})`) as (...a: A) => R;
    return body(...args);
  };
  return { dom, call, doc: dom.window.document };
}

const FORM = `<body>
  <form id="f"><input id="a" type="password"/><input id="t" type="text"/>
  <input id="off" disabled/><input id="ro" readonly/><input id="cb" type="checkbox"/>
  <input id="h" type="hidden"/><input id="hid" style="display:none"/>
  <textarea id="ta"></textarea><button id="go" type="submit">Go</button></form>
  <div id="notfield"></div></body>`;

describe("page functions are self-contained", () => {
  it("each one runs from its source text with nothing of this module in scope", async () => {
    const { call } = inPage(FORM);
    expect(call(pfFill, "#a", "x")).toBe("ok");
    expect(call(pfPresence, "#a", "x")).toBe("present");
    expect(call(pfLayout)).toEqual(expect.any(String));
    expect(call(pfMask, ["#a"])).toBe(1);
    expect(call(pfUnmask)).toBe(1);
    expect(call(pfReadDom, [])).toEqual(expect.any(String));
    expect(await call(pfWaitFor, "#a", 10)).toBe("ok");
  });
});

describe("pfFill", () => {
  it("writes as a person would: through the setter, with input and change events", () => {
    const { call, doc, dom } = inPage(FORM);
    const heard: string[] = [];
    const field = doc.querySelector<HTMLInputElement>("#a");
    for (const type of ["input", "change"]) {
      field?.addEventListener(type, () => heard.push(`${type}:${field.value}`));
    }
    expect(call(pfFill, "#a", "s3cret")).toBe("ok");
    expect(field?.value).toBe("s3cret");
    expect(heard).toEqual(["input:s3cret", "change:s3cret"]);
    expect(dom.window.document.activeElement).toBe(field);
  });

  it("fills a textarea", () => {
    const { call, doc } = inPage(FORM);
    expect(call(pfFill, "#ta", "note")).toBe("ok");
    expect(doc.querySelector<HTMLTextAreaElement>("#ta")?.value).toBe("note");
  });

  it("refuses what is not a fillable field", () => {
    const { call } = inPage(FORM);
    for (const selector of [
      "#nothing",
      "#notfield",
      "#off",
      "#ro",
      "#cb",
      "#h",
      "#hid",
      "#go",
    ]) {
      expect(call(pfFill, selector, "x"), selector).toBe("no_such_field");
    }
  });

  it("answers invalid for a selector that does not parse", () => {
    const { call } = inPage(FORM);
    expect(call(pfFill, "###", "x")).toBe("invalid");
  });
});

describe("pfPresence", () => {
  it("says present, absent and mismatch without returning the value", () => {
    const { call } = inPage(FORM);
    expect(call(pfPresence, "#a", "x")).toBe("absent");
    call(pfFill, "#a", "right");
    expect(call(pfPresence, "#a", "right")).toBe("present");
    expect(call(pfPresence, "#a", "wrong")).toBe("mismatch");
    expect(call(pfPresence, "#missing", "right")).toBe("absent");
    expect(call(pfPresence, "#notfield", "right")).toBe("absent");
    expect(call(pfPresence, "###", "right")).toBe("invalid");
  });
});

describe("pfSubmit", () => {
  it("clicks a control and submits a form", () => {
    const { call, doc } = inPage(FORM);
    let submitted = 0;
    doc.querySelector("#f")?.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted += 1;
    });
    expect(call(pfSubmit, "#go")).toBe("ok");
    expect(call(pfSubmit, "#f")).toBe("ok");
    expect(submitted).toBe(2);
    expect(call(pfSubmit, "#missing")).toBe("no_such_element");
    expect(call(pfSubmit, "###")).toBe("invalid");
  });
});

describe("pfReadDom", () => {
  it("drops every value, however it was set, and everything that is not content", () => {
    const html = `<body>
      <input id="a" type="password" value="attr-secret"/>
      <input id="b" type="text" value="typed-attr"/>
      <input id="s" type="submit" value="Send"/>
      <textarea id="ta">area-secret</textarea>
      <div id="shown">visible text</div>
      <div id="strip">stripped-text</div>
      <script>var token = "script-secret";</script>
      <style>.x { color: red }</style>
      <!-- comment-secret -->
    </body>`;
    const { call, doc } = inPage(html);
    call(pfFill, "#a", "live-secret");
    call(pfFill, "#b", "live-typed");
    const text = call(pfReadDom, ["#strip"]);
    for (const gone of [
      "attr-secret",
      "typed-attr",
      "area-secret",
      "stripped-text",
      "script-secret",
      "comment-secret",
      "live-secret",
      "live-typed",
      "color: red",
    ]) {
      expect(text, gone).not.toContain(gone);
    }
    expect(text).toContain("visible text");
    // A submit control's value is its label, not something typed.
    expect(text).toContain('value="Send"');
    // The page itself is untouched.
    expect(doc.querySelector<HTMLInputElement>("#a")?.value).toBe(
      "live-secret",
    );
    expect(doc.querySelector("script")).not.toBeNull();
  });

  it("bounds what it returns", () => {
    const { call } = inPage(
      `<body>${`<p>${"x".repeat(2_000)}</p>`.repeat(150)}</body>`,
    );
    expect(call(pfReadDom, []).length).toBe(200_000);
  });

  it("skips a strip selector that does not parse", () => {
    const { call } = inPage(FORM);
    expect(call(pfReadDom, ["###", "#a"])).toContain("<form");
  });
});

describe("pfMask and pfUnmask", () => {
  it("counts the selectors it covered, not the nodes, and takes the covers down", () => {
    const { call, doc } = inPage(
      '<body><input class="p"/><input class="p"/><input id="q"/></body>',
    );
    expect(call(pfMask, [".p", "#q", "#absent", "###"])).toBe(2);
    expect(doc.querySelectorAll("[data-opensesame-mask]")).toHaveLength(3);
    const cover = doc.querySelector("[data-opensesame-mask]");
    expect(cover?.getAttribute("style")).toContain("position:fixed");
    expect(cover?.getAttribute("style")).toContain("pointer-events:none");
    expect(call(pfUnmask)).toBe(3);
    expect(doc.querySelectorAll("[data-opensesame-mask]")).toHaveLength(0);
  });
});

describe("pfLayout", () => {
  it("changes when a control moves", () => {
    const { call, doc } = inPage(FORM);
    const before = call(pfLayout);
    const field = doc.querySelector("#a");
    if (!field) throw new Error("no field");
    field.getBoundingClientRect = () => ({
      left: 10,
      top: 20,
      width: 100,
      height: 30,
      right: 110,
      bottom: 50,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    });
    expect(call(pfLayout)).not.toBe(before);
  });
});

describe("pfWaitFor", () => {
  it("resolves when the selector appears later, and times out when it does not", async () => {
    const { call, doc } = inPage("<body></body>");
    const waiting = call(pfWaitFor, "#late", 500);
    setTimeout(() => {
      const el = doc.createElement("div");
      el.id = "late";
      doc.body.append(el);
    }, 10);
    expect(await waiting).toBe("ok");
    expect(await call(pfWaitFor, "#never", 20)).toBe("timeout");
    expect(await call(pfWaitFor, "###", 20)).toBe("invalid");
  });
});
