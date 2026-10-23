/** @vitest-environment jsdom */
import {
  bootPersonalLocal,
  draftFor,
  freshRealm,
} from "@opensesame/app-core/lib/capabilities/__tests__/harness.js";
import {
  activatePlan,
  activatedGeneration,
} from "@opensesame/app-core/lib/capabilities/change.js";
import { loaderSeams } from "@opensesame/app-core/lib/capabilities/loader.js";
import { contributions } from "@opensesame/app-core/lib/capabilities/registry.js";
import type {
  CapabilityModule,
  CommandAssistContribution,
} from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  compositionStore,
  storeSeams,
} from "@opensesame/app-core/lib/capabilities/store.js";
import { readCommand } from "@opensesame/app-core/lib/command-bar/parse.js";
import type { InterpretResult } from "@opensesame/app-core/lib/command-bar/types.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { kvSeams } from "@opensesame/app-core/lib/kv.js";
import { createItem } from "@opensesame/vault-core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { CommandBar } from "./CommandBar.js";

const CAPABILITY = "vault.passkey-records";
const originalVault = { ...vaultHooksSeams };
const originalLoader = { ...loaderSeams };
const originalStore = { ...storeSeams };
const originalKv = { ...kvSeams };
const copy = vi.fn<(value: string) => Promise<"copied">>();
let stopActivation: (() => void) | null = null;
let releasePending: Array<() => void> = [];

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred promise not initialized");
  };
  const wait = new Promise<T>((done) => {
    resolve = done;
  });
  return { wait, resolve };
}

function gate() {
  const pending = deferred<void>();
  const open = () => pending.resolve(undefined);
  releasePending.push(open);
  return { wait: pending.wait, open };
}

type Gate = ReturnType<typeof gate>;
type ActivationControl = { held: Gate | null; entered: Gate };

async function activateFixture(
  interpret: CommandAssistContribution["interpret"],
) {
  await bootPersonalLocal(compositionStore, "personal");
  const { draft, receipt } = draftFor(compositionStore, [CAPABILITY], "r1");
  const outcome = await compositionStore.commit(draft, receipt);
  expect(outcome.status).toBe("committed");
  expect(capabilityPorts.compositionStore).toBe(compositionStore);
  const control: ActivationControl = {
    held: null,
    entered: gate(),
  };
  const module: CapabilityModule = {
    capabilityRuntime: {
      capability: CAPABILITY,
      async activate(ctx) {
        const { held, entered } = control;
        entered.open();
        await held?.wait;
        ctx.register("command-path", {
          path: "/connections",
          label: "Connections",
        });
        ctx.register("command-assist", {
          id: "leased-test-interpreter",
          order: 0,
          interpret,
        });
        return { capability: CAPABILITY, dispose: () => {} };
      },
    },
  };
  loaderSeams.moduleTable = async () => ({
    [`${CAPABILITY}/runtime`]: async () => module,
  });
  stopActivation = activatePlan(compositionStore);
  await control.entered.wait;
  await waitFor(() =>
    expect(activatedGeneration()).toBe(
      compositionStore.getSnapshot().generation,
    ),
  );
  return control;
}

function Location() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderBar() {
  const item = createItem("account", "Mailbox");
  if (item.kind !== "account") throw new Error("expected an account fixture");
  item.username = "alice@example.test";
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ items: [item], status: "unlocked" }),
    useCopySecret: () => copy,
  });
  render(
    <MemoryRouter initialEntries={["/vault"]}>
      <CommandBar />
      <Location />
    </MemoryRouter>,
  );
  return screen.getByRole<HTMLInputElement>("combobox", { name: "Command" });
}

beforeEach(() => {
  freshRealm();
  copy.mockReset();
  copy.mockResolvedValue("copied");
});

afterEach(async () => {
  await act(async () => {
    cleanup();
    for (const release of releasePending) release();
    releasePending = [];
    stopActivation?.();
    stopActivation = null;
    compositionStore.resetForTest();
  });
  Object.assign(vaultHooksSeams, originalVault);
  Object.assign(loaderSeams, originalLoader);
  Object.assign(storeSeams, originalStore);
  Object.assign(kvSeams, originalKv);
});

describe("CommandBar activation ownership", () => {
  it("holds dispatch until the real activation pass completes", async () => {
    const interpret = vi.fn(async (text: string) => readCommand(text));
    const control = await activateFixture(interpret);
    const field = renderBar();
    const user = userEvent.setup();
    await user.type(field, "go to connections");
    control.held = gate();
    control.entered = gate();
    await act(async () => {
      compositionStore.invalidate("feature-activation-pending");
      await control.entered.wait;
    });
    expect(activatedGeneration()).not.toBe(
      compositionStore.getSnapshot().generation,
    );
    expect(contributions("command-path")).toEqual([]);
    expect(field).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Run command" })).toHaveProperty(
      "disabled",
      true,
    );
    if (field.form === null) throw new Error("command form missing");
    fireEvent.submit(field.form);
    expect(interpret).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(screen.getByTestId("where").textContent).toBe("/vault");
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => {
      control.held?.open();
    });
    await waitFor(() => expect(field).toHaveProperty("disabled", false));
    await user.click(screen.getByRole("button", { name: "Run command" }));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/connections"),
    );
    expect(interpret).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toBe("Opened /connections");
  });

  it.each([
    ["navigation", "renewal"],
    ["copy", "renewal"],
    ["navigation", "revocation"],
    ["copy", "revocation"],
  ] as const)("drops held %s after real lease %s", async (effect, change) => {
    const held = deferred<InterpretResult>();
    const entered = gate();
    const result: InterpretResult =
      effect === "navigation"
        ? {
            source: "model",
            command: { action: "navigate", path: "/settings" },
          }
        : {
            source: "model",
            command: {
              action: "copy_field",
              query: "Mailbox",
              field: "username",
            },
          };
    releasePending.push(() => held.resolve(result));
    const interpret = vi.fn(async () => {
      entered.open();
      return held.wait;
    });
    await activateFixture(interpret);
    const field = renderBar();
    const user = userEvent.setup();
    await user.type(field, "held command");
    await user.click(screen.getByRole("button", { name: "Run command" }));
    await entered.wait;
    expect(interpret).toHaveBeenCalledOnce();
    const lease = compositionStore.currentLease();
    await act(async () => {
      if (change === "renewal") {
        compositionStore.invalidate("renewed-command-owner");
      } else {
        const disabled = await compositionStore.emergencyDisable(CAPABILITY);
        expect(disabled.blockedNow).toBe(true);
      }
    });
    expect(lease.signal.aborted).toBe(true);
    await waitFor(() =>
      expect(activatedGeneration()).toBe(
        compositionStore.getSnapshot().generation,
      ),
    );
    if (change === "revocation") {
      expect(contributions("command-assist")).toEqual([]);
    }
    await act(async () => {
      held.resolve(result);
      await held.wait;
    });
    await waitFor(() => expect(field).toHaveProperty("disabled", false));
    expect(screen.getByTestId("where").textContent).toBe("/vault");
    expect(copy).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(field).toHaveProperty("value", "held command");
  });
});
