/** @vitest-environment jsdom */
/** Real composition/receipt/activation queue/registry/command; controlled module I/O. */
import {
  bootPersonalLocal,
  draftFor,
  freshRealm,
} from "@opensesame/app-core/lib/capabilities/__tests__/harness.js";
import {
  activatePlan,
  activatedGeneration,
} from "@opensesame/app-core/lib/capabilities/change.js";
import { deriveLease } from "@opensesame/app-core/lib/capabilities/lease.js";
import { loaderSeams } from "@opensesame/app-core/lib/capabilities/loader.js";
import {
  bindLeaseToCapability,
  registerContribution,
} from "@opensesame/app-core/lib/capabilities/registry.js";
import type { ApprovedCapabilityContext } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { executeCommand } from "@opensesame/app-core/lib/command-bar/execute.js";
import { readCommand } from "@opensesame/app-core/lib/command-bar/parse.js";
import { commandPathAuthorized } from "@opensesame/app-core/lib/command-bar/types.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useContributions } from "../bindings/contributions.js";
import { shellReadySeams } from "../bindings/shell-ready.js";
import { useRenewingShellWrappers } from "../bindings/shell-wrappers.js";
import {
  closeGenuineRuntimeFixture,
  genuineRuntimeFixture,
} from "../modules/connectors.external/genuine-runtime.test-support.js";
import { SupportShell } from "../modules/support.guided-help/SupportShell.js";
import { CommandBar } from "./CommandBar.js";
import { Wrapped } from "./ShellWrappers.js";

const maxWaitMs = shellReadySeams.maxWaitMs;
let stop = () => {};
let coreWait: Promise<void> | null = null;
const releases: (() => void)[] = [];
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}
function WithdrawableWrapper({ children }: { children?: ReactNode }) {
  return <section aria-label="Optional wrapper">{children}</section>;
}
function Draft() {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label="Held settings draft"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}
function Shell() {
  const current = useContributions("shell-wrapper");
  const wrappers = useRenewingShellWrappers(current);
  const location = useLocation();
  return (
    <Wrapped wrappers={wrappers}>
      <CommandBar />
      <Draft />
      <output aria-label="Current route">{location.pathname}</output>
    </Wrapped>
  );
}
async function ready() {
  await waitFor(() =>
    expect(activatedGeneration()).toBe(
      compositionStore.getSnapshot().generation,
    ),
  );
}
async function select(roots: readonly string[], revision: string) {
  const { draft, receipt } = draftFor(compositionStore, roots, revision);
  await act(async () => {
    expect((await compositionStore.commit(draft, receipt)).status).toBe(
      "committed",
    );
  });
}
function command() {
  return screen.getByRole("combobox", { name: "Command" });
}
function runButton() {
  return screen.getByRole("button", { name: "Run command" });
}
function submit() {
  const form = command().closest("form");
  if (form === null) throw new Error("command has no form");
  fireEvent.submit(form);
}
function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/settings/features"]}>
      <Shell />
    </MemoryRouter>,
  );
}
beforeEach(async () => {
  freshRealm();
  await genuineRuntimeFixture();
  await bootPersonalLocal(compositionStore, vaultStore.getSnapshot().tomb);
  loaderSeams.moduleTable = async () => ({
    "vault.passwords/runtime": async () => ({
      capabilityRuntime: {
        capability: "vault.passwords",
        async activate(ctx: ApprovedCapabilityContext) {
          if (coreWait !== null) await coreWait;
          const registration = ctx.register("shell-wrapper", {
            id: "support",
            Wrapper: SupportShell,
            order: 10,
          });
          return {
            capability: "vault.passwords",
            dispose: () => registration.revoke(),
          };
        },
      },
    }),
    "connectors.external/runtime": () =>
      import("../modules/connectors.external/runtime.js"),
  });
  stop = activatePlan(compositionStore);
  await ready();
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  coreWait = null;
  cleanup();
  stop();
  await closeGenuineRuntimeFixture();
  freshRealm();
  shellReadySeams.maxWaitMs = maxWaitMs;
  vi.restoreAllMocks();
});
it("preserves actual command and settings drafts while the genuine feature queue renews wrappers, then admits the registered command", async () => {
  renderShell();
  fireEvent.change(command(), { target: { value: "connections" } });
  fireEvent.change(screen.getByLabelText("Held settings draft"), {
    target: { value: "unsaved endpoint" },
  });
  const hydrate = deferred();
  vi.spyOn(loaderSeams, "hydrate").mockImplementationOnce(
    () => hydrate.promise,
  );
  await select(["connectors.external"], "enable-connectors-real-queue");
  await waitFor(() => expect(loaderSeams.hydrate).toHaveBeenCalled());
  expect(commandPathAuthorized("/connections")).toBe(false);
  expect(command()).toHaveProperty("value", "connections");
  expect(screen.getByLabelText("Held settings draft")).toHaveProperty(
    "value",
    "unsaved endpoint",
  );
  expect(runButton()).toHaveProperty("disabled", true);
  submit();
  expect(screen.getByLabelText("Current route").textContent).toBe(
    "/settings/features",
  );
  hydrate.release();
  await ready();
  expect(runButton()).toHaveProperty("disabled", false);
  expect(command()).toHaveProperty("value", "connections");
  fireEvent.click(runButton());
  await waitFor(() =>
    expect(screen.getByLabelText("Current route").textContent).toBe(
      "/connections",
    ),
  );
  expect(screen.getByLabelText("Held settings draft")).toHaveProperty(
    "value",
    "unsaved endpoint",
  );
});
it("does not execute a late interpretation under a successor generation even when that successor now authorizes its destination", async () => {
  const interpreted = deferred();
  const child = deriveLease(compositionStore.currentLease());
  bindLeaseToCapability(child.lease, "vault.passwords");
  const handle = registerContribution(
    "command-assist",
    {
      id: "held-interpretation",
      order: 0,
      interpret: async () => {
        await interpreted.promise;
        return readCommand("connections");
      },
    },
    child.lease,
  );
  renderShell();
  fireEvent.change(command(), { target: { value: "connections" } });
  fireEvent.click(runButton());
  expect(runButton()).toHaveProperty("disabled", true);
  await select(["connectors.external"], "successor-authorizes-connections");
  await ready();
  expect(commandPathAuthorized("/connections")).toBe(true);
  await act(async () => {
    interpreted.release();
  });
  await waitFor(() => expect(runButton()).toHaveProperty("disabled", false));
  expect(screen.getByLabelText("Current route").textContent).toBe(
    "/settings/features",
  );
  expect(command()).toHaveProperty("value", "connections");
  fireEvent.click(runButton());
  await waitFor(() =>
    expect(screen.getByLabelText("Current route").textContent).toBe(
      "/connections",
    ),
  );
  handle.revoke();
});
it("bounds presentation retention and leaves core drafts accessible when an activation stalls", async () => {
  shellReadySeams.maxWaitMs = 20;
  renderShell();
  fireEvent.change(screen.getByLabelText("Held settings draft"), {
    target: { value: "old visual frame" },
  });
  const gate = deferred();
  coreWait = gate.promise;
  await select(["connectors.external"], "stalled-core-renewal");
  await waitFor(() =>
    expect(screen.getByLabelText("Held settings draft")).toHaveProperty(
      "value",
      "",
    ),
  );
  expect(runButton()).toHaveProperty("disabled", true);
  gate.release();
  await ready();
});
it("keeps command authority refused immediately when connectors are withdrawn", async () => {
  await select(["connectors.external"], "enable-for-withdrawal");
  await ready();
  const child = deriveLease(compositionStore.currentLease());
  bindLeaseToCapability(child.lease, "connectors.external");
  const registration = registerContribution(
    "shell-wrapper",
    {
      id: "withdrawable",
      Wrapper: WithdrawableWrapper,
      order: 20,
    },
    child.lease,
  );
  renderShell();
  expect(screen.getByRole("region", { name: "Optional wrapper" })).toBeTruthy();
  const navigate = vi.fn();
  await select([], "withdraw-connectors");
  expect(screen.queryByRole("region", { name: "Optional wrapper" })).toBeNull();
  const result = await executeCommand(
    { action: "navigate", path: "/connections" },
    {
      navigate,
      copy: async () => "unavailable",
      items: () => [],
      vaultLocked: () => false,
    },
  );
  expect(result.ok).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  await ready();
  registration.revoke();
});
