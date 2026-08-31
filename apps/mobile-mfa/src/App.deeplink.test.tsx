import { overlapCast } from "@opensesame/os-domain";
/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "opensesame-mfa://approve?user_code=ABCD-EFGH&claim_id=clm_9"}
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

describe("App deep-link (opensesame-mfa://)", () => {
  it("reads the user code through the kit's legacy parser and leads with it", async () => {
    await act(async () => {
      root.render(<App />);
    });
    const input: HTMLInputElement = overlapCast(
      container.querySelector("#user-code"),
    );
    expect(input.value).toBe("ABCD-EFGH");
    // The approval is the screen: it owns the h1, and enrolment is folded away.
    expect(
      [...container.querySelectorAll("h1")].map((h) => h.textContent),
    ).toEqual(["Approve this device"]);
    expect(container.querySelector("details.disclosure")).not.toBeNull();
  });

  it("shows a claim id as a dead end rather than acting on it", async () => {
    await act(async () => {
      root.render(<App />);
    });
    // ADR 0009: approving a device says a session may exist. It never says a
    // principal now owns something, so a claim id on the link goes elsewhere.
    expect(container.textContent).toContain("clm_9");
    expect(container.textContent).toContain("is not settled here");
  });
});
