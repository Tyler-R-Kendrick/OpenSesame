/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "opensesame-mfa://approve?user_code=ABCD-EFGH&claim_id=clm_9"}
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

describe("App deep-link (opensesame-mfa://)", () => {
  it("parses user_code and claim_id from the custom scheme URL", async () => {
    await act(async () => {
      root.render(<App />);
    });
    const input = container.querySelector(
      'input[placeholder="ABCD-EFGH"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("ABCD-EFGH");
    expect(container.textContent).toContain(
      "Deep-link user code ABCD-EFGH — review and approve",
    );
    expect(container.textContent).toContain("Deep-link claim id");
    expect(container.textContent).toContain("clm_9");
    expect(container.querySelector("section.priority")).not.toBeNull();
  });
});
