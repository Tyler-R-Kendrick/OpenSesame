import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

/**
 * What the app does with a link before it does anything else.
 *
 * The old surface had no fragment discipline at all — no `history.replaceState`
 * anywhere in it — while the ceremonies app scrubbed before every call. These
 * are the tests that keep the two from diverging again.
 */

overlapCast(globalThis).IS_REACT_ACT_ENVIRONMENT = true;

const REF = "i_AbCdEfGhIjKlMnOpQr.0123456789abcdef";

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonRes(status: number, body: BoundaryValue): Response {
  return overlapCast({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

async function renderApp() {
  await act(async () => {
    root.render(<App />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("fragment hygiene", () => {
  it("scrubs the fragment before the first request goes out", async () => {
    const hashAtFirstCall: string[] = [];
    fetchMock.mockImplementation(() => {
      hashAtFirstCall.push(window.location.hash);
      return Promise.resolve(
        jsonRes(200, {
          kind: "device_authorization",
          status: "pending",
          expiresAt: "2026-09-01T00:00:00.000Z",
          requiresApprover: true,
        }),
      );
    });
    window.history.replaceState(null, "", `/i/${REF}#state=abc`);
    await renderApp();

    expect(hashAtFirstCall[0]).toBe("");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe(`/i/${REF}`);
    // The reference survives the scrub, so the interaction still resolves.
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:8788/i/${REF}`);
  });

  it("refuses a link whose fragment carried a bearer, and calls nothing", async () => {
    window.history.replaceState(null, "", `/i/${REF}#token=leaked`);
    await renderApp();

    expect(window.location.hash).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-outcome]")?.getAttribute("data-outcome"),
    ).toBe("refused");
    expect(container.textContent).toContain("carried credential material");
  });
});

describe("forbidden parameters", () => {
  it("refuses a link carrying ?token= rather than parsing around it", async () => {
    window.history.replaceState(null, "", "/?token=leaked&user_code=ABCD-EFGH");
    await renderApp();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-outcome]")?.getAttribute("data-outcome"),
    ).toBe("refused");
    // The user code rode on the same link and is not offered as a fallback:
    // acting on any part of a link that should not exist is the problem.
    expect(container.querySelector("#user-code")).toBeNull();
    expect(container.textContent).not.toContain("ABCD-EFGH");
  });

  it("names nothing in the refusal", async () => {
    window.history.replaceState(null, "", "/?access_token=leaked");
    await renderApp();
    // The offending value must not reach a screen, a log, or a screenshot —
    // which is exactly what a message quoting it would do.
    expect(container.textContent).not.toContain("leaked");
    expect(container.textContent).not.toContain("access_token");
  });
});
