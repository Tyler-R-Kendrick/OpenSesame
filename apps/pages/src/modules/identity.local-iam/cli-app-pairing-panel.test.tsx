import { configureHost } from "@opensesame/app-core/host.js";
import { clearCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/** @vitest-environment jsdom */
import pairingSpec from "../../../../../spec/conformance/cli-app-integration-pairing.json" with {
  type: "json",
};
import { CliAppPairingPanel } from "./cli-app-pairing-panel.js";

describe("CliAppPairingPanel", () => {
  const priorFetch = globalThis.fetch;
  const priorHost = window.location.hostname;

  beforeEach(() => {
    configureHost(createTestHost());
    vi.stubGlobal("location", { ...window.location, hostname: "localhost" });
    clearCliAppIntegrationBearer();
  });

  afterEach(() => {
    globalThis.fetch = priorFetch;
    vi.stubGlobal("location", { ...window.location, hostname: priorHost });
    cleanup();
  });

  it("pairs with a pasted code on loopback", async () => {
    const token = "B".repeat(43);
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ token }), { status: 201 });
    };

    render(<CliAppPairingPanel />);
    fireEvent.change(screen.getByLabelText("Pairing code"), {
      target: { value: pairingSpec.localExample.text },
    });
    fireEvent.click(screen.getByRole("button", { name: PAIR_LABEL }));

    await waitFor(() =>
      expect(
        screen.getByRole("img", {
          name: "Paired for CLI integration on this browser.",
        }),
      ).toBeTruthy(),
    );
    expect(calls).toBe(2);
  });

  it("is absent off loopback", () => {
    vi.stubGlobal("location", { ...window.location, hostname: "example.com" });
    const { container } = render(<CliAppPairingPanel />);
    expect(container.textContent).toBe("");
  });
});

const PAIR_LABEL = "Pair with the daemon";
