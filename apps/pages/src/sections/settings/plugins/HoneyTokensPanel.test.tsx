/** @vitest-environment jsdom */
import { configureHost } from "@opensesame/app-core/host.js";
import { HONEY_TOKEN_KEY } from "@opensesame/app-core/lib/honey-tokens.js";
import { kvDelete } from "@opensesame/app-core/lib/kv.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { HoneyTokensPanel } from "./HoneyTokensPanel.js";

const original = { ...vaultHooksSeams };
beforeEach(() => {
  configureHost(createTestHost());
  Object.assign(vaultHooksSeams, {
    useVaultStore: () => ({ activeTomb: () => "personal" }),
  });
});
afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, original);
  kvDelete(HONEY_TOKEN_KEY);
  vi.restoreAllMocks();
});

describe("HoneyTokensPanel", () => {
  it("issues and revokes a token, and shows the public id status", async () => {
    render(<HoneyTokensPanel notices={[]} />);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "CI decoy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Issue token" }));
    expect(await screen.findByText("CI decoy")).toBeTruthy();
    expect(screen.getByLabelText("Active")).toBeTruthy();
    expect(screen.getByText(/^osr_hny_/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke CI decoy" }));
    expect(await screen.findByLabelText("Revoked")).toBeTruthy();
  });

  it("turns a matching proxy notice into Triggered", async () => {
    render(<HoneyTokensPanel notices={[]} />);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "CI decoy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Issue token" }));
    const id = (await screen.findByText(/^osr_hny_/u)).textContent?.slice(
      8,
      40,
    );
    if (!id) throw new Error("token id missing");
    render(
      <HoneyTokensPanel
        notices={[
          {
            event: "surrogate.honey_token",
            at: "2026-10-22T10:00:00.000Z",
            subject: id,
          },
        ]}
      />,
    );
    expect(
      (await screen.findAllByLabelText("Triggered")).length,
    ).toBeGreaterThan(0);
  });
});
