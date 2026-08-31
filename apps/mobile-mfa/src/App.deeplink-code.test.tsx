import { overlapCast } from "@opensesame/os-domain";
/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "http://localhost:3000/?code=wxyz-1234&claim_id=clm_2"}
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

describe("App deep-link (?code= alias)", () => {
  it("accepts the alias and normalizes the code, as the kit does", async () => {
    await act(async () => {
      root.render(<App />);
    });
    const input: HTMLInputElement = overlapCast(
      container.querySelector("#user-code"),
    );
    // `?code=` survives only as an adapter for links already printed
    // (`parseLegacyInteractionLink`), and the value is uppercased on the way
    // in — the app's own parser used to leave it exactly as typed, so the same
    // code arrived at the server in two spellings depending on the link.
    expect(input.value).toBe("WXYZ-1234");
    expect(container.textContent).toContain("clm_2");
  });
});
