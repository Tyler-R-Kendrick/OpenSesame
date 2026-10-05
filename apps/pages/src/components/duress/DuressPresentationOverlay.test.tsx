/** @vitest-environment jsdom */
import {
  type ActivePresentation,
  clearActivePresentation,
  setActivePresentation,
} from "@opensesame/app-core/lib/duress/compartment/presentation-runtime.js";
import { projectScopedView } from "@opensesame/app-core/lib/duress/compartment/scope.js";
import {
  mintPresentationSession,
  openPresentation,
} from "@opensesame/app-core/lib/duress/compartment/session.js";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DuressPresentationOverlay } from "./DuressPresentationOverlay.js";

/** The outcome the unlock path really mints: no published decoy, so locked. */
async function lockedPresentation(
  presentation: "decoy" | "locked",
): Promise<ActivePresentation> {
  const session = await mintPresentationSession({
    presentation,
    profileId: "p",
    contextId: "duress:p:1",
    admittedKeys: [
      {
        compartmentRef: "compartment:p",
        keyEpoch: 1,
        rawKey: new Uint8Array(32).fill(3),
      },
    ],
  });
  const outcome = await openPresentation(session, null);
  return { profileId: "p", outcome, view: projectScopedView(outcome) };
}

afterEach(() => {
  cleanup();
  clearActivePresentation();
});

/** A decoy session must not draw presentation chrome of its own. */
describe("DuressPresentationOverlay", () => {
  it("draws nothing for a locked outcome, before or after it is set", async () => {
    const view = render(<DuressPresentationOverlay />);
    expect(view.container.textContent).toBe("");
    const active = await lockedPresentation("decoy");
    expect(active.outcome.kind).toBe("locked");
    act(() => setActivePresentation(active));
    expect(view.container.textContent).toBe("");
    expect(view.container.querySelector(".duress-presentation-overlay")).toBe(
      null,
    );
    expect(view.container.textContent).not.toMatch(
      /Unavailable|missing_decoy|Vault locked/,
    );
  });

  it("is also empty when a locked outcome is already active at mount", async () => {
    setActivePresentation(await lockedPresentation("locked"));
    const view = render(<DuressPresentationOverlay />);
    expect(view.container.textContent).toBe("");
  });
});
