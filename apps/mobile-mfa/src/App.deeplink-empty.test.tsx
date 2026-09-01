import { overlapCast } from "@opensesame/os-domain";
/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "opensesame-mfa://approve"}
 */
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

overlapCast(globalThis).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe("App deep-link (opensesame-mfa:// without params)", () => {
  it("is not a link at all, so the standalone surface renders", async () => {
    await act(async () => {
      root.render(<App />);
    });
    // A scheme with no code carries no question. Guessing at one would start a
    // ceremony nobody asked for, so this falls all the way through to `none`.
    expect(
      [...container.querySelectorAll("h1")].map((h) => h.textContent),
    ).toEqual(["Mobile MFA"]);
    const input: HTMLInputElement = overlapCast(
      container.querySelector("#user-code"),
    );
    expect(input.value).toBe("");
    expect(container.textContent).not.toContain("is not settled here");
    expect(container.querySelector("details.disclosure")).toBeNull();
  });
});
