import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
/** @vitest-environment jsdom */
import { nativeMcpClassification } from "@opensesame/app-core/lib/native-mcp-profile.js";
import { nativeOAuthGuard } from "@opensesame/app-core/lib/native-oauth-session.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { NativeMcpTools } from "./NativeMcpTools.js";
import { installConnectorIntegration } from "./native-connector-integration.test-support.js";
import {
  discoveryFixture,
  within,
} from "./native-mcp-discover-owner.test-support.js";
installConnectorIntegration();
function props(actual: Awaited<ReturnType<typeof discoveryFixture>>["actual"]) {
  return {
    view: actual.view,
    controller: actual.controller,
    onFlash: vi.fn(),
    onChanged: vi.fn(),
  };
}
async function rename(id: string) {
  const record = loadNativeConnectorRecord(id);
  if (!record) throw new Error("Missing actual sealed connector row.");
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    nativeMcpClassification(record.configuration),
    (current) => {
      current.configuration.displayName = "New committed owner";
      return current;
    },
  );
  const view = readNativeConnector(id);
  if (!view) throw new Error("Missing replacement actual row.");
  return view;
}
it.each(["unmount", "disabled", "controller", "revision", "lock", "cold-row"])(
  "withdraws held actual MCP discovery on %s with physical TLS close before two seconds and no late callback",
  async (reason) => {
    const wire = await discoveryFixture();
    const actual = wire.actual;
    const initial = props(actual);
    const invoke = vi.spyOn(actual.controller, "invoke");
    const mounted = render(<NativeMcpTools {...initial} />);
    try {
      await userEvent.click(
        screen.getByRole("button", { name: "Discover MCP tools" }),
      );
      await within(wire.state.entered.promise);
      const caller = invoke.mock.calls[0]?.[2];
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(wire.state.physicallyClosed).toBe(false);
      const start = performance.now();
      if (reason === "unmount") mounted.unmount();
      if (reason === "disabled")
        mounted.rerender(<NativeMcpTools {...initial} disabled />);
      if (reason === "controller")
        mounted.rerender(
          <NativeMcpTools {...initial} controller={{ ...actual.controller }} />,
        );
      if (reason === "revision") {
        const view = await rename(actual.view.connectionId);
        expect(view.revision).toBeGreaterThan(actual.view.revision);
        mounted.rerender(<NativeMcpTools {...initial} view={view} />);
      }
      if (reason === "lock")
        await act(async () => vaultStore.lock({ recordLastVault: false }));
      if (reason === "cold-row") {
        await actual.fixture.reload();
        const view = actual.controller.load();
        if (!view)
          throw new Error("Missing cold restored actual connection row.");
        mounted.rerender(
          <NativeMcpTools
            {...initial}
            view={view}
            controller={{ ...actual.controller }}
          />,
        );
      }
      await within(wire.state.closed.promise);
      expect(performance.now() - start).toBeLessThan(2000);
      expect(invoke).toHaveBeenCalledWith(
        "mcp.tools.list",
        {},
        expect.any(AbortSignal),
      );
      expect(caller?.aborted).toBe(true);
      await act(async () => {
        wire.release();
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(initial.onChanged).not.toHaveBeenCalled();
      expect(initial.onFlash).not.toHaveBeenCalled();
      expect(screen.queryByText(/Owned discovery server ·/)).toBeNull();
      expect(wire.state.errors).toEqual([]);
    } finally {
      cleanup();
      await wire.close();
    }
  },
);
it("consumes actual advertised discovery after a held response and refreshes only its live owner", async () => {
  const wire = await discoveryFixture();
  const initial = props(wire.actual);
  render(<NativeMcpTools {...initial} />);
  try {
    await userEvent.click(
      screen.getByRole("button", { name: "Discover MCP tools" }),
    );
    await within(wire.state.entered.promise);
    await act(async () => wire.release());
    await screen.findByText("Owned discovery server · 1 tools");
    expect(
      screen.getByText("provider.search: Search owned discovery records", {
        selector: "summary",
      }),
    ).toBeTruthy();
    expect(initial.onChanged).toHaveBeenCalledTimes(1);
    expect(initial.onFlash).not.toHaveBeenCalled();
    expect(wire.state.methods).toContain("initialize");
    expect(wire.state.methods).toContain("tools/list");
  } finally {
    cleanup();
    await wire.close();
  }
});
it.each([401, 500])(
  "keeps active provider HTTP%s errors visible and refreshes the active connection",
  async (status) => {
    const wire = await discoveryFixture();
    wire.state.status = status;
    wire.state.hold = false;
    const initial = props(wire.actual);
    render(<NativeMcpTools {...initial} />);
    try {
      await userEvent.click(
        screen.getByRole("button", { name: "Discover MCP tools" }),
      );
      await waitFor(() => expect(initial.onFlash).toHaveBeenCalledTimes(1));
      expect(initial.onFlash.mock.calls[0]?.[0].tone).toBe("err");
      expect(initial.onChanged).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/Owned discovery server ·/)).toBeNull();
    } finally {
      cleanup();
      await wire.close();
    }
  },
);
