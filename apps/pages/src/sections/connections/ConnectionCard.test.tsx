import { cleanup, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inTray } from "../../components/tray.test-support.js";
import { ConnectionCard } from "./ConnectionCard.js";
import { makeConnection } from "./section-fixtures.test-support.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

declareConnectionsTutorial();

afterEach(cleanup);

function mount(overrides: Parameters<typeof makeConnection>[0]) {
  render(
    <MemoryRouter>
      <ul>
        <ConnectionCard
          connection={makeConnection({ providerId: "slack", ...overrides })}
          provider={null}
          online
          onFlash={vi.fn()}
          onChanged={vi.fn()}
        />
      </ul>
    </MemoryRouter>,
  );
}

describe("ConnectionCard status sentence", () => {
  it("keeps a healthy sentence in the card", () => {
    mount({ status: "active" });
    expect(screen.getByText(/Authorized as octocat/)).toBeTruthy();
  });

  it.each([
    ["needs_reauth", "Renewal refused by the provider. Authorize it again."],
    ["error", "The provider returned an error."],
  ] as const)(
    "keeps the %s sentence, and its way out, on the row beside its mark",
    (status, detail) => {
      mount({ status, statusDetail: detail });
      expect(screen.getByText(detail)).toBeTruthy();
      expect(inTray(detail)).toBe(false);
    },
  );

  it("keeps the expired sentence on the row", () => {
    mount({ status: "expired", refreshable: false });
    expect(screen.getByText(/access token expired/)).toBeTruthy();
    expect(inTray(/access token expired/)).toBe(false);
  });
});
