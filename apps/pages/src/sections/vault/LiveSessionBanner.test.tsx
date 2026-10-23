/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VaultShareProvider } from "../../components/vault-share-seat.js";
import { LiveSessionBanner } from "./LiveSessionBanner.js";

describe("live banner capability seat", () => {
  afterEach(cleanup);
  it("does not render or load live-session behavior without a provider", () => {
    const { container } = render(<LiveSessionBanner />);
    expect(container.childElementCount).toBe(0);
  });

  it("removes the provided status when the capability wrapper is withdrawn", () => {
    const share = {
      Button: () => null,
      Banner: () => <output>2 shared items</output>,
      open: () => {},
    };
    const { rerender } = render(
      <VaultShareProvider value={share}>
        <LiveSessionBanner />
      </VaultShareProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe("2 shared items");
    rerender(<LiveSessionBanner />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
