import { cleanup, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedPanel } from "./ConnectedPanel.js";

/**
 * What the Connected panel says when it has nothing to say.
 *
 * A unit test rather than a walk through the whole section, because the answer
 * is decided entirely by props: with no Host configured the section never asks
 * for connections, so `connections` stays null with `loading` false — the state
 * that used to render "Connections could not be read.", a report of a failure
 * that never happened (ADR 0090 §7).
 */

function renderPanel(over: { hostConfigured: boolean; loading?: boolean }) {
  return render(
    <MemoryRouter>
      <ConnectedPanel
        connections={null}
        providers={[]}
        loading={over.loading ?? false}
        online
        onFlash={vi.fn()}
        onChanged={vi.fn()}
        onRememberOffer={vi.fn()}
        setupRequired={false}
        hostConfigured={over.hostConfigured}
      />
    </MemoryRouter>,
  );
}

describe("ConnectedPanel with no Host", () => {
  afterEach(cleanup);

  it("says what a Host would hold rather than that a read failed", () => {
    renderPanel({ hostConfigured: false });
    expect(screen.getByText("No Host connected")).toBeTruthy();
    expect(screen.queryByText("Connections could not be read.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // The road out is named, not demanded.
    expect(
      screen.getByRole("link", { name: "Settings → Connectivity" }),
    ).toBeTruthy();
  });

  it("still reports a real read failure where a Host was asked", () => {
    // With a Host configured, a null list after loading finished IS a failed
    // read, and the panel must keep saying so.
    renderPanel({ hostConfigured: true });
    expect(screen.getByText("Connections could not be read.")).toBeTruthy();
    expect(screen.queryByText("No Host connected")).toBeNull();
  });

  it("says it is still reading while a configured Host is being asked", () => {
    renderPanel({ hostConfigured: true, loading: true });
    expect(screen.getByText("Reading connections…")).toBeTruthy();
  });
});
