/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "http://localhost:3000/?code=WXYZ-1234&claim_id=clm_2"}
 */
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("App deep-link (?code= fallback)", () => {
  it("accepts the code query param when user_code is absent", async () => {
    await act(async () => {
      root.render(<App />);
    });
    const input = container.querySelector(
      'input[placeholder="ABCD-EFGH"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("WXYZ-1234");
    expect(container.textContent).toContain(
      "Deep-link user code WXYZ-1234 — review and approve",
    );
    expect(container.textContent).toContain("clm_2");
  });
});
