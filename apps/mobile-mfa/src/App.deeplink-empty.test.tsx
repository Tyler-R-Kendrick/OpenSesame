import { type JsonObject, overlapCast } from "@opensesame/os-domain";
/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "opensesame-mfa://approve"}
 */
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

(overlapCast(globalThis)).IS_REACT_ACT_ENVIRONMENT = true;

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
  it("falls back to empty code and no claim hint", async () => {
    await act(async () => {
      root.render(<App />);
    });
    const input = overlapCast(container.querySelector(
      'input[placeholder="ABCD-EFGH"]',
    ));
    expect(input.value).toBe("");
    expect(container.textContent).toContain("Ready for step-up");
    expect(container.textContent).not.toContain("Deep-link claim id");
  });
});
