/** @vitest-environment jsdom */
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { saveModelFixture } from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../../bindings/identity.js";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { ConnectPanels } from "./ConnectPanels.js";
import { activateNativePanelRuntime } from "./connect-panels.test-support.js";

Object.assign(identityHookSeams, {
  useIdentitySession: () => ({ principalId: "prn_person" }),
});
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: [], tomb: "", status: "locked" }),
});

let runtime: Awaited<ReturnType<typeof activateNativePanelRuntime>>;

function provider(id: string): Provider {
  const found = mergeVercelCatalog(getBundledProviders()).find(
    (row) => row.id === id,
  );
  if (!found) throw new Error(`${id} not in catalog`);
  return found;
}

beforeEach(async () => {
  runtime = await activateNativePanelRuntime();
});

afterEach(() => {
  cleanup();
  runtime.activation.dispose();
});

it("keeps a generic native Linear connection on the shared completion page", async () => {
  const id = await saveModelFixture("linear");
  const connection = deviceConnection(id);
  if (!connection) throw new Error("Expected a native Linear connection");
  render(
    <ConnectPanels
      provider={provider("linear")}
      connection={connection}
      online
      onFlash={vi.fn()}
      onChanged={vi.fn()}
    />,
    { wrapper: MemoryRouter },
  );
  expect(
    await screen.findByRole("heading", { name: /Complete$/ }),
  ).toBeTruthy();
  expect(
    screen.getByRole("group", { name: "Linear configuration" }),
  ).toBeTruthy();
  expect(screen.queryByText("Linear saved connection actions")).toBeNull();
});
