/** @vitest-environment jsdom */
import {
  type VaultStatus,
  vaultStore,
} from "@opensesame/app-core/lib/vault/store.js";
import { webmcpSupportSeam } from "@opensesame/app-core/webmcp/tools.js";
import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { mount, resetSupport } from "./support-test-harness.js";

/**
 * The WebMCP guidance tools (`opensesame_open_support`, `_start_guide`) call
 * through `webmcpSupportSeam`, which the support provider binds only while the
 * vault is unlocked — no help on the title or unlock screens (ed1d403d).
 * Split out of `support.test.tsx`, which sits at its module-size budget
 * (ADR 0093).
 */

const originalUseVault = vaultHooksSeams.useVault;

function vaultIs(status: VaultStatus): void {
  vaultHooksSeams.useVault = () => ({ ...vaultStore.getSnapshot(), status });
}

afterEach(() => {
  resetSupport();
  vaultHooksSeams.useVault = originalUseVault;
});

describe("support panel", () => {
  it("binds the WebMCP guidance tools to this panel", async () => {
    const unbound = webmcpSupportSeam.openSupport;

    // Locked: the tools stay on their no-op default and open nothing.
    vaultIs("locked");
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    expect(webmcpSupportSeam.openSupport).toBe(unbound);
    cleanup();

    // Unlocked: the tool opens this panel on the authored topic it named.
    vaultIs("unlocked");
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    expect(webmcpSupportSeam.openSupport).not.toBe(unbound);
    webmcpSupportSeam.openSupport("help.lock");

    expect(await screen.findByRole("dialog", { name: "Support" })).toBeTruthy();
    expect(
      await screen.findByText(/Locking drops the vault keys held in memory/),
    ).toBeTruthy();
  });

  it("gives the tools back when the panel unmounts", () => {
    const unbound = webmcpSupportSeam.openSupport;
    vaultIs("unlocked");
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    expect(webmcpSupportSeam.openSupport).not.toBe(unbound);
    cleanup();
    expect(webmcpSupportSeam.openSupport).toBe(unbound);
  });
});
