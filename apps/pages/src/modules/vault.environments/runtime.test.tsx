import { readCommand } from "@opensesame/app-core/lib/command-bar/parse.js";
/** @vitest-environment jsdom */
import {
  commandPathAuthorized,
  commandSections,
} from "@opensesame/app-core/lib/command-bar/types.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { ENVIRONMENT_NOTICE_ID } from "@opensesame/app-core/lib/vault/environments-notices.js";
import { ENVIRONMENTS_PATH } from "@opensesame/app-core/lib/vault/environments.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  NO_SIDE_EFFECTS,
  activateForTest,
  expectLifecycle,
  importUnderSpies,
  runtimeOf,
} from "../runtime-test-kit.js";
import { createTestContext } from "../test-context.js";
import { closeVault, openVaultWith } from "./environments.test-support.js";
import type * as Runtime from "./runtime.js";

let runtime: typeof Runtime;

function Where() {
  const { pathname, search } = useLocation();
  return <>{`${pathname}${search}`}</>;
}

afterEach(async () => {
  cleanup();
  clearNotices();
  await closeVault();
});

async function setUpRequired(): Promise<void> {
  const [token] = await openVaultWith("Stripe key");
  if (!token) throw new Error("no item");
  await vaultStore.editEnvironments({
    op: "add-environment",
    name: "production",
  });
  await vaultStore.editEnvironments({ op: "add-key", itemId: token.id });
  await vaultStore.editEnvironments({
    op: "set-cell",
    itemId: token.id,
    environment: "production",
    cell: { required: true },
  });
}

describe("vault.environments runtime", () => {
  it("imports with no fetch, timer, DOM or storage side effect", async () => {
    const loaded = await importUnderSpies(() => import("./runtime.js"));
    runtime = loaded.module;
    expect(loaded.effects).toEqual(NO_SIDE_EFFECTS);
  });

  it("registers the vault key, the typed road and the notice job, and no settings panel", async () => {
    await expectLifecycle(runtimeOf(runtime), {
      capability: "vault.environments",
      kinds: ["background-job", "command-path", "route", "vault-command"],
      count: 4,
    });
  });

  it("answers /environments in the command bar, and lands on the vault's own address", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    expect(t.entries("command-path")).toEqual([
      { path: "/environments", label: "Environments" },
    ]);
    const [route] = t.entries("route");
    expect(route).toMatchObject({ path: "/environments", framed: false });
    render(
      <MemoryRouter initialEntries={["/environments"]}>
        {route ? <route.element /> : null}
        <output aria-label="address">
          <Where />
        </output>
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("address").textContent).toBe(
      ENVIRONMENTS_PATH,
    );
    await handle.dispose();
  });

  it("puts its key after Import and before Export", async () => {
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [command] = t.entries("vault-command");
    expect(command).toMatchObject({ id: "environments", order: 20 });
    expect(command?.Entry).toBeDefined();
    expect(t.entries("settings-panel")).toEqual([]);
    await handle.dispose();
  });

  it("is a destination the command bar and the navigation tool accept, only while the capability is approved", async () => {
    expect(commandPathAuthorized("/environments")).toBe(false);
    const revoke = await activateForTest(runtime, ["command-path"]);
    expect(readCommand("/environments")).toMatchObject({
      source: "parse",
      command: { action: "navigate", path: "/environments" },
    });
    expect(commandPathAuthorized("/environments")).toBe(true);
    expect(commandSections()).toContain("/environments");
    revoke();
    expect(commandSections()).not.toContain("/environments");
  });

  it("tells the tray about a missing required value for as long as the lease holds", async () => {
    await setUpRequired();
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [job] = t.entries("background-job");
    const lease = new AbortController();
    await act(async () => job?.start(lease.signal));
    expect(listNotices().map((notice) => notice.id)).toContain(
      ENVIRONMENT_NOTICE_ID,
    );
    expect(listNotices()[0]?.body).toBe("production: STRIPE_KEY");

    // The value arrives: the notice goes, with no panel open.
    const [token] = vaultStore.getSnapshot().items;
    await act(async () => {
      await vaultStore.editEnvironments({
        op: "set-cell",
        itemId: token?.id ?? "",
        environment: "production",
        cell: { value: "sk_live" },
      });
    });
    expect(listNotices()).toEqual([]);

    // Required again, then the capability is withdrawn: nothing is left.
    await act(async () => {
      await vaultStore.editEnvironments({
        op: "set-cell",
        itemId: token?.id ?? "",
        environment: "production",
        cell: { value: "" },
      });
    });
    expect(listNotices()).toHaveLength(1);
    lease.abort();
    expect(listNotices()).toEqual([]);
    await handle.dispose();
  });

  it("says nothing while the vault is locked, and again once it opens", async () => {
    await setUpRequired();
    const t = createTestContext();
    const handle = await runtime.capabilityRuntime.activate(t.ctx);
    const [job] = t.entries("background-job");
    const lease = new AbortController();
    await act(async () => job?.start(lease.signal));
    expect(listNotices()).toHaveLength(1);

    // Locking clears the tray, as the shell does.
    act(() => {
      vaultStore.lock();
      clearNotices();
    });
    expect(listNotices()).toEqual([]);
    await act(async () => {
      await vaultStore.unlock("correct horse battery staple");
    });
    expect(listNotices().map((notice) => notice.id)).toContain(
      ENVIRONMENT_NOTICE_ID,
    );
    lease.abort();
    await handle.dispose();
  });
});
